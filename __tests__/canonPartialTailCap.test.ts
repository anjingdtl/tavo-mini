/**
 * Partial shrink must not explode into N per-chapter retry_tail batches.
 * Each parent × material gets at most ONE packed remaining-tail child.
 */
import {
  remainingTailFromAnalyzedEnds,
  applyRetryTailWindow,
  planSourceSlice,
} from '../src/services/continuation/canon/canonSourceSlicePlanner';
import {
  asSourcePosition,
  asUtf16Offset,
} from '../src/services/continuation/continuationSourceRepository';
import type { BoundedSourceChapter } from '../src/services/continuation/types';

function ch(
  id: number,
  content: string,
  position = id - 1,
  rangeStart = 0,
): BoundedSourceChapter {
  return {
    id,
    sourceId: 1,
    position: asSourcePosition(position),
    title: `第${id}章`,
    content,
    range: {
      start: asUtf16Offset(rangeStart),
      end: asUtf16Offset(rangeStart + content.length),
    },
    clippedByBoundary: false,
  };
}

describe('partial tail cap helpers', () => {
  it('remainingTailFromAnalyzedEnds collapses multi-chapter remainder into one range', () => {
    const chapters = [
      ch(1, '甲'.repeat(100), 0, 0),
      ch(2, '乙'.repeat(100), 1, 100),
      ch(3, '丙'.repeat(100), 2, 200),
      ch(4, '丁'.repeat(100), 3, 300),
    ];
    // Only first chapter half-analysed; rest untouched (analyzedEnd 0).
    const ends = [50, 0, 0, 0];
    const tail = remainingTailFromAnalyzedEnds(chapters, ends);
    expect(tail).not.toBeNull();
    expect(tail!.chapters).toHaveLength(4);
    expect(tail!.firstChapterId).toBe(1);
    expect(tail!.firstChapterCharStart).toBe(50);
    expect(tail!.startPosition).toBe(0);
    expect(tail!.endPosition).toBe(4);
    expect(tail!.lastChapterCharEnd).toBe(100);
  });

  it('remainingTailFromAnalyzedEnds returns null when fully covered', () => {
    const chapters = [ch(1, '甲'.repeat(20)), ch(2, '乙'.repeat(20))];
    expect(
      remainingTailFromAnalyzedEnds(chapters, [20, 20]),
    ).toBeNull();
  });

  it('applyRetryTailWindow trims first chapter mid-content for multi-chapter pack', () => {
    const chapters = [
      ch(1, '0123456789', 0, 0),
      ch(2, 'abcdefghij', 1, 10),
    ];
    const trimmed = applyRetryTailWindow(chapters, {
      firstChapterCharStart: 5,
      lastChapterCharEnd: 10,
    });
    expect(trimmed).toHaveLength(2);
    expect(trimmed[0].content).toBe('56789');
    expect(
      (trimmed[0] as { chunkStartChar?: number }).chunkStartChar,
    ).toBe(5);
    expect(trimmed[1].content).toBe('abcdefghij');
  });

  it('packing remaining tail under 30% budget uses few slices not one-per-chapter', () => {
    // 30 short chapters; after analysing none, pack with modest budget.
    const chapters = Array.from({ length: 30 }, (_, i) =>
      ch(i + 1, '字'.repeat(200), i, i * 200),
    );
    const ends = chapters.map(() => 0);
    const tail = remainingTailFromAnalyzedEnds(chapters, ends)!;
    let cursor: { chapterId: number; charOffset: number } | null = {
      chapterId: tail.firstChapterId,
      charOffset: tail.firstChapterCharStart,
    };
    let packs = 0;
    const maxPacks = 20;
    while (packs < maxPacks && cursor) {
      const plan = planSourceSlice({
        chapters: tail.chapters,
        totalTokenBudget: 800,
        startCursor: cursor,
      });
      expect(plan.segments.length).toBeGreaterThan(0);
      packs += 1;
      cursor = plan.nextCursor;
    }
    // Should finish in far fewer packs than 30 chapters.
    expect(packs).toBeLessThan(30);
    expect(packs).toBeGreaterThanOrEqual(1);
    expect(cursor).toBeNull();
  });
});
