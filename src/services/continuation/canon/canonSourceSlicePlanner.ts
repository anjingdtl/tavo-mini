/**
 * Unified total-source-budget slicer for Canon analysis.
 *
 * All ratios (30% normal / 20%·12% shrink / 15% rescan) mean the **total**
 * original-text token budget for one request, not a per-chapter cap.
 *
 * Consumes chapters in order, may include many full chapters plus one partial
 * trailing chapter, and returns an exact next cursor for uncovered text.
 */
import type { BoundedSourceChapter } from '../types';
import { estimateTokens } from '../../../utils/tokenEstimator';
import {
  estimateTokensPerCharForChapter,
} from './adaptiveBatchPlanner';

export interface SourceCursor {
  chapterId: number;
  /** UTF-16 offset relative to the chapter's full content string. */
  charOffset: number;
}

export interface SourceSliceSegment {
  chapterId: number;
  chapterPosition: number;
  title: string;
  /** Inclusive start offset into the chapter content used for this request. */
  charStart: number;
  /** Exclusive end offset into the chapter content used for this request. */
  charEnd: number;
  content: string;
  /** Absolute book-body UTF-16 start (chapter.range.start + charStart). */
  absoluteBookCharStart: number;
  /** Absolute book-body UTF-16 end exclusive. */
  absoluteBookCharEnd: number;
  /** Original chapter reference (range/id/position preserved for evidence). */
  chapter: BoundedSourceChapter;
}

export interface SourceSliceInput {
  chapters: BoundedSourceChapter[];
  /** Total original-text token budget for this single request. */
  totalTokenBudget: number;
  /** Resume from mid-chapter when non-null. */
  startCursor?: SourceCursor | null;
  /**
   * Optional per-chapter char window already applied (chunk / retry_tail).
   * Keys are chapterId. When set, only that [start, end) of the chapter is
   * eligible; the slicer still consumes the total budget across chapters.
   */
  chapterWindows?: Map<
    number,
    { charStart: number; charEnd: number }
  >;
}

export interface SourceSlicePlan {
  segments: SourceSliceSegment[];
  estimatedTokens: number;
  /** True when every eligible character in the input range is covered. */
  fullyCovered: boolean;
  /** Next unread cursor, or null when fully covered. */
  nextCursor: SourceCursor | null;
}

const MIN_SEGMENT_CHARS = 1;

/**
 * Plan one request's original-text segments under a **total** token budget.
 */
export function planSourceSlice(input: SourceSliceInput): SourceSlicePlan {
  const budget = Math.max(0, Math.floor(input.totalTokenBudget));
  if (budget <= 0 || input.chapters.length === 0) {
    return {
      segments: [],
      estimatedTokens: 0,
      fullyCovered: input.chapters.length === 0,
      nextCursor:
        input.chapters.length === 0
          ? null
          : {
              chapterId: input.chapters[0].id,
              charOffset: input.startCursor?.charOffset ?? 0,
            },
    };
  }

  const segments: SourceSliceSegment[] = [];
  let usedTokens = 0;
  let started = !input.startCursor;
  let nextCursor: SourceCursor | null = null;

  for (let i = 0; i < input.chapters.length; i++) {
    const chapter = input.chapters[i];
    const window = input.chapterWindows?.get(chapter.id);
    const windowStart = window?.charStart ?? 0;
    const windowEnd = window?.charEnd ?? chapter.content.length;
    const safeWindowStart = Math.max(0, Math.min(windowStart, chapter.content.length));
    const safeWindowEnd = Math.max(
      safeWindowStart,
      Math.min(windowEnd, chapter.content.length),
    );

    let localStart = safeWindowStart;
    if (!started) {
      if (chapter.id !== input.startCursor!.chapterId) {
        continue;
      }
      started = true;
      localStart = Math.max(
        safeWindowStart,
        Math.min(input.startCursor!.charOffset, safeWindowEnd),
      );
    }

    if (localStart >= safeWindowEnd) {
      continue;
    }

    const remainingBudget = budget - usedTokens;
    if (remainingBudget <= 0) {
      nextCursor = { chapterId: chapter.id, charOffset: localStart };
      break;
    }

    const headerTokens = estimateTokens(
      `### ${chapter.title} (chapterId=${chapter.id}, position=${chapter.position}, bodyStart=${chapter.range.start}, bodyEnd=${chapter.range.end})\n`,
    );
    const availableForContent = Math.max(0, remainingBudget - headerTokens);
    if (availableForContent <= 0) {
      nextCursor = { chapterId: chapter.id, charOffset: localStart };
      break;
    }

    const remainingChars = safeWindowEnd - localStart;
    const tpc = Math.max(0.15, estimateTokensPerCharForChapter(chapter));
    const maxCharsByBudget = Math.max(
      MIN_SEGMENT_CHARS,
      Math.floor(availableForContent / tpc),
    );
    const takeChars = Math.min(remainingChars, maxCharsByBudget);
    const localEnd = localStart + takeChars;
    // Conservative content token estimate: max of the generic estimator and a
    // length × tokens-per-char product. Long pure-ASCII runs collapse to ~1
    // token under the word-based estimator, which would wrongly claim full
    // coverage under a tiny total budget.
    const estimateContentTokens = (text: string): number =>
      Math.max(estimateTokens(text), Math.ceil(text.length * tpc));
    let finalEnd = localEnd;
    let finalContent = chapter.content.slice(localStart, finalEnd);
    let contentTokens = estimateContentTokens(finalContent);
    while (
      finalEnd > localStart + MIN_SEGMENT_CHARS &&
      headerTokens + contentTokens > remainingBudget
    ) {
      const overshootRatio =
        remainingBudget / Math.max(1, headerTokens + contentTokens);
      const nextLen = Math.max(
        MIN_SEGMENT_CHARS,
        Math.floor((finalEnd - localStart) * overshootRatio * 0.95),
      );
      finalEnd = localStart + nextLen;
      finalContent = chapter.content.slice(localStart, finalEnd);
      contentTokens = estimateContentTokens(finalContent);
    }

    if (finalEnd <= localStart) {
      nextCursor = { chapterId: chapter.id, charOffset: localStart };
      break;
    }

    // When chapter.content is already a chunk window, range.start is still the
    // full-chapter body start and chunkStartChar is the content offset base.
    const contentRelativeStart =
      (chapter as { chunkStartChar?: number }).chunkStartChar != null && !window
        ? (chapter as { chunkStartChar: number }).chunkStartChar + localStart
        : localStart;
    const contentRelativeEnd =
      (chapter as { chunkStartChar?: number }).chunkStartChar != null && !window
        ? (chapter as { chunkStartChar: number }).chunkStartChar + finalEnd
        : finalEnd;

    const absStart = Number(chapter.range.start) + contentRelativeStart;
    const absEnd = Number(chapter.range.start) + contentRelativeEnd;

    segments.push({
      chapterId: chapter.id,
      chapterPosition: Number(chapter.position),
      title: chapter.title,
      charStart: contentRelativeStart,
      charEnd: contentRelativeEnd,
      content: finalContent,
      absoluteBookCharStart: absStart,
      absoluteBookCharEnd: absEnd,
      chapter,
    });
    usedTokens += headerTokens + contentTokens;

    if (finalEnd < safeWindowEnd) {
      nextCursor = { chapterId: chapter.id, charOffset: finalEnd };
      break;
    }
  }

  // If we never found the start cursor chapter, treat as empty partial.
  if (input.startCursor && !started) {
    return {
      segments: [],
      estimatedTokens: 0,
      fullyCovered: false,
      nextCursor: input.startCursor,
    };
  }

  const fullyCovered = nextCursor == null && segments.length > 0
    ? isFullyCovered(input.chapters, segments, input.chapterWindows, input.startCursor)
    : nextCursor == null && (input.chapters.length === 0 || segments.length > 0);

  // Empty segments with remaining text → not fully covered.
  if (segments.length === 0) {
    const first = input.chapters[0];
    return {
      segments: [],
      estimatedTokens: usedTokens,
      fullyCovered: false,
      nextCursor:
        nextCursor ??
        (first
          ? {
              chapterId: first.id,
              charOffset: input.startCursor?.charOffset ?? 0,
            }
          : null),
    };
  }

  return {
    segments,
    estimatedTokens: usedTokens,
    fullyCovered: fullyCovered && nextCursor == null,
    nextCursor,
  };
}

function isFullyCovered(
  chapters: BoundedSourceChapter[],
  segments: SourceSliceSegment[],
  windows: SourceSliceInput['chapterWindows'],
  startCursor?: SourceCursor | null,
): boolean {
  // Walk every eligible char from startCursor; ensure covered by a segment.
  let started = !startCursor;
  for (const chapter of chapters) {
    const window = windows?.get(chapter.id);
    const windowStart = window?.charStart ?? 0;
    const windowEnd = window?.charEnd ?? chapter.content.length;
    let localStart = windowStart;
    if (!started) {
      if (chapter.id !== startCursor!.chapterId) continue;
      started = true;
      localStart = Math.max(windowStart, startCursor!.charOffset);
    }
    if (localStart >= windowEnd) continue;
    const covered = segments.filter(s => s.chapterId === chapter.id);
    if (covered.length === 0) return false;
    // Merge coverage in content-relative offsets.
    const chunkBase =
      (chapter as { chunkStartChar?: number }).chunkStartChar ?? 0;
    let cursor = localStart;
    const sorted = [...covered].sort((a, b) => a.charStart - b.charStart);
    for (const seg of sorted) {
      const segLocalStart =
        chunkBase > 0 && !windows ? seg.charStart - chunkBase : seg.charStart;
      const segLocalEnd =
        chunkBase > 0 && !windows ? seg.charEnd - chunkBase : seg.charEnd;
      if (segLocalStart > cursor) return false;
      cursor = Math.max(cursor, segLocalEnd);
    }
    if (cursor < windowEnd) return false;
  }
  return true;
}

/**
 * Convert a slice plan into BoundedSourceChapter-shaped objects for the
 * existing extractor / materializer paths. Content is the segment text;
 * `chunkStartChar` / `chunkEndChar` carry the absolute-in-chapter offsets so
 * evidence resolution can re-expand to book coordinates.
 */
export function segmentsToBoundedChapters(
  plan: SourceSlicePlan,
): BoundedSourceChapter[] {
  return plan.segments.map(seg => {
    const base = seg.chapter;
    return {
      ...base,
      content: seg.content,
      // Evidence absolute = range.start + chunkStartChar + relative-in-content.
      // We set content as the segment, so chunkStartChar = charStart in full chapter.
      chunkStartChar: seg.charStart,
      chunkEndChar: seg.charEnd,
    } as BoundedSourceChapter & {
      chunkStartChar: number;
      chunkEndChar: number;
    };
  });
}

/**
 * One contiguous remaining tail after a partial extract, used to enqueue at
 * most ONE retry_tail child per parent × material (no per-chapter explosion).
 */
export interface RemainingTailRange {
  /** Chapters from the first incomplete one through the end of the parent slice. */
  chapters: BoundedSourceChapter[];
  /** Exclusive analyzed end within the first chapter's full content (0 = whole first chapter still open). */
  firstChapterCharStart: number;
  /** Exclusive end within the last chapter's full content. */
  lastChapterCharEnd: number;
  startPosition: number;
  endPosition: number;
  firstChapterId: number;
}

/**
 * Build a single remaining-tail descriptor from per-chapter analyzed ends
 * (aligned with `chapters` order; ends are relative to each chapter's
 * `content` as passed into the extractor, i.e. already window-relative when
 * the chapter was pre-sliced).
 *
 * Returns null when everything is fully covered.
 */
export function remainingTailFromAnalyzedEnds(
  chapters: BoundedSourceChapter[],
  analyzedCharEnds: number[],
): RemainingTailRange | null {
  if (chapters.length === 0) return null;

  let firstIdx = -1;
  let firstCharStart = 0;
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    const baseStart =
      typeof (ch as { chunkStartChar?: number }).chunkStartChar === 'number'
        ? (ch as { chunkStartChar: number }).chunkStartChar
        : 0;
    const contentLen = ch.content.length;
    const analyzedRel = analyzedCharEnds[i] ?? contentLen;
    if (analyzedRel < contentLen) {
      firstIdx = i;
      // Persist absolute-in-full-chapter start when content was a window slice.
      firstCharStart = baseStart + Math.max(0, analyzedRel);
      break;
    }
  }
  if (firstIdx < 0) return null;

  const tailChapters = chapters.slice(firstIdx);
  const last = tailChapters[tailChapters.length - 1];
  const lastBase =
    typeof (last as { chunkStartChar?: number }).chunkStartChar === 'number'
      ? (last as { chunkStartChar: number }).chunkStartChar
      : 0;
  const lastChapterCharEnd = lastBase + last.content.length;
  const first = tailChapters[0];

  return {
    chapters: tailChapters,
    firstChapterCharStart: firstCharStart,
    lastChapterCharEnd,
    startPosition: Number(first.position),
    endPosition: Number(last.position) + 1,
    firstChapterId: first.id,
  };
}

/**
 * Apply a stored multi-chapter retry_tail window onto chapters loaded by
 * position range: trim first chapter from firstChapterCharStart, last chapter
 * to lastChapterCharEnd (full-chapter coordinates).
 */
export function applyRetryTailWindow(
  chapters: BoundedSourceChapter[],
  opts: {
    firstChapterCharStart: number | null;
    lastChapterCharEnd: number | null;
  },
): BoundedSourceChapter[] {
  if (chapters.length === 0) return chapters;
  const out = chapters.map(ch => ({ ...ch }));
  const first = out[0];
  const firstStart = opts.firstChapterCharStart ?? 0;
  if (firstStart > 0 && firstStart < first.content.length) {
    out[0] = {
      ...first,
      content: first.content.slice(firstStart),
      chunkStartChar: firstStart,
      chunkEndChar: first.content.length,
    } as BoundedSourceChapter & { chunkStartChar: number; chunkEndChar: number };
  } else if (firstStart >= first.content.length) {
    // Degenerate: start at/after end of first chapter — drop it.
    return applyRetryTailWindow(out.slice(1), {
      firstChapterCharStart: 0,
      lastChapterCharEnd: opts.lastChapterCharEnd,
    });
  }

  if (out.length === 1) {
    const only = out[0];
    const base =
      typeof (only as { chunkStartChar?: number }).chunkStartChar === 'number'
        ? (only as { chunkStartChar: number }).chunkStartChar
        : 0;
    const absEnd =
      opts.lastChapterCharEnd != null
        ? opts.lastChapterCharEnd
        : base + only.content.length;
    // only.content is already relative to base when chunkStartChar set.
    const relEnd = Math.max(0, Math.min(only.content.length, absEnd - base));
    if (relEnd < only.content.length) {
      out[0] = {
        ...only,
        content: only.content.slice(0, relEnd),
        chunkStartChar: base,
        chunkEndChar: base + relEnd,
      } as BoundedSourceChapter & {
        chunkStartChar: number;
        chunkEndChar: number;
      };
    }
    return out;
  }

  const last = out[out.length - 1];
  if (opts.lastChapterCharEnd != null && opts.lastChapterCharEnd < last.content.length) {
    const end = Math.max(0, opts.lastChapterCharEnd);
    out[out.length - 1] = {
      ...last,
      content: last.content.slice(0, end),
      chunkStartChar: 0,
      chunkEndChar: end,
    } as BoundedSourceChapter & { chunkStartChar: number; chunkEndChar: number };
  }
  return out;
}

/**
 * Compute uncovered tail ranges per chapter after a partial analysis.
 * `analyzedEnds` is a map chapterId → exclusive char end that was analysed
 * (in full-chapter coordinates).
 */
export function uncoveredTails(input: {
  chapters: BoundedSourceChapter[];
  analyzedEndsByChapterId: Map<number, number>;
  chapterWindows?: Map<number, { charStart: number; charEnd: number }>;
}): Array<{
  chapter: BoundedSourceChapter;
  charStart: number;
  charEnd: number;
}> {
  const out: Array<{
    chapter: BoundedSourceChapter;
    charStart: number;
    charEnd: number;
  }> = [];
  for (const chapter of input.chapters) {
    const window = input.chapterWindows?.get(chapter.id);
    const windowStart = window?.charStart ?? 0;
    const windowEnd = window?.charEnd ?? chapter.content.length;
    const analyzedEnd = input.analyzedEndsByChapterId.get(chapter.id);
    if (analyzedEnd == null) {
      if (windowEnd > windowStart) {
        out.push({ chapter, charStart: windowStart, charEnd: windowEnd });
      }
      continue;
    }
    const tailStart = Math.max(windowStart, analyzedEnd);
    if (tailStart < windowEnd) {
      out.push({ chapter, charStart: tailStart, charEnd: windowEnd });
    }
  }
  return out;
}

/**
 * Total estimated tokens for segments (content + headers). Useful for tests
 * asserting 20%/12%/15% reductions.
 */
export function estimateSegmentsTokens(segments: SourceSliceSegment[]): number {
  let total = 0;
  for (const seg of segments) {
    total += estimateTokens(
      `### ${seg.title} (chapterId=${seg.chapterId}, position=${seg.chapterPosition})\n${seg.content}`,
    );
  }
  return total;
}
