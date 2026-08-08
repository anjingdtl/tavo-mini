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
 * V2.11.38+ (repair plan P0) — `blocked` now only means FATAL: the request
 * itself cannot be built (illegal target chapter position). Coverage gaps and
 * failed checkpoint updates are observable DEGRADED states: the context is
 * still compilable, the user is warned, and writing may continue. Long-term
 * memory is an enhancement, never a writing license.
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
 * Non-blocking contract (V2.11.38 repair plan P0): the ONLY hard failure is
 * an illegal target chapter position (`fatal=true`). Missing / dirty / failed
 * checkpoints, failed update attempts and uncovered chapters all return a
 * degraded-but-compilable result with warnings.
 */
export async function prepareStoryMemoryForGeneration(
  projectId: number,
  currentChapter: Chapter,
  config: ContextConfig,
  options: {
    mode?: 'generation' | 'preview';
    signal?: AbortSignal;
  } = {},
): Promise<PrepareStoryMemoryResult> {
  const mode = options.mode || 'generation';
  const chapters = await db.getChaptersByProject(projectId);
  let record: ProjectStoryMemoryRecord | null = null;
  if (typeof (db as any).getProjectStoryMemory === 'function') {
    record = await (db as any).getProjectStoryMemory(projectId);
  } else if (typeof (db as any).ensureProjectStoryMemoryRow === 'function') {
    record = await (db as any).ensureProjectStoryMemoryRow(projectId);
  }

  const eligibility = resolveUsableCheckpointForTarget(
    record,
    currentChapter.position,
  );

  // V2.5.16: illegal target chapter position must hard-block BEFORE coverage
  // planning, checkpoint advance/rebuild, Episodic scoring, or any LLM call.
  // Illegal checkpoint through alone is NOT a hard block (handled below as
  // usable=false with checkpointThroughPosition=-1).
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
    };
  }

  const checkpointThrough = eligibility.checkpointThroughPosition;

  let coverage = planStoryMemoryCoverage({
    currentChapter,
    chapters,
    checkpointThroughPosition: checkpointThrough,
    slidingBudgetTokens: config.slidingWindowSize || 4000,
  });

  if (!coverage.hardDue) {
    return {
      // Only return checkpoint when usable for this target chapter.
      checkpoint: eligibility.usable ? eligibility.checkpoint : null,
      // Same single eligibility decision — never re-read DB downstream.
      checkpointEligibility: eligibility,
      coverage,
      checkpointUpdated: false,
      blocked: false,
      blockReason: '',
      fatal: false,
      degraded: false,
      warnings: buildWarnings({ eligibility }),
    };
  }

  // Preview never spends LLM tokens. Coverage gaps degrade instead of blocking.
  if (mode === 'preview') {
    return {
      checkpoint: eligibility.usable ? eligibility.checkpoint : null,
      checkpointEligibility: eligibility,
      coverage,
      checkpointUpdated: false,
      blocked: false,
      blockReason: '',
      fatal: false,
      degraded: coverage.uncoveredChapterIds.length > 0,
      warnings: buildWarnings({ eligibility, uncoveredChapterIds: coverage.uncoveredChapterIds }),
    };
  }

  // Hard due: attempt one batch checkpoint update before generation. A failed
  // update is a warning, never a blocker — re-plan coverage and continue.
  try {
    const { withProjectMemoryLock, runStoryMemoryTaskOnce } = await import(
      './storyMemoryService'
    );
    const { advanceStoryMemoryCheckpointsUnlocked } = await import(
      './storyMemoryCheckpointService'
    );
    const { rebuildStoryMemoryUnlocked } = await import('./storyMemoryRebuild');
    const maintainThrough = currentChapter.position - 1;
    // P2: single-flight dedupe — concurrent preview/finalize/generation for
    // the same project+range share one maintenance run instead of queueing
    // duplicate checkpoint batches.
    await runStoryMemoryTaskOnce(
      `story-memory-maintain:${projectId}:${maintainThrough}`,
      () =>
        withProjectMemoryLock(projectId, async () => {
          const latestRecord = await db.ensureProjectStoryMemoryRow(projectId);
          if (latestRecord.status === 'dirty') {
            await rebuildStoryMemoryUnlocked(projectId, {
              mode: 'auto',
              throughPosition: maintainThrough,
              signal: options.signal,
            });
            return;
          }
          await advanceStoryMemoryCheckpointsUnlocked({
            projectId,
            // Catch up enough pending to close coverage gap.
            throughPosition: maintainThrough,
            signal: options.signal,
          });
        }),
    );
    const refreshed = await db.ensureProjectStoryMemoryRow(projectId);
    const refreshedEligibility = resolveUsableCheckpointForTarget(
      refreshed,
      currentChapter.position,
    );
    coverage = planStoryMemoryCoverage({
      currentChapter,
      chapters: await db.getChaptersByProject(projectId),
      checkpointThroughPosition:
        refreshedEligibility.checkpointThroughPosition,
      slidingBudgetTokens: config.slidingWindowSize || 4000,
    });
    return {
      checkpoint: refreshedEligibility.usable
        ? refreshedEligibility.checkpoint
        : null,
      checkpointEligibility: refreshedEligibility,
      coverage,
      checkpointUpdated: true,
      blocked: false,
      blockReason: '',
      fatal: false,
      degraded: coverage.uncoveredChapterIds.length > 0,
      warnings: buildWarnings({
        eligibility: refreshedEligibility,
        uncoveredChapterIds: coverage.uncoveredChapterIds,
      }),
    };
  } catch {
    // Re-plan after failure; the result stays compilable even when uncovered
    // chapters remain. The update failure is surfaced as a warning only.
    const chaptersAfter = await db.getChaptersByProject(projectId);
    const latest = await db.ensureProjectStoryMemoryRow(projectId);
    const latestEligibility = resolveUsableCheckpointForTarget(
      latest,
      currentChapter.position,
    );
    coverage = planStoryMemoryCoverage({
      currentChapter,
      chapters: chaptersAfter,
      checkpointThroughPosition: latestEligibility.checkpointThroughPosition,
      slidingBudgetTokens: config.slidingWindowSize || 4000,
    });
    return {
      checkpoint: latestEligibility.usable
        ? latestEligibility.checkpoint
        : null,
      checkpointEligibility: latestEligibility,
      coverage,
      checkpointUpdated: false,
      blocked: false,
      blockReason: '',
      fatal: false,
      degraded: true,
      warnings: buildWarnings({
        eligibility: latestEligibility,
        uncoveredChapterIds: coverage.uncoveredChapterIds,
        checkpointUpdateFailed: true,
      }),
    };
  }
}
