import type { Chapter, ContextConfig } from '../../types/novel';
import * as db from '../database';
import {
  createEmptyStoryMemoryCoveragePlan,
  planStoryMemoryCoverage,
} from './storyMemoryCoverage';
import {
  resolveUsableCheckpointForTarget,
  type CheckpointEligibilityResult,
} from './storyMemoryCheckpointEligibility';
import type { ProjectStoryMemoryRecord } from '../../data/repositories/storyMemoryRepository';
import type { StoryMemoryCoveragePlan } from './storyMemoryTypes';
import {
  createDefaultStoryMemoryPolicy,
  evaluateStoryMemoryDue,
  listPendingChapters,
} from './storyMemoryPolicy';
import {
  enqueueStoryMemoryMaintenance,
  type StoryMemoryMaintenanceReason,
} from './storyMemoryService';

/**
 * V2.5.14+ — carry the eligibility decision (reason + original status /
 * through / target) out of prepare() so trace/diagnostics can explain WHY a
 * checkpoint was not injected, without re-reading the DB. The eligibility is
 * always the result of `resolveUsableCheckpointForTarget()` on the SAME
 * snapshot that coverage / entity-weighting / Renderer consumed.
 *
 * `missing` reason maps to "尚无检查点"; `not_clean` / `empty_state` carry the
 * original status; `future_or_same_position` carries the original through vs.
 * target so the trace can say "检测到检查点截至第 N 章，当前目标为第 M 章".
 *
 * V2.5.16+ — illegal *target* chapter position hard-blocks prepare() before
 * coverage planning / checkpoint advance / rebuild / LLM. Illegal checkpoint
 * through position remains a safe degrade (no inject, coverage from -1).
 *
 * V3 — Readiness is local-only. Story Memory maintenance is scheduled after
 * this function returns and is never awaited by Context Builder or the
 * writing pipeline. Coverage gaps remain a hard safety boundary.
 */

export type StoryMemoryPrepareWarningCode =
  | 'story_memory_missing'
  | 'story_memory_dirty'
  | 'story_memory_failed'
  | 'checkpoint_update_failed'
  | 'history_partially_omitted';

export interface StoryMemoryPrepareWarning {
  code: StoryMemoryPrepareWarningCode;
  message: string;
  uncoveredChapterIds?: number[];
  action: 'open_story_memory' | 'adjust_context' | 'retry_later';
}

export interface PrepareStoryMemoryResult {
  checkpoint: ProjectStoryMemoryRecord | null;
  /**
   * The eligibility snapshot from the final `resolveUsableCheckpointForTarget`
   * call inside prepare(). Reflects the snapshot actually used for coverage
   * planning and (when usable) injection. Never re-reads the DB downstream.
   */
  checkpointEligibility: CheckpointEligibilityResult;
  coverage: StoryMemoryCoveragePlan;
  checkpointUpdated: boolean;
  /**
   * Legacy field. Only true when `fatal` is true — retained so existing
   * callers that still check `blocked` do not silently change behavior.
   */
  blocked: boolean;
  blockReason: string;
  /**
   * True only when the request itself cannot be built (illegal target chapter
   * position). Coverage gaps / failed checkpoint updates are NOT fatal.
   */
  fatal: boolean;
  /**
   * True when this request actually lost history continuity (uncovered
   * chapters) or a checkpoint update attempt failed. Drives the warning UI.
   */
  degraded: boolean;
  /** Non-blocking warnings; the request can still be compiled and sent. */
  warnings: StoryMemoryPrepareWarning[];
  /** True when the local coverage planner found a historical safety gap. */
  hardGap?: boolean;
  /** Whether background Story Memory maintenance should be signalled. */
  maintenanceDue?: boolean;
  maintenanceReason?: 'none' | StoryMemoryMaintenanceReason;
}

/** User-facing copy when the target chapter position is not a legal position. */
export const INVALID_TARGET_CHAPTER_POSITION_MESSAGE =
  '目标章节位置无效，无法安全构建上下文。';

const WARNING_MESSAGES: Record<
  StoryMemoryPrepareWarningCode,
  (uncoveredCount?: number) => string
> = {
  story_memory_missing: () => '当前项目还没有长期记忆检查点，近期章节使用摘要与正文兜底。',
  story_memory_dirty: () =>
    '长期记忆状态为待重建（dirty），本次未注入长期故事状态。',
  story_memory_failed: () =>
    '长期记忆上次整理失败，本次未注入长期故事状态。',
  checkpoint_update_failed: () =>
    '长期记忆整理失败，已使用最近正文继续写作。',
  history_partially_omitted: count =>
    `较早的 ${count} 章未纳入本次请求，人物与伏笔连续性可能下降。`,
};

function buildWarnings(
  input: {
    eligibility: CheckpointEligibilityResult;
    uncoveredChapterIds?: number[];
    checkpointUpdateFailed?: boolean;
  },
): StoryMemoryPrepareWarning[] {
  const warnings: StoryMemoryPrepareWarning[] = [];
  const { eligibility, uncoveredChapterIds, checkpointUpdateFailed } = input;
  const uncovered = uncoveredChapterIds || [];
  const add = (
    code: StoryMemoryPrepareWarningCode,
    action: StoryMemoryPrepareWarning['action'],
  ) => {
    warnings.push({
      code,
      message: WARNING_MESSAGES[code](
        code === 'history_partially_omitted' ? uncovered.length : undefined,
      ),
      ...(code === 'history_partially_omitted'
        ? { uncoveredChapterIds: [...uncovered] }
        : {}),
      action,
    });
  };

  if (!eligibility.usable && eligibility.reason !== 'future_or_same_position') {
    if (eligibility.reason === 'missing') {
      add('story_memory_missing', 'open_story_memory');
    } else if (eligibility.reason === 'not_clean') {
      if (eligibility.originalStatus === 'dirty') {
        add('story_memory_dirty', 'open_story_memory');
      } else if (eligibility.originalStatus === 'failed') {
        add('story_memory_failed', 'open_story_memory');
      }
    }
  }
  if (checkpointUpdateFailed) {
    add('checkpoint_update_failed', 'retry_later');
  }
  if (uncovered.length > 0) {
    add('history_partially_omitted', 'adjust_context');
  }
  return warnings;
}

/**
 * Prepare story memory for generation/context build.
 * Only hard-due may trigger a checkpoint LLM update (generation mode).
 * Preview mode never calls LLM.
 *
 * Checkpoint injection / entity weighting / coverage start all go through
 * resolveUsableCheckpointForTarget (future or same-position → unusable).
 *
 * V3 contract: readiness never waits for Story Memory LLM work. Safe Coverage
 * remains compilable with warnings; a historical Hard Gap is a safety boundary
 * (`fatal=true`) and must be repaired before generation. Missing / dirty /
 * failed checkpoints without a coverage gap remain degraded-but-compilable.
 */
export interface StoryMemoryReadiness
  extends Omit<
    PrepareStoryMemoryResult,
    | 'checkpointUpdated'
    | 'blocked'
    | 'hardGap'
    | 'maintenanceDue'
    | 'maintenanceReason'
  > {
  checkpointUpdated: boolean;
  blocked: boolean;
  hardGap: boolean;
  maintenanceDue: boolean;
  maintenanceReason: 'none' | StoryMemoryMaintenanceReason;
}

function maintenanceReasonForReadiness(input: {
  dirty: boolean;
  failed: boolean;
  hardGap: boolean;
  due: boolean;
  dueReason: string;
}): 'none' | StoryMemoryMaintenanceReason {
  if (input.dirty) return 'dirty';
  if (input.hardGap) return 'coverage_gap';
  if (!input.due && !input.failed) return 'none';
  if (input.dueReason === 'manual') return 'manual';
  return 'interval';
}

function hardGapMessage(uncoveredChapterIds: number[], chapters: Chapter[]): string {
  const uncovered = uncoveredChapterIds
    .map(id => chapters.find(chapter => chapter.id === id))
    .filter((chapter): chapter is Chapter => Boolean(chapter))
    .sort((a, b) => a.position - b.position);
  if (!uncovered.length) {
    return '历史章节存在未覆盖的信息，暂不能安全生成。长期记忆正在整理，请稍后重试。';
  }
  const first = uncovered[0].position + 1;
  const last = uncovered[uncovered.length - 1].position + 1;
  const range = first === last ? '第 ' + first + ' 章' : '第 ' + first + '～' + last + ' 章';
  return (
    range +
    '存在未覆盖的历史信息，暂不能安全生成。长期记忆正在整理；请进入「故事记忆」查看进度。'
  );
}

/**
 * Pure-local Story Memory readiness analysis.
 *
 * It reads chapters, the current memory row, policy and the coverage planner.
 * It never calls an LLM, acquires the memory apply lock, rebuilds, advances a
 * checkpoint or waits for a background task.
 */
export async function analyzeStoryMemoryReadiness(
  projectId: number,
  currentChapter: Chapter,
  config: ContextConfig,
  options: { scheduleMaintenance?: boolean } = {},
): Promise<StoryMemoryReadiness> {
  const chapters = await db.getChaptersByProject(projectId);
  let record: ProjectStoryMemoryRecord | null = null;
  if (typeof (db as any).getProjectStoryMemory === 'function') {
    record = await (db as any).getProjectStoryMemory(projectId);
  }
  if (!record && typeof (db as any).ensureProjectStoryMemoryRow === 'function') {
    record = await (db as any).ensureProjectStoryMemoryRow(projectId);
  }

  const eligibility = resolveUsableCheckpointForTarget(
    record,
    currentChapter.position,
  );

  if (
    !eligibility.usable &&
    eligibility.reason === 'invalid_position' &&
    eligibility.invalidPositionSource === 'target'
  ) {
    return {
      checkpoint: null,
      checkpointEligibility: eligibility,
      coverage: createEmptyStoryMemoryCoveragePlan('invalid_target_position'),
      checkpointUpdated: false,
      blocked: true,
      blockReason: INVALID_TARGET_CHAPTER_POSITION_MESSAGE,
      fatal: true,
      degraded: false,
      warnings: [],
      hardGap: false,
      maintenanceDue: false,
      maintenanceReason: 'none',
    };
  }

  const coverage = planStoryMemoryCoverage({
    currentChapter,
    chapters,
    checkpointThroughPosition: eligibility.checkpointThroughPosition,
    slidingBudgetTokens: config.slidingWindowSize || 4000,
  });
  const hardGap = coverage.hardDue;

  const policy =
    typeof (db as any).getStoryMemoryPolicy === 'function'
      ? (await (db as any).getStoryMemoryPolicy(projectId)) ||
        createDefaultStoryMemoryPolicy(projectId)
      : createDefaultStoryMemoryPolicy(projectId);
  const pendingForDue = listPendingChapters(
    chapters.filter(
      chapter =>
        Boolean(chapter.content?.trim()) &&
        (chapter.status === 'final' || chapter.finalized_at != null),
    ),
    eligibility.checkpointThroughPosition,
    currentChapter.position,
  );
  const due = evaluateStoryMemoryDue({
    policy,
    checkpointThroughPosition: eligibility.checkpointThroughPosition,
    pendingChapters: pendingForDue,
    hardDue: hardGap,
    dirty: record?.status === 'dirty',
  });
  const maintenanceDue =
    hardGap ||
    due.due ||
    record?.status === 'dirty' ||
    record?.status === 'failed';
  const maintenanceReason = maintenanceReasonForReadiness({
    dirty: record?.status === 'dirty',
    failed: record?.status === 'failed',
    hardGap,
    due: due.due,
    dueReason: due.reason,
  });
  const warnings = buildWarnings({
    eligibility,
    uncoveredChapterIds: coverage.uncoveredChapterIds,
  });

  if (options.scheduleMaintenance && maintenanceDue) {
    // The scheduled task owns the lock and every network request. Calling the
    // queue function itself is local and returns before its timer starts.
    enqueueStoryMemoryMaintenance({
      projectId,
      throughPosition: currentChapter.position - 1,
      reason: maintenanceReason === 'none' ? 'interval' : maintenanceReason,
      priority: 'background',
    });
  }

  return {
    checkpoint: eligibility.usable ? eligibility.checkpoint : null,
    checkpointEligibility: eligibility,
    coverage,
    checkpointUpdated: false,
    blocked: hardGap,
    blockReason: hardGap ? hardGapMessage(coverage.uncoveredChapterIds, chapters) : '',
    fatal: hardGap,
    degraded: !hardGap && warnings.length > 0,
    warnings,
    hardGap,
    maintenanceDue,
    maintenanceReason,
  };
}

/**
 * Main preparation entry. Generation mode performs only local readiness work
 * and signals background maintenance without awaiting it. Preview mode never
 * schedules or calls Story Memory LLM.
 */
export async function prepareStoryMemoryForGeneration(
  projectId: number,
  currentChapter: Chapter,
  config: ContextConfig,
  options: {
    mode?: 'generation' | 'preview';
    signal?: AbortSignal;
  } = {},
): Promise<StoryMemoryReadiness> {
  return analyzeStoryMemoryReadiness(projectId, currentChapter, config, {
    scheduleMaintenance: (options.mode || 'generation') === 'generation',
  });
}
