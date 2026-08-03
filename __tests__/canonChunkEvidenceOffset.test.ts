/**
 * Bug #1: oversized-chapter chunk evidence absolute-offset correctness.
 *
 * When a chapter is larger than the 30% source-chunk target it is split into
 * chunk batches. The chunk batch's chapter object has `content =
 * originalContent.slice(chunkStartChar, chunkEndChar)` but retains the original
 * `range.start`. Evidence resolution must compute:
 *
 *   absoluteCharStart = range.start + chunkStartChar + localMatchIndex
 *
 * Previously `chunkStartChar` was never added, so evidence in the 2nd+ chunk
 * of an oversized chapter was offset by exactly `chunkStartChar` too low.
 */
import { resolveExtractionEvidenceAgainstChapters } from '../src/services/continuation/canon/canonAnalysisService';
import {
  asSourcePosition,
  asUtf16Offset,
} from '../src/services/continuation/continuationSourceRepository';
import type { BoundedSourceChapter } from '../src/services/continuation/types';

/**
 * Build a chapter whose content is deliberately sliced to a chunk window, the
 * same way `processAnalysisRunInner` produces chunk batches. `range.start` is
 * the ORIGINAL chapter's book-absolute offset (unchanged by slicing).
 */
function makeChunkedChapter(input: {
  id: number;
  position: number;
  title: string;
  fullContent: string;
  rangeStart: number;
  chunkStartChar: number;
  chunkEndChar: number;
}): BoundedSourceChapter {
  return {
    id: input.id,
    sourceId: 1,
    position: asSourcePosition(input.position),
    title: input.title,
    content: input.fullContent.slice(input.chunkStartChar, input.chunkEndChar),
    range: {
      start: asUtf16Offset(input.rangeStart),
      end: asUtf16Offset(input.rangeStart + input.fullContent.length),
    },
    clippedByBoundary: false,
    chunkStartChar: input.chunkStartChar,
    chunkEndChar: input.chunkEndChar,
  };
}

describe('Bug #1: oversized-chapter chunk evidence absolute offsets', () => {
  // Three explicit 1000-char chunks. Each has padding + a unique marker near
  // its middle so local offsets are deterministic.
  //   chunk0 [0,1000):    'A'*494 + 'M0MARKER' + 'A'*498  → marker at idx 494
  //   chunk1 [1000,2000): 'B'*494 + 'M1MARKER' + 'B'*498  → marker at idx 494
  //   chunk2 [2000,3000): 'C'*494 + 'M2MARKER' + 'C'*498  → marker at idx 494
  const MARKER0 = 'M0MARKER'; // len 8
  const MARKER1 = 'M1MARKER';
  const MARKER2 = 'M2MARKER';
  const fullContent =
    'A'.repeat(494) + MARKER0 + 'A'.repeat(498) +
    'B'.repeat(494) + MARKER1 + 'B'.repeat(498) +
    'C'.repeat(494) + MARKER2 + 'C'.repeat(498);
  const rangeStart = 5000;
  const localMarkerIdx = 494;

  it('chunk 0 (chunkStartChar=0): evidence offset == range.start + localIndex', () => {
    const chunk0 = makeChunkedChapter({
      id: 1,
      position: 0,
      title: 'ch',
      fullContent,
      rangeStart,
      chunkStartChar: 0,
      chunkEndChar: 1000,
    });
    const result = resolveExtractionEvidenceAgainstChapters(
      {
        schemaVersion: 1,
        worldRules: [
          {
            category: 'fundamental',
            title: 'rule0',
            description: 'd',
            constraintLevel: 'hard',
            confidence: 0.9,
            evidence: [
              {
                chapterId: 1,
                chapterPosition: 0,
                charStart: 0,
                charEnd: 0,
                quotePreview: MARKER0,
              },
            ],
          },
        ],
        characters: [],
        relationships: [],
        plotThreads: [],
        experiences: [],
        knowledge: [],
        states: [],
        timelineEvents: [],
      },
      [chunk0],
    );
    const ev = result.result.worldRules[0].evidence[0];
    // absolute = rangeStart + 0 + localMarkerIdx
    expect(ev.charStart).toBe(rangeStart + 0 + localMarkerIdx);
    expect(ev.charEnd).toBe(rangeStart + 0 + localMarkerIdx + MARKER0.length);
  });

  it('chunk 1 (chunkStartChar=1000): evidence offset includes chunkStartChar', () => {
    const chunk1 = makeChunkedChapter({
      id: 1,
      position: 0,
      title: 'ch',
      fullContent,
      rangeStart,
      chunkStartChar: 1000,
      chunkEndChar: 2000,
    });
    const result = resolveExtractionEvidenceAgainstChapters(
      {
        schemaVersion: 1,
        worldRules: [
          {
            category: 'fundamental',
            title: 'rule1',
            description: 'd',
            constraintLevel: 'hard',
            confidence: 0.9,
            evidence: [
              {
                chapterId: 1,
                chapterPosition: 0,
                charStart: 0,
                charEnd: 0,
                quotePreview: MARKER1,
              },
            ],
          },
        ],
        characters: [],
        relationships: [],
        plotThreads: [],
        experiences: [],
        knowledge: [],
        states: [],
        timelineEvents: [],
      },
      [chunk1],
    );
    const ev = result.result.worldRules[0].evidence[0];
    // absolute = rangeStart + 1000 + localMarkerIdx
    expect(ev.charStart).toBe(rangeStart + 1000 + localMarkerIdx);
    expect(ev.charEnd).toBe(rangeStart + 1000 + localMarkerIdx + MARKER1.length);
    // The WRONG (pre-fix) value would be rangeStart + localMarkerIdx.
    expect(ev.charStart).toBe(rangeStart + 1000 + localMarkerIdx);
  });

  it('chunk 2 (chunkStartChar=2000): evidence offset includes chunkStartChar', () => {
    const chunk2 = makeChunkedChapter({
      id: 1,
      position: 0,
      title: 'ch',
      fullContent,
      rangeStart,
      chunkStartChar: 2000,
      chunkEndChar: 3000,
    });
    const result = resolveExtractionEvidenceAgainstChapters(
      {
        schemaVersion: 1,
        worldRules: [
          {
            category: 'fundamental',
            title: 'rule2',
            description: 'd',
            constraintLevel: 'hard',
            confidence: 0.9,
            evidence: [
              {
                chapterId: 1,
                chapterPosition: 0,
                charStart: 0,
                charEnd: 0,
                quotePreview: MARKER2,
              },
            ],
          },
        ],
        characters: [],
        relationships: [],
        plotThreads: [],
        experiences: [],
        knowledge: [],
        states: [],
        timelineEvents: [],
      },
      [chunk2],
    );
    const ev = result.result.worldRules[0].evidence[0];
    expect(ev.charStart).toBe(rangeStart + 2000 + localMarkerIdx);
    expect(ev.charEnd).toBe(rangeStart + 2000 + localMarkerIdx + MARKER2.length);
  });

  it('whole-chapter (no chunk fields): offset == range.start + localIndex (unchanged)', () => {
    const whole: BoundedSourceChapter = {
      id: 2,
      sourceId: 1,
      position: asSourcePosition(1),
      title: 'ch2',
      content: 'XYZUNIQUE线索在这里',
      range: {
        start: asUtf16Offset(9000),
        end: asUtf16Offset(9000 + 12),
      },
      clippedByBoundary: false,
    };
    const result = resolveExtractionEvidenceAgainstChapters(
      {
        schemaVersion: 1,
        worldRules: [
          {
            category: 'fundamental',
            title: 'r',
            description: 'd',
            constraintLevel: 'hard',
            confidence: 0.9,
            evidence: [
              {
                chapterId: 2,
                chapterPosition: 1,
                charStart: 0,
                charEnd: 0,
                quotePreview: '线索',
              },
            ],
          },
        ],
        characters: [],
        relationships: [],
        plotThreads: [],
        experiences: [],
        knowledge: [],
        states: [],
        timelineEvents: [],
      },
      [whole],
    );
    const ev = result.result.worldRules[0].evidence[0];
    // '线索' is at local index 9; no chunk offset → absolute = 9000 + 9.
    expect(ev.charStart).toBe(9000 + 9);
    expect(ev.charEnd).toBe(9000 + 9 + 2);
  });
});
