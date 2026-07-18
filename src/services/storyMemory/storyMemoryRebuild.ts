import type { Chapter } from '../../types/novel';
import { invalidateIdf } from '../../utils/idfCache';
import * as db from '../database';
import { createEmptyStoryMemory } from './storyMemoryDefaults';
import {
  fingerprintChapterSource,
  fingerprintStoryMemoryState,
} from './storyMemoryFingerprint';
import { applyStoryMemoryPatch } from './storyMemoryMerger';
import {
  generateValidatedChapterMemoryPatch,
  renderEpisodicMemoryText,
  withProjectMemoryLock,
} from './storyMemoryService';
import type { StoryMemoryState } from './storyMemoryTypes';
import { StoryMemoryError } from './storyMemoryTypes';

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
  return withProjectMemoryLock(projectId, async () => {
    const allChapters = (await db.getChaptersByProject(projectId)).filter(
      chapter =>
        chapter.content.trim() || chapter.memory_summary?.trim() || chapter.summary_json,
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
    const requestedStart =
      options.fromPosition ??
      record.dirtyFromPosition ??
      Math.max(0, record.state.throughChapterPosition + 1);
    let state: StoryMemoryState;
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
      replayStart = snapshot
        ? snapshot.state.throughChapterPosition + 1
        : 0;
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
      emitProgress(options, { ...baseProgress(), currentPosition: chapter.position });
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
        throw new StoryMemoryError(
          'MEMORY_REBUILD_FAILED',
          `第 ${chapter.position + 1} 章故事记忆重建失败：${message}`,
        );
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
  });
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
