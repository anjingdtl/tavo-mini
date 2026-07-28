import type { BoundedSourceChapter } from '../types';
import type { AnalysisScope, AnalyzedChapterRange } from './types';

export const FAST_CONTINUATION_TAIL_CHAPTER_COUNT = 30;
const MIN_TAIL_CHAPTER_COUNT = 1;
const MAX_TAIL_CHAPTER_COUNT = 120;

export const FULL_ANALYSIS_SCOPE: AnalysisScope = {
  schemaVersion: 1,
  kind: 'full',
  tailChapterCount: null,
};

export const FAST_CONTINUATION_SCOPE: AnalysisScope = {
  schemaVersion: 1,
  kind: 'tail',
  tailChapterCount: FAST_CONTINUATION_TAIL_CHAPTER_COUNT,
};

export interface AnalysisScopePlan {
  effectiveScope: AnalysisScope;
  nearChapters: BoundedSourceChapter[];
  historicalChapters: BoundedSourceChapter[];
  analyzedRanges: AnalyzedChapterRange[];
}

function clampTailChapterCount(value: number | null): number {
  const candidate = Number.isFinite(value) ? Math.floor(value as number) : 0;
  return Math.min(
    MAX_TAIL_CHAPTER_COUNT,
    Math.max(
      MIN_TAIL_CHAPTER_COUNT,
      candidate || FAST_CONTINUATION_TAIL_CHAPTER_COUNT,
    ),
  );
}

/** Normalize untrusted/legacy checkpoint scope without reading source data. */
export function normalizeAnalysisScope(
  scope?: AnalysisScope | null,
): AnalysisScope {
  if (!scope || scope.kind === 'full') return FULL_ANALYSIS_SCOPE;
  return {
    schemaVersion: 1,
    kind: scope.kind === 'adaptive' ? 'adaptive' : 'tail',
    tailChapterCount: clampTailChapterCount(scope.tailChapterCount),
  };
}

/**
 * Select the chapters eligible for LLM Canon extraction. SourceReader has
 * already enforced the continuation boundary before this pure planner runs.
 */
export function planAnalysisScope(
  chapters: BoundedSourceChapter[],
  scope?: AnalysisScope | null,
): AnalysisScopePlan {
  const effectiveScope = normalizeAnalysisScope(scope);
  const nearChapters =
    effectiveScope.kind === 'full'
      ? chapters
      : chapters.slice(-(effectiveScope.tailChapterCount || 0));
  const historicalChapters = chapters.slice(
    0,
    chapters.length - nearChapters.length,
  );
  const analyzedRanges =
    nearChapters.length === 0
      ? []
      : [
          {
            startPosition: nearChapters[0].position,
            endPosition: (nearChapters[nearChapters.length - 1].position +
              1) as (typeof nearChapters)[number]['position'],
          },
        ];
  return { effectiveScope, nearChapters, historicalChapters, analyzedRanges };
}
