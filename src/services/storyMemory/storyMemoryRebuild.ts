import type { Chapter } from '../../types/novel';
import { estimateTokens } from '../../utils/tokenEstimator';
import { invalidateIdf } from '../../utils/idfCache';
import * as db from '../database';
import {
  runStoryMemoryCheckpointBatch,
  type StoryMemoryCheckpointProgressEvent,
} from './storyMemoryCheckpointService';
import { createEmptyStoryMemory } from './storyMemoryDefaults';
import {
  fingerprintChapterSource,
  fingerprintStoryMemoryState,
  stableTextFingerprint,
} from './storyMemoryFingerprint';
import { applyStoryMemoryPatch } from './storyMemoryMerger';
import {
  splitCheckpointBatches,
  STORY_MEMORY_DEFAULT_BATCH_SIZE,
} from './storyMemoryPolicy';
import {
  generateValidatedChapterMemoryPatch,
  renderEpisodicMemoryText,
  withProjectMemoryLock,
} from './storyMemoryService';
import type { StoryMemoryPartialSuccess, StoryMemoryState } from './storyMemoryTypes';
import { StoryMemoryError } from './storyMemoryTypes';
import { makeContinuationChapterNumbering } from '../continuation/chapterNumbering/continuationChapterNumbering';
import {
  StoryMemoryAttemptBudget,
  createStoryMemoryLogicalBatchId,
} from './storyMemoryAttemptBudget';
import { STORY_MEMORY_MAX_PHYSICAL_REQUESTS } from './storyMemoryAttemptPolicy';

export interface StoryMemoryRebuildProgress {
  projectId: number;
  currentPosition: number;
  totalChapters: number;
  completedChapters: number;
  reusedPatches: number;
  regeneratedPatches: number;
  status: 'preparing' | 'running' | 'saving' | 'completed';
}

export interface StoryMemoryRebuildResult {
  state: StoryMemoryState;
  completedChapters: number;
  reusedPatches: number;
  regeneratedPatches: number;
}

export interface RebuildStoryMemoryOptions {
  fromPosition?: number;
  throughPosition?: number;
  mode?: 'auto' | 'full' | 'legacy_bootstrap';
  onProgress?: (progress: StoryMemoryRebuildProgress) => void;
  onCheckpointProgress?: (progress: StoryMemoryCheckpointProgressEvent) => void;
  signal?: AbortSignal;
}

function legacyChapter(chapter: Chapter): Chapter {
  const summaryJson = chapter.summary_json
    ? JSON.stringify(chapter.summary_json)
    : '';
  return {
    ...chapter,
    content: [
      chapter.title,
      chapter.synopsis,
      chapter.memory_summary || '',
      summaryJson,
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

function emitProgress(
  options: RebuildStoryMemoryOptions,
  progress: StoryMemoryRebuildProgress,
): void {
  options.onProgress?.(progress);
}

export async function rebuildStoryMemory(
  projectId: number,
  options: RebuildStoryMemoryOptions = {},
): Promise<StoryMemoryRebuildResult> {
  return withProjectMemoryLock(projectId, () =>
    rebuildStoryMemoryUnlocked(projectId, options),
  );
}

/**
 * Rebuild while the caller already owns the project-memory lock.
 * This avoids recursively acquiring the same lock from finalization and
 * generation-preparation paths.
 */
export async function rebuildStoryMemoryUnlocked(
  projectId: number,
  options: RebuildStoryMemoryOptions = {},
): Promise<StoryMemoryRebuildResult> {
  const allChapters = (await db.getChaptersByProject(projectId)).filter(
    chapter =>
      chapter.content.trim() ||
      chapter.memory_summary?.trim() ||
      chapter.summary_json,
  );
  const throughPosition =
    options.throughPosition ?? allChapters.at(-1)?.position ?? -1;
  const record = await db.ensureProjectStoryMemoryRow(projectId);
  let mode = options.mode || 'auto';
  if (mode === 'auto' && record.status === 'empty') {
    mode = allChapters.some(chapter => chapter.memory_summary?.trim())
      ? 'legacy_bootstrap'
      : 'full';
  }
  // Capture before status flips to "rebuilding". Dirty rebuilds must not reuse
  // applied batches that still describe the pre-edit story world.
  const dirtyRebuild =
    mode === 'auto' &&
    (record.status === 'dirty' || record.dirtyFromPosition != null);
  const requestedStart =
    options.fromPosition ??
    record.dirtyFromPosition ??
    Math.max(0, record.state.throughChapterPosition + 1);
  let state: StoryMemoryState;
  // The state used as the rebuild base can come from an older snapshot,
  // while the row in project_story_memory still contains the dirty latest
  // checkpoint. Track the latter separately for the first atomic CAS.
  let expectedPersistedFingerprint = record.state.metadata.stateFingerprint;
  let replayStart: number;
  if (mode === 'full' || mode === 'legacy_bootstrap') {
    state = createEmptyStoryMemory(
      projectId,
      mode === 'legacy_bootstrap' ? 'legacy_bootstrap' : 'native',
    );
    replayStart = 0;
  } else {
    const snapshot = await db.getNearestStoryMemorySnapshot(
      projectId,
      requestedStart,
    );
    state = snapshot?.state || createEmptyStoryMemory(projectId);
    replayStart = snapshot ? snapshot.state.throughChapterPosition + 1 : 0;
  }
  const chapters = allChapters.filter(
    chapter =>
      chapter.position >= replayStart && chapter.position <= throughPosition,
  );
  const config = await db.getContextConfig();
  let reusedPatches = 0;
  let regeneratedPatches = 0;
  let completedChapters = 0;
  const baseProgress = (): StoryMemoryRebuildProgress => ({
    projectId,
    currentPosition: chapters[completedChapters]?.position ?? throughPosition,
    totalChapters: chapters.length,
    completedChapters,
    reusedPatches,
    regeneratedPatches,
    status: 'running',
  });
  emitProgress(options, { ...baseProgress(), status: 'preparing' });
  await db.setStoryMemoryBuildStatus(projectId, 'rebuilding', replayStart, '');

  const schedulerEnabled =
    mode !== 'legacy_bootstrap' &&
    (typeof (db as any).getStoryMemoryCheckpointSchedulerEnabled === 'function'
      ? await (db as any).getStoryMemoryCheckpointSchedulerEnabled()
      : true);

  // Batch rebuild path (default): same checkpoint extraction as incremental
  // updates, so cast accumulation rules stay consistent and we avoid N
  // per-chapter patches that under-extract people. LLM batch size is the fixed
  // safe constant, decoupled from the policy trigger interval.
  if (schedulerEnabled && chapters.length > 0) {
    const batches = splitCheckpointBatches(
      chapters,
      STORY_MEMORY_DEFAULT_BATCH_SIZE,
    );
    // Once any batch is regenerated, later batches must not reuse pre-edit
    // applied patches even if fingerprints coincidentally match.
    let forceRegenerateRemaining = dirtyRebuild;
    for (const batchChapters of batches) {
      if (options.signal?.aborted) {
        await db.setStoryMemoryBuildStatus(
          projectId,
          'dirty',
          batchChapters[0]?.position ?? replayStart,
          '',
        );
        throw new StoryMemoryError(
          'MEMORY_REBUILD_CANCELLED',
          '故事记忆重建已取消。',
        );
      }
      emitProgress(options, {
        ...baseProgress(),
        currentPosition: batchChapters[0].position,
        status: 'running',
      });
      try {
        const sourceFingerprint = stableTextFingerprint(
          batchChapters
            .map(
              chapter =>
                `${chapter.id}:${chapter.position}:${fingerprintChapterSource(
                  chapter,
                )}`,
            )
            .join('|'),
        );
        const baseFingerprint = fingerprintStoryMemoryState(state);
        const existingBatches =
          !forceRegenerateRemaining &&
          typeof (db as any).listStoryMemoryBatches === 'function'
            ? await (db as any).listStoryMemoryBatches(projectId, ['applied'])
            : [];
        const reusable = existingBatches.find(
          (batch: {
            fromPosition: number;
            throughPosition: number;
            sourceFingerprint: string;
            baseStateFingerprint: string;
            status: string;
          }) =>
            batch.fromPosition === batchChapters[0].position &&
            batch.throughPosition ===
              batchChapters[batchChapters.length - 1].position &&
            batch.sourceFingerprint === sourceFingerprint &&
            batch.baseStateFingerprint === baseFingerprint,
        );
        if (reusable?.patch) {
          const { applyStoryMemoryBatchPatch } = await import(
            './storyMemoryMerger'
          );
          const applied = applyStoryMemoryBatchPatch(state, reusable.patch, {
            projectId,
            sourceFingerprint,
            baseMemoryFingerprint: baseFingerprint,
            batchId: reusable.batchId,
            now: new Date().toISOString(),
            title: batchChapters[batchChapters.length - 1].title,
          });
          state = applied.state;
          reusedPatches += batchChapters.length;
          await db.saveStoryMemoryBatchUpdate({
            previousFingerprint: expectedPersistedFingerprint,
            state: applied.state,
            batch: applied.resolvedBatch,
            chapterSummaries: (reusable.chapterSummaries || []).map(
              (summary: { chapterId: number; brief?: string }) => {
                const chapter = batchChapters.find(
                  item => item.id === summary.chapterId,
                );
                const text = renderEpisodicMemoryText(
                  {
                    brief: summary.brief || '',
                    keywords: (summary as any).keywords || [],
                    events: (summary as any).events || [],
                    characterChanges: (summary as any).characterChanges || [],
                    relationshipChanges:
                      (summary as any).relationshipChanges || [],
                    mainlineChanges: (summary as any).mainlineChanges || [],
                    newThreads: (summary as any).newThreads || [],
                    resolvedThreads: (summary as any).resolvedThreads || [],
                  },
                  chapter,
                );
                return {
                  chapterId: summary.chapterId,
                  text,
                  estimatedTokens: estimateTokens(text),
                };
              },
            ),
            createSnapshot: true,
          });
          expectedPersistedFingerprint =
            applied.state.metadata.stateFingerprint;
        } else {
          const result = await runStoryMemoryCheckpointBatch({
            projectId,
            chapters: batchChapters,
            previousState: state,
            expectedPersistedFingerprint,
            memoryPatchMaxTokens: config.memoryPatchMaxTokens || 1200,
            signal: options.signal,
            createSnapshot: true,
            scenario:
              mode === 'legacy_bootstrap'
                ? 'story_memory_checkpoint_legacy_bootstrap'
                : 'story_memory_checkpoint',
            onProgress: options.onCheckpointProgress,
          });
          state = result.state;
          expectedPersistedFingerprint = state.metadata.stateFingerprint;
          regeneratedPatches += batchChapters.length;
          forceRegenerateRemaining = true;
        }
        completedChapters += batchChapters.length;
        emitProgress(options, {
          ...baseProgress(),
          currentPosition: batchChapters[batchChapters.length - 1].position,
          status: 'saving',
        });
      } catch (error) {
        if (
          error instanceof StoryMemoryError &&
          error.code === 'MEMORY_BASE_FINGERPRINT_MISMATCH'
        ) {
          await db.markStoryMemoryDirty(
            projectId,
            batchChapters[0]?.position ?? replayStart,
            error.message,
          );
          throw error;
        }
        if (
          options.signal?.aborted ||
          (error instanceof StoryMemoryError &&
            (error.code === 'MEMORY_REBUILD_CANCELLED' ||
              error.code === 'MEMORY_CHECKPOINT_CANCELLED')) ||
          (error as { code?: string } | null)?.code === 'cancelled'
        ) {
          await db.setStoryMemoryBuildStatus(
            projectId,
            'dirty',
            batchChapters[0]?.position ?? replayStart,
            '',
          );
          throw error instanceof StoryMemoryError
            ? error
            : new StoryMemoryError(
                'MEMORY_REBUILD_CANCELLED',
                '故事记忆重建已取消。',
              );
        }
        const message = error instanceof Error ? error.message : '未知错误';
        // Code-review fix 1: a split batch may have persisted its first half
        // before failing on the second. The error carries `partial` — the
        // latest persisted state and its completed-chapter count. Fold it in
        // BEFORE deciding failed-vs-clean, otherwise this batch counts as
        // completedChapters=0 and the whole project would be marked 'failed',
        // clobbering the first half's clean checkpoint.
        const partial = (error as {
          partial?: StoryMemoryPartialSuccess;
        } | null)?.partial;
        if (partial) {
          state = partial.state;
          expectedPersistedFingerprint = state.metadata.stateFingerprint;
          completedChapters += partial.completedChapters;
        }
        // V2.11.38 repair plan P1 §6.4: when at least one batch already
        // succeeded, keep the latest clean checkpoint as the persisted status
        // instead of flipping the whole rebuild to 'failed'. The failed batch
        // is still recorded in `lastError` for diagnostics/retry.
        if (completedChapters > 0) {
          await db.setStoryMemoryBuildStatus(
            projectId,
            state.metadata.status,
            state.metadata.dirtyFromPosition,
            message,
          );
        } else {
          await db.setStoryMemoryBuildStatus(
            projectId,
            'failed',
            batchChapters[0]?.position ?? replayStart,
            message,
          );
        }
        let fromLabel = makeContinuationChapterNumbering(null).getDefaultTitle(
          (batchChapters[0]?.position ?? 0) as any,
        );
        try {
          const { getContinuationChapterNumbering } = await import(
            '../continuation/chapterNumbering/continuationChapterNumbering'
          );
          const numbering = await getContinuationChapterNumbering(projectId);
          fromLabel = numbering.getDefaultTitle(
            (batchChapters[0]?.position ?? 0) as any,
          );
        } catch {
          // outline / no boundary → keep position+1 label
        }
        throw new StoryMemoryError(
          'MEMORY_REBUILD_FAILED',
          `${fromLabel}起检查点重建失败：${message}`,
        );
      }
    }
  } else {
    // Legacy chapter-by-chapter path (bootstrap / scheduler off).
    for (const chapter of chapters) {
      if (options.signal?.aborted) {
        await db.setStoryMemoryBuildStatus(
          projectId,
          'dirty',
          chapter.position,
          '',
        );
        throw new StoryMemoryError(
          'MEMORY_REBUILD_CANCELLED',
          '故事记忆重建已取消。',
        );
      }
      emitProgress(options, {
        ...baseProgress(),
        currentPosition: chapter.position,
      });
      try {
        const inputChapter =
          mode === 'legacy_bootstrap' ? legacyChapter(chapter) : chapter;
        const sourceFingerprint = fingerprintChapterSource(inputChapter);
        const existing = await db.getChapterMemoryPatch(chapter.id);
        let draft;
        if (
          existing &&
          (existing.status === 'applied' || existing.status === 'generated') &&
          existing.patch.schemaVersion === 1 &&
          existing.patch.sourceFingerprint === sourceFingerprint &&
          existing.patch.baseMemoryFingerprint ===
            fingerprintStoryMemoryState(state)
        ) {
          draft = existing.patch.normalizedPatch;
          reusedPatches += 1;
        } else {
          draft = await generateValidatedChapterMemoryPatch({
            chapter: inputChapter,
            previousState: state,
            memoryPatchMaxTokens: config.memoryPatchMaxTokens || 1200,
            signal: options.signal,
            scenario:
              mode === 'legacy_bootstrap'
                ? 'story_memory_legacy_bootstrap'
                : 'story_memory_patch',
            attemptBudget: new StoryMemoryAttemptBudget({
              logicalBatchId: createStoryMemoryLogicalBatchId({
                projectId,
                fromPosition: inputChapter.position,
                throughPosition: inputChapter.position,
                kind: 'rebuild_patch',
              }),
              projectId,
              fromPosition: inputChapter.position,
              throughPosition: inputChapter.position,
              maxPhysicalRequests: STORY_MEMORY_MAX_PHYSICAL_REQUESTS,
            }),
          });
          regeneratedPatches += 1;
        }
        const applied = applyStoryMemoryPatch(state, draft, {
          projectId,
          chapterId: chapter.id,
          chapterPosition: chapter.position,
          sourceFingerprint,
          baseMemoryFingerprint: fingerprintStoryMemoryState(state),
          now: new Date().toISOString(),
        });
        state = applied.state;
        state.metadata.source =
          mode === 'legacy_bootstrap' ? 'legacy_bootstrap' : 'native';
        completedChapters += 1;
        const isLast = completedChapters === chapters.length;
        state.metadata.status = isLast ? 'clean' : 'rebuilding';
        state.metadata.dirtyFromPosition = isLast
          ? null
          : chapters[completedChapters]?.position ?? null;
        emitProgress(options, {
          ...baseProgress(),
          currentPosition: chapter.position,
          status: 'saving',
        });
        await db.saveStoryMemoryUpdate({
          state,
          patch: applied.resolvedPatch,
          episodicMemoryText: renderEpisodicMemoryText(draft.episodicSummary),
          finalizedAt: applied.state.metadata.updatedAt,
          createSnapshot: isLast,
        });
      } catch (error) {
        if (
          options.signal?.aborted ||
          (error instanceof StoryMemoryError &&
            error.code === 'MEMORY_REBUILD_CANCELLED') ||
          (error as { code?: string } | null)?.code === 'cancelled'
        ) {
          await db.setStoryMemoryBuildStatus(
            projectId,
            'dirty',
            chapter.position,
            '',
          );
          throw error instanceof StoryMemoryError &&
            error.code === 'MEMORY_REBUILD_CANCELLED'
            ? error
            : new StoryMemoryError(
                'MEMORY_REBUILD_CANCELLED',
                '故事记忆重建已取消。',
              );
        }
        const message = error instanceof Error ? error.message : '未知错误';
        await db.setStoryMemoryBuildStatus(
          projectId,
          'failed',
          chapter.position,
          message,
        );
        let chapterLabel = makeContinuationChapterNumbering(null).getDefaultTitle(
          chapter.position as any,
        );
        try {
          const { getContinuationChapterNumbering } = await import(
            '../continuation/chapterNumbering/continuationChapterNumbering'
          );
          const numbering = await getContinuationChapterNumbering(projectId);
          chapterLabel = numbering.getDefaultTitle(chapter.position as any);
        } catch {
          // outline / no boundary → keep position+1 label
        }
        throw new StoryMemoryError(
          'MEMORY_REBUILD_FAILED',
          `${chapterLabel}故事记忆重建失败：${message}`,
        );
      }
    }
  }
  if (chapters.length === 0) {
    state.metadata.status = 'clean';
    state.metadata.dirtyFromPosition = null;
    await db.setStoryMemoryBuildStatus(projectId, 'clean', null, '');
  }
  invalidateIdf(projectId);
  emitProgress(options, { ...baseProgress(), status: 'completed' });
  return { state, completedChapters, reusedPatches, regeneratedPatches };
}

export async function ensureStoryMemoryReady(
  projectId: number,
  throughPosition: number,
): Promise<StoryMemoryState> {
  const record = await db.ensureProjectStoryMemoryRow(projectId);
  if (
    record.status === 'clean' &&
    record.state.throughChapterPosition >= throughPosition
  ) {
    return record.state;
  }
  const result = await rebuildStoryMemory(projectId, {
    throughPosition,
    mode: 'auto',
  });
  return result.state;
}
