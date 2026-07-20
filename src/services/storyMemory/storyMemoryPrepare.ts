import type { Chapter, ContextConfig } from '../../types/novel';
import * as db from '../database';
import { planStoryMemoryCoverage } from './storyMemoryCoverage';
import { resolveUsableCheckpointForTarget } from './storyMemoryCheckpointEligibility';
import type { ProjectStoryMemoryRecord } from '../../data/repositories/storyMemoryRepository';
import type { StoryMemoryCoveragePlan } from './storyMemoryTypes';
import { StoryMemoryError } from './storyMemoryTypes';

export interface PrepareStoryMemoryResult {
  checkpoint: ProjectStoryMemoryRecord | null;
  coverage: StoryMemoryCoveragePlan;
  checkpointUpdated: boolean;
  blocked: boolean;
  blockReason: string;
}

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
