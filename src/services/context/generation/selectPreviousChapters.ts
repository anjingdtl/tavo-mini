import type { Chapter } from '../../../types/novel';
import { STORY_MEMORY_MAX_RAW_CHAPTERS } from '../../storyMemory/storyMemoryCoverage';

export type PreviousChapterSelectionConfig = {
  strategy?: 'sliding' | 'full' | 'custom';
  recentChapterCount?: number;
  customRangeStart?: number;
  customRangeEnd?: number;
};

/**
 * Pure, bounded chapter selection shared by Collect and the legacy renderer.
 * Keeping this at the generation boundary prevents the collector from
 * importing the orchestration module (and creating a runtime cycle).
 */
export function selectPreviousChapters(
  currentChapter: Chapter,
  config: PreviousChapterSelectionConfig,
  chapters: Chapter[],
): Chapter[] {
  const previous = chapters
    .filter(
      chapter =>
        chapter.position < currentChapter.position && Boolean(chapter.content),
    )
    .sort((a, b) => a.position - b.position);

  if (config.strategy === 'full') return previous;

  if (config.strategy === 'custom') {
    const start = Math.max(0, Number(config.customRangeStart ?? 0));
    const end = Number(config.customRangeEnd ?? -1);
    return previous.filter(
      chapter =>
        chapter.position >= start && (end < 0 || chapter.position <= end),
    );
  }

  const rawRecent = Number(config.recentChapterCount ?? 3);
  const recentCount = Math.min(
    STORY_MEMORY_MAX_RAW_CHAPTERS,
    Math.max(
      1,
      Number.isFinite(rawRecent)
        ? Math.round(rawRecent)
        : STORY_MEMORY_MAX_RAW_CHAPTERS,
    ),
  );
  return previous.slice(-recentCount);
}
