import type { ContinuationChapterPosition } from '../../../types/novel';

export interface ContinuationAnchorChapter {
  id: number;
  position: ContinuationChapterPosition;
  content: string | null | undefined;
  title?: string | null;
}

export interface ContinuationSourceSeam {
  summary: string;
  excerpt: string;
}

export interface ContinuationAnchor {
  kind: 'source_seam' | 'continuation_chapter';
  summary: string;
  excerpt: string;
  chapterId: number | null;
  position: ContinuationChapterPosition | null;
}

/**
 * Select the one正文接缝 for a continuation run.
 *
 * The caller may provide an already sorted list, but sorting here keeps the
 * invariant stable for callers/tests that receive holes or duplicate
 * positions from an interrupted edit flow.
 */
export function selectContinuationAnchor(input: {
  targetPosition: ContinuationChapterPosition;
  priorChapters: ContinuationAnchorChapter[];
  sourceSeam: ContinuationSourceSeam;
}): ContinuationAnchor {
  const chapter = input.priorChapters
    .filter(
      item =>
        item.position < input.targetPosition &&
        Boolean(String(item.content ?? '').trim()),
    )
    .sort((a, b) => b.position - a.position || b.id - a.id)[0];

  if (chapter) {
    return {
      kind: 'continuation_chapter',
      summary: `续写章节「${chapter.title || `position=${chapter.position}`}」`,
      excerpt: String(chapter.content ?? ''),
      chapterId: chapter.id,
      position: chapter.position,
    };
  }

  return {
    kind: 'source_seam',
    summary: input.sourceSeam.summary,
    excerpt: input.sourceSeam.excerpt,
    chapterId: null,
    position: null,
  };
}
