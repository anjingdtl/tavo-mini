import type { Chapter } from '../../types/novel';
import type { BatchEvidenceQuote } from './storyMemoryTypes';

export interface StoryMemoryEvidenceAnchor {
  id: string;
  chapterHandle: string;
  chapterId: number;
  chapterPosition: number;
  /** JavaScript UTF-16 offsets, suitable for String.prototype.slice. */
  startOffset: number;
  endOffset: number;
  text: string;
}

export interface StoryMemoryEvidenceEnvelope {
  anchors: StoryMemoryEvidenceAnchor[];
  byId: Map<string, StoryMemoryEvidenceAnchor>;
}

interface TextRange {
  start: number;
  end: number;
}

const MAX_ANCHOR_CODE_POINTS = 80;
const MIN_ANCHOR_CODE_POINTS = 4;
const SENTENCE_END = new Set(['。', '！', '？', '!', '?', '；', ';']);
const SECONDARY_END = new Set(['，', ',', '：', ':']);

function codePointBoundaries(text: string): number[] {
  const boundaries = [0];
  let offset = 0;
  for (const character of text) {
    offset += character.length;
    boundaries.push(offset);
  }
  return boundaries;
}

function codePointLength(text: string): number {
  return Array.from(text).length;
}

function trimRange(text: string, range: TextRange): TextRange | null {
  let start = range.start;
  let end = range.end;
  while (start < end && /\s/u.test(text[start] || '')) start += 1;
  while (end > start && /\s/u.test(text[end - 1] || '')) end -= 1;
  return start < end ? { start, end } : null;
}

function splitLongRange(text: string, range: TextRange): TextRange[] {
  const boundaries = codePointBoundaries(text.slice(range.start, range.end)).map(
    offset => offset + range.start,
  );
  const total = boundaries.length - 1;
  if (total <= MAX_ANCHOR_CODE_POINTS) return [range];

  const ranges: TextRange[] = [];
  let segmentStartIndex = 0;
  while (segmentStartIndex < total) {
    const hardEndIndex = Math.min(
      total,
      segmentStartIndex + MAX_ANCHOR_CODE_POINTS,
    );
    let cutIndex = hardEndIndex;
    // Prefer a natural comma/colon boundary within the next 80 code points.
    for (let index = hardEndIndex - 1; index > segmentStartIndex; index -= 1) {
      const character = text[boundaries[index] - 1];
      if (SECONDARY_END.has(character)) {
        cutIndex = index;
        break;
      }
    }
    if (cutIndex <= segmentStartIndex) cutIndex = hardEndIndex;
    ranges.push({
      start: boundaries[segmentStartIndex],
      end: boundaries[cutIndex],
    });
    segmentStartIndex = cutIndex;
  }
  return ranges;
}

function sentenceRanges(text: string, start: number, end: number): TextRange[] {
  const ranges: TextRange[] = [];
  let cursor = start;
  for (let index = start; index < end; index += 1) {
    if (!SENTENCE_END.has(text[index])) continue;
    ranges.push({ start: cursor, end: index + 1 });
    cursor = index + 1;
  }
  if (cursor < end) ranges.push({ start: cursor, end });
  return ranges;
}

function mergeShortRanges(text: string, ranges: TextRange[]): TextRange[] {
  const merged: TextRange[] = [];
  let pending: TextRange | null = null;
  for (const range of ranges) {
    const current = trimRange(text, range);
    if (!current) continue;
    if (!pending) {
      pending = current;
    } else if (
      codePointLength(text.slice(pending.start, current.end)) <=
      MAX_ANCHOR_CODE_POINTS
    ) {
      pending = { start: pending.start, end: current.end };
    } else {
      if (codePointLength(text.slice(pending.start, pending.end)) >= MIN_ANCHOR_CODE_POINTS) {
        merged.push(pending);
      }
      pending = current;
    }
    if (
      pending &&
      codePointLength(text.slice(pending.start, pending.end)) >=
        MIN_ANCHOR_CODE_POINTS
    ) {
      merged.push(pending);
      pending = null;
    }
  }
  if (pending) {
    const pendingLength = codePointLength(text.slice(pending.start, pending.end));
    if (pendingLength >= MIN_ANCHOR_CODE_POINTS) {
      merged.push(pending);
    } else if (merged.length > 0) {
      const previous = merged[merged.length - 1];
      const combined = { start: previous.start, end: pending.end };
      if (codePointLength(text.slice(combined.start, combined.end)) <= MAX_ANCHOR_CODE_POINTS) {
        merged[merged.length - 1] = combined;
      }
    }
  }
  return merged;
}

function paragraphRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  const paragraphPattern = /[^\r\n]+/gu;
  for (const match of text.matchAll(paragraphPattern)) {
    const paragraph = match[0];
    const start = match.index ?? 0;
    const end = start + paragraph.length;
    const sentence = sentenceRanges(text, start, end);
    const merged = mergeShortRanges(text, sentence);
    for (const range of merged) ranges.push(...splitLongRange(text, range));
  }
  return ranges
    .map(range => trimRange(text, range))
    .filter((range): range is TextRange => Boolean(range))
    .filter(range => {
      const length = codePointLength(text.slice(range.start, range.end));
      return length >= MIN_ANCHOR_CODE_POINTS && length <= MAX_ANCHOR_CODE_POINTS;
    });
}

export function buildStoryMemoryEvidenceAnchors(
  chapters: Array<Pick<Chapter, 'id' | 'position' | 'content'>>,
  chapterHandleById?: ReadonlyMap<number, string>,
): StoryMemoryEvidenceEnvelope {
  const anchors: StoryMemoryEvidenceAnchor[] = [];
  const ordered = [...chapters].sort((left, right) => left.position - right.position);
  for (const chapter of ordered) {
    const ranges = paragraphRanges(chapter.content || '');
    for (const range of ranges) {
      anchors.push({
        id: '',
        chapterHandle:
          chapterHandleById?.get(chapter.id) ||
          `CH${String(chapter.position + 1).padStart(2, '0')}`,
        chapterId: chapter.id,
        chapterPosition: chapter.position,
        startOffset: range.start,
        endOffset: range.end,
        text: chapter.content.slice(range.start, range.end),
      });
    }
  }
  anchors.forEach((anchor, index) => {
    anchor.id = `Q${String(index + 1).padStart(3, '0')}`;
  });
  return { anchors, byId: new Map(anchors.map(anchor => [anchor.id, anchor])) };
}

/**
 * Resolve model-returned anchor IDs into the exact source text. Any unknown
 * ID, or any ID belonging to a different chapter than the observation's CH,
 * invalidates the whole observation. Callers then locally drop it without
 * rejecting the surrounding batch.
 */
export function resolveObservationEvidence(
  ids: string[],
  envelope: StoryMemoryEvidenceEnvelope,
  expectedChapterId?: number,
): BatchEvidenceQuote[] {
  const uniqueIds = [...new Set(ids.map(value => String(value || '').trim()))].filter(Boolean);
  if (uniqueIds.some(id => !envelope.byId.has(id))) return [];
  if (
    expectedChapterId != null &&
    uniqueIds.some(id => envelope.byId.get(id)!.chapterId !== expectedChapterId)
  ) {
    return [];
  }
  return uniqueIds.slice(0, 3).map(id => {
    const anchor = envelope.byId.get(id)!;
    return { chapterId: anchor.chapterId, quote: anchor.text };
  });
}

export function isValidEvidenceAnchorId(
  id: string,
  envelope: StoryMemoryEvidenceEnvelope,
): boolean {
  return envelope.byId.has(id);
}

export function isExactEvidenceSubstring(
  source: string,
  anchor: StoryMemoryEvidenceAnchor,
): boolean {
  return source.slice(anchor.startOffset, anchor.endOffset) === anchor.text;
}
