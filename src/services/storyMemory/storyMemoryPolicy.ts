import type { Chapter } from '../../types/novel';
import { estimateTokens } from '../../utils/tokenEstimator';
import type {
  StoryMemoryDueDecision,
  StoryMemoryPolicy,
  StoryMemoryUpdateMode,
} from './storyMemoryTypes';

export const STORY_MEMORY_DEFAULT_INTERVAL = 3;
export const STORY_MEMORY_MIN_INTERVAL = 2;
export const STORY_MEMORY_MAX_INTERVAL = 10;
export const STORY_MEMORY_MAX_BATCH_SIZE = 10;
export const STORY_MEMORY_DEFAULT_PENDING_SOFT_LIMIT = 2400;

const VALID_MODES: StoryMemoryUpdateMode[] = [
  'smart',
  'fixed',
  'every_chapter',
  'manual',
];

export function clampIntervalChapters(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return STORY_MEMORY_DEFAULT_INTERVAL;
  return Math.min(
    STORY_MEMORY_MAX_INTERVAL,
    Math.max(STORY_MEMORY_MIN_INTERVAL, Math.round(n)),
  );
}

export function normalizeStoryMemoryMode(
  value: unknown,
): StoryMemoryUpdateMode {
  if (typeof value === 'string' && VALID_MODES.includes(value as StoryMemoryUpdateMode)) {
    return value as StoryMemoryUpdateMode;
  }
  return 'smart';
}

export function createDefaultStoryMemoryPolicy(
  projectId: number,
  options: Partial<StoryMemoryPolicy> = {},
): StoryMemoryPolicy {
  return {
    projectId,
    mode: normalizeStoryMemoryMode(options.mode),
    intervalChapters: clampIntervalChapters(
      options.intervalChapters ?? STORY_MEMORY_DEFAULT_INTERVAL,
    ),
    pendingTokenSoftLimit: Math.max(
      200,
      Math.round(
        options.pendingTokenSoftLimit ?? STORY_MEMORY_DEFAULT_PENDING_SOFT_LIMIT,
      ),
    ),
    updateOnKeyChapter: options.updateOnKeyChapter !== false,
    updatedAt: options.updatedAt || new Date().toISOString(),
  };
}

export function estimatePendingTokens(chapters: Chapter[]): number {
  return chapters.reduce(
    (sum, chapter) => sum + estimateTokens(chapter.content || ''),
    0,
  );
}

export function listPendingChapters(
  chapters: Chapter[],
  checkpointThroughPosition: number,
  currentPosition?: number,
): Chapter[] {
  const upper =
    typeof currentPosition === 'number'
      ? currentPosition
      : Number.MAX_SAFE_INTEGER;
  return chapters
    .filter(
      chapter =>
        chapter.position > checkpointThroughPosition &&
        chapter.position < upper &&
        Boolean(chapter.content?.trim()),
    )
    .sort((a, b) => a.position - b.position);
}

export function splitCheckpointBatches(chapters: Chapter[]): Chapter[][] {
  if (chapters.length === 0) return [];
  const batches: Chapter[][] = [];
  for (let i = 0; i < chapters.length; i += STORY_MEMORY_MAX_BATCH_SIZE) {
    batches.push(chapters.slice(i, i + STORY_MEMORY_MAX_BATCH_SIZE));
  }
  return batches;
}

export function evaluateStoryMemoryDue(input: {
  policy: StoryMemoryPolicy;
  checkpointThroughPosition: number;
  pendingChapters: Chapter[];
  hardDue?: boolean;
  isKeyChapter?: boolean;
  dirty?: boolean;
  manualRequested?: boolean;
}): StoryMemoryDueDecision {
  const pending = [...input.pendingChapters].sort(
    (a, b) => a.position - b.position,
  );
  const pendingCount = pending.length;
  const fromPosition =
    pendingCount > 0 ? pending[0].position : null;
  const throughPosition =
    pendingCount > 0 ? pending[pendingCount - 1].position : null;

  if (input.dirty) {
    return {
      due: true,
      hard: true,
      reason: 'dirty_rebuild',
      fromPosition,
      throughPosition,
    };
  }

  if (input.hardDue) {
    return {
      due: true,
      hard: true,
      reason: 'coverage_gap',
      fromPosition,
      throughPosition,
    };
  }

  if (input.manualRequested) {
    return {
      due: pendingCount > 0,
      hard: false,
      reason: pendingCount > 0 ? 'manual' : 'none',
      fromPosition,
      throughPosition,
    };
  }

  if (pendingCount === 0) {
    return {
      due: false,
      hard: false,
      reason: 'none',
      fromPosition: null,
      throughPosition: null,
    };
  }

  const policy = createDefaultStoryMemoryPolicy(input.policy.projectId, input.policy);
  const pendingTokens = estimatePendingTokens(pending);

  if (policy.mode === 'manual') {
    return {
      due: false,
      hard: false,
      reason: 'none',
      fromPosition,
      throughPosition,
    };
  }

  if (policy.mode === 'every_chapter') {
    return {
      due: true,
      hard: false,
      reason: 'interval_reached',
      fromPosition,
      throughPosition: pending[0].position,
    };
  }

  if (
    policy.updateOnKeyChapter &&
    input.isKeyChapter &&
    policy.mode === 'smart'
  ) {
    return {
      due: true,
      hard: false,
      reason: 'key_chapter',
      fromPosition,
      throughPosition,
    };
  }

  if (pendingCount >= policy.intervalChapters) {
    const limitedThrough =
      pending[
        Math.min(policy.intervalChapters, pending.length) - 1
      ].position;
    return {
      due: true,
      hard: false,
      reason: 'interval_reached',
      fromPosition,
      throughPosition: limitedThrough,
    };
  }

  if (
    policy.mode === 'smart' &&
    pendingTokens >= policy.pendingTokenSoftLimit
  ) {
    return {
      due: true,
      hard: false,
      reason: 'pending_token_limit',
      fromPosition,
      throughPosition,
    };
  }

  return {
    due: false,
    hard: false,
    reason: 'none',
    fromPosition,
    throughPosition,
  };
}

export function describeStoryMemoryPolicy(policy: StoryMemoryPolicy): string {
  const normalized = createDefaultStoryMemoryPolicy(policy.projectId, policy);
  switch (normalized.mode) {
    case 'smart':
      return `智能更新（通常每${normalized.intervalChapters}章）`;
    case 'fixed':
      return `固定间隔（每${normalized.intervalChapters}章）`;
    case 'every_chapter':
      return '每章更新';
    case 'manual':
      return '仅手动更新';
    default:
      return '智能更新';
  }
}

export function predictNextCheckpointPosition(
  policy: StoryMemoryPolicy,
  checkpointThroughPosition: number,
  pendingCount: number,
): number | null {
  const normalized = createDefaultStoryMemoryPolicy(policy.projectId, policy);
  if (normalized.mode === 'manual') return null;
  if (normalized.mode === 'every_chapter') {
    return checkpointThroughPosition + pendingCount + 1;
  }
  const remaining = Math.max(0, normalized.intervalChapters - pendingCount);
  return checkpointThroughPosition + pendingCount + remaining + 1;
}
