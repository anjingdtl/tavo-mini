/**
 * Unified total-budget slicer: 30%/20%/12%/15% are request totals, not per-chapter caps.
 */
import {
  planSourceSlice,
  estimateSegmentsTokens,
  segmentsToBoundedChapters,
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

describe('canonSourceSlicePlanner total budget', () => {
  it('packs multiple short chapters under a total budget', () => {
    const chapters = Array.from({ length: 10 }, (_, i) =>
      ch(i + 1, '甲'.repeat(1000), i, i * 1000),
    );
    const plan = planSourceSlice({
      chapters,
      totalTokenBudget: 3500, // ~3.5 full chapters of CJK
    });
    expect(plan.segments.length).toBeGreaterThanOrEqual(2);
    expect(plan.segments.length).toBeLessThan(10);
    expect(plan.fullyCovered).toBe(false);
    expect(plan.nextCursor).not.toBeNull();
  });

  it('reduces total input when budget shrinks 30% → 20% → 12%', () => {
    const chapters = Array.from({ length: 8 }, (_, i) =>
      ch(i + 1, '乙'.repeat(3000), i, i * 3000),
    );
    const b30 = planSourceSlice({ chapters, totalTokenBudget: 9000 });
    const b20 = planSourceSlice({ chapters, totalTokenBudget: 6000 });
    const b12 = planSourceSlice({ chapters, totalTokenBudget: 3600 });
    const t30 = estimateSegmentsTokens(b30.segments);
    const t20 = estimateSegmentsTokens(b20.segments);
    const t12 = estimateSegmentsTokens(b12.segments);
    expect(t20).toBeLessThan(t30);
    expect(t12).toBeLessThan(t20);
  });

  it('supports mid-chapter resume without overlap or gap', () => {
    const chapter = ch(1, '丙'.repeat(5000));
    const first = planSourceSlice({
      chapters: [chapter],
      totalTokenBudget: 1500,
    });
    expect(first.fullyCovered).toBe(false);
    expect(first.nextCursor).not.toBeNull();
    const second = planSourceSlice({
      chapters: [chapter],
      totalTokenBudget: 1500,
      startCursor: first.nextCursor,
    });
    const end1 = first.segments[0].charEnd;
    const start2 = second.segments[0].charStart;
    expect(start2).toBe(end1);
  });

  it('marks fullyCovered when budget fits all text', () => {
    const chapters = [ch(1, '丁'.repeat(50)), ch(2, '戊'.repeat(50))];
    const plan = planSourceSlice({ chapters, totalTokenBudget: 10_000 });
    expect(plan.fullyCovered).toBe(true);
    expect(plan.nextCursor).toBeNull();
    expect(plan.segments).toHaveLength(2);
  });

  it('segmentsToBoundedChapters preserve chapter id and chunk offsets', () => {
    const chapters = [ch(7, '己'.repeat(2000))];
    const plan = planSourceSlice({ chapters, totalTokenBudget: 400 });
    const bounded = segmentsToBoundedChapters(plan);
    expect(bounded[0].id).toBe(7);
    expect(
      (bounded[0] as { chunkStartChar?: number }).chunkStartChar,
    ).toBeDefined();
  });

  it('never uses per-chapter independent caps (regression)', () => {
    // 10 chapters each under a naive per-chapter 3000-char cap would all pass
    // fully; total-budget of 2500 tokens must NOT cover all chapters.
    const chapters = Array.from({ length: 10 }, (_, i) =>
      ch(i + 1, '庚'.repeat(2000), i, i * 2000),
    );
    const plan = planSourceSlice({ chapters, totalTokenBudget: 2500 });
    expect(plan.fullyCovered).toBe(false);
    expect(plan.segments.length).toBeLessThan(10);
  });
});
