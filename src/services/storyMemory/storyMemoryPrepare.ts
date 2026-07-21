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
import { StoryMemoryError } from './storyMemoryTypes';

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
 */
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
  blocked: boolean;
  blockReason: string;
}

/** User-facing copy when the target chapter position is not a legal position. */
export const INVALID_TARGET_CHAPTER_POSITION_MESSAGE =
  '目标章节位置无效，无法安全构建上下文。';

/**
 * Prepare story memory for generation/context build.
 * Only hard-due may trigger a checkpoint LLM update (generation mode).
 * Preview mode never calls LLM.
 *
 * Checkpoint injection / entity weighting / coverage start all go through
 * resolveUsableCheckpointForTarget (future or same-position → unusable).
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
    };
  }

  // Preview never spends LLM tokens.
  if (mode === 'preview') {
    return {
      checkpoint: eligibility.usable ? eligibility.checkpoint : null,
      checkpointEligibility: eligibility,
      coverage,
      checkpointUpdated: false,
      blocked: coverage.uncoveredChapterIds.length > 0,
      blockReason:
        coverage.uncoveredChapterIds.length > 0
          ? '长期记忆覆盖不足，请先整理检查点或扩大上下文预算。'
          : '',
    };
  }

  // Hard due: attempt one batch checkpoint update before generation.
  try {
    const { withProjectMemoryLock } = await import('./storyMemoryService');
    const { advanceStoryMemoryCheckpointsUnlocked } = await import(
      './storyMemoryCheckpointService'
    );
    const { rebuildStoryMemoryUnlocked } = await import('./storyMemoryRebuild');
    await withProjectMemoryLock(projectId, async () => {
      const latestRecord = await db.ensureProjectStoryMemoryRow(projectId);
      if (latestRecord.status === 'dirty') {
        await rebuildStoryMemoryUnlocked(projectId, {
          mode: 'auto',
          throughPosition: currentChapter.position - 1,
          signal: options.signal,
        });
        return;
      }
      await advanceStoryMemoryCheckpointsUnlocked({
        projectId,
        // Catch up enough pending to close coverage gap.
        throughPosition: currentChapter.position - 1,
        signal: options.signal,
      });
    });
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
    if (coverage.uncoveredChapterIds.length > 0) {
      return {
        checkpoint: refreshedEligibility.usable
          ? refreshedEligibility.checkpoint
          : null,
        checkpointEligibility: refreshedEligibility,
        coverage,
        checkpointUpdated: true,
        blocked: true,
        blockReason:
          '长期记忆整理后仍存在未覆盖章节，无法安全生成。请重试整理或调整上下文预算。',
      };
    }
    return {
      checkpoint: refreshedEligibility.usable
        ? refreshedEligibility.checkpoint
        : null,
      checkpointEligibility: refreshedEligibility,
      coverage,
      checkpointUpdated: true,
      blocked: false,
      blockReason: '',
    };
  } catch (error) {
    // Re-plan after failure; allow if episodic fallback can cover.
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
    if (coverage.uncoveredChapterIds.length === 0) {
      return {
        checkpoint: latestEligibility.usable
          ? latestEligibility.checkpoint
          : null,
        checkpointEligibility: latestEligibility,
        coverage,
        checkpointUpdated: false,
        blocked: false,
        blockReason: '',
      };
    }
    const message = error instanceof Error ? error.message : '长期记忆整理失败';
    throw new StoryMemoryError(
      'MEMORY_CHECKPOINT_COVERAGE_GAP',
      `无法构建连续上下文：${message}`,
    );
  }
}
