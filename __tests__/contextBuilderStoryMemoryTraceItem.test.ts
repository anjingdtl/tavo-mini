/**
 * V2.5.15 — `buildStoryMemoryTraceItem` single-source-of-truth tests.
 *
 * `buildContext()` must emit EXACTLY ONE story_memory trace item, merging:
 *   - the prepared `checkpointEligibility` (the real reason a checkpoint was /
 *     was not used) — never a second DB read;
 *   - the Renderer result (usable tokens / clipped / preview).
 *
 * For an UNUSABLE checkpoint `prepared.checkpoint` is null, so the Renderer
 * sees "missing" (empty text, no tokens). The trace reason must still come from
 * the prepared eligibility (future / dirty / empty / invalid), not collapse to
 * a generic "missing" copy.
 */

import type { ContextTraceItem } from '../src/types/contextTrace';
import {
  buildStoryMemoryTraceItem,
  describeCheckpointEligibility,
} from '../src/services/contextBuilder';
import { resolveUsableCheckpointForTarget } from '../src/services/storyMemory/storyMemoryCheckpointEligibility';
import { createEmptyStoryMemory } from '../src/services/storyMemory/storyMemoryDefaults';
import type { ProjectStoryMemoryRecord } from '../src/data/repositories/storyMemoryRepository';
import type { StoryMemoryCoveragePlan } from '../src/services/storyMemory/storyMemoryTypes';

function record(
  status: ProjectStoryMemoryRecord['status'],
  through: number,
): ProjectStoryMemoryRecord {
  const state = createEmptyStoryMemory(1);
  state.throughChapterPosition = through;
  return {
    state,
    status,
    dirtyFromPosition: status === 'dirty' ? 0 : null,
    lastError: '',
    updatedAt: '',
  };
}

function emptyCoverage(through = -1): StoryMemoryCoveragePlan {
  return {
    checkpointThroughPosition: through,
    pendingChapters: [],
    seamChapter: null,
    rawChapterIds: [],
    episodicFallbackChapterIds: [],
    uncoveredChapterIds: [],
    estimatedRawTokens: 0,
    hardDue: false,
    reason: '',
  };
}

describe('buildStoryMemoryTraceItem — single source of truth', () => {
  it('usable checkpoint: reason from position, tokens/clipped/preview from Renderer', () => {
    const eligibility = resolveUsableCheckpointForTarget(record('clean', 1), 5);
    const rendererResult = {
      text: '【故事全局状态｜截至第2章】正文预览内容',
      traceItems: [
        {
          kind: 'story_memory',
          sourceId: 1,
          title: '长期故事检查点',
          reason: '检查点截至第 2 章',
          estimatedTokens: 1234,
          included: true,
          clipped: true,
          preview: '正文预览内容',
        } as ContextTraceItem,
      ],
    };
    const item = buildStoryMemoryTraceItem({
      eligibility,
      rendererResult,
      coverage: emptyCoverage(1),
      rawChapterIds: [],
      projectId: 7,
    });
    expect(item.kind).toBe('story_memory');
    expect(item.sourceId).toBe(7);
    expect(item.reason).toContain('检查点截至第 2 章');
    expect(item.included).toBe(true);
    expect(item.clipped).toBe(true);
    expect(item.estimatedTokens).toBe(1234);
    expect(item.preview).toContain('正文预览内容');
  });

  it('future checkpoint: reason from prepared eligibility (Renderer saw missing)', () => {
    // prepared.checkpoint is null for a future checkpoint → Renderer text empty.
    const eligibility = resolveUsableCheckpointForTarget(record('clean', 10), 3);
    expect(eligibility.usable).toBe(false);
    expect(eligibility.reason).toBe('future_or_same_position');
    const rendererResult = { text: '', traceItems: [] as ContextTraceItem[] };
    const item = buildStoryMemoryTraceItem({
      eligibility,
      rendererResult,
      coverage: emptyCoverage(-1),
      rawChapterIds: [],
      projectId: 7,
    });
    // Real future reason surfaced, not the generic "missing" copy.
    expect(item.reason).toContain('检测到检查点截至第 11 章');
    expect(item.reason).toContain('当前目标为第 4 章');
    expect(item.reason).toContain('未注入');
    expect(item.included).toBe(false);
    expect(item.estimatedTokens).toBe(0);
  });

  it('dirty checkpoint: reason mentions dirty via prepared eligibility', () => {
    const eligibility = resolveUsableCheckpointForTarget(record('dirty', 2), 5);
    const rendererResult = { text: '', traceItems: [] as ContextTraceItem[] };
    const item = buildStoryMemoryTraceItem({
      eligibility,
      rendererResult,
      coverage: emptyCoverage(-1),
      rawChapterIds: [],
      projectId: 7,
    });
    expect(item.reason).toContain('不可用');
    expect(item.reason).toContain('dirty');
    expect(item.included).toBe(false);
  });

  it('invalid-position checkpoint: reason says invalid position', () => {
    const eligibility = resolveUsableCheckpointForTarget(record('clean', -1), 5);
    const rendererResult = { text: '', traceItems: [] as ContextTraceItem[] };
    const item = buildStoryMemoryTraceItem({
      eligibility,
      rendererResult,
      coverage: emptyCoverage(-1),
      rawChapterIds: [],
      projectId: 7,
    });
    expect(item.reason).toContain('位置无效');
  });

  it('appends coverage diagnostics (hardDue / uncovered / raw exclusions)', () => {
    const eligibility = resolveUsableCheckpointForTarget(record('clean', 1), 5);
    const rendererResult = {
      text: 'rendered',
      traceItems: [
        { estimatedTokens: 10, clipped: false } as any,
      ],
    };
    const item = buildStoryMemoryTraceItem({
      eligibility,
      rendererResult,
      coverage: {
        ...emptyCoverage(1),
        hardDue: true,
        uncoveredChapterIds: [3, 4],
      },
      rawChapterIds: [9, 10],
      projectId: 7,
    });
    expect(item.reason).toContain('hardDue');
    expect(item.reason).toContain('未覆盖:3,4');
    expect(item.reason).toContain('Episodic排除raw:9,10');
  });

  it('never reads the DB (pure merge of supplied inputs)', () => {
    // No DB module is imported by the helper; this is a structural guarantee.
    // We assert the function is callable with fully in-memory inputs.
    const eligibility = resolveUsableCheckpointForTarget(null, 5);
    const item = buildStoryMemoryTraceItem({
      eligibility,
      rendererResult: { text: '', traceItems: [] },
      coverage: undefined,
      rawChapterIds: [],
      projectId: 1,
    });
    expect(item.kind).toBe('story_memory');
    // Missing checkpoint (no coverage) keeps the legacy "尚无可用" copy.
    expect(item.reason).toContain('尚无可用');
  });
});

describe('buildStoryMemoryTraceItem — consistent with describeCheckpointEligibility', () => {
  it('the reason for an unusable checkpoint starts with the describer output', () => {
    const eligibility = resolveUsableCheckpointForTarget(record('clean', 8), 5);
    const item = buildStoryMemoryTraceItem({
      eligibility,
      rendererResult: { text: '', traceItems: [] },
      coverage: emptyCoverage(-1),
      rawChapterIds: [],
      projectId: 1,
    });
    // The trace reason must derive from the prepared eligibility only: the
    // describer output is the leading fragment (any status/coverage diagnostics
    // are appended after a separator). Using startsWith avoids the describer's
    // own internal separator breaking a naive split.
    expect(item.reason.startsWith(describeCheckpointEligibility(eligibility))).toBe(
      true,
    );
  });
});
