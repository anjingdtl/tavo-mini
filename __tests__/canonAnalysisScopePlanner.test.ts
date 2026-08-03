import {
  FAST_CONTINUATION_SCOPE,
  planAnalysisScope,
} from '../src/services/continuation/canon/analysisScopePlanner';
import {
  asSourcePosition,
  asUtf16Offset,
} from '../src/services/continuation/continuationSourceRepository';

function chapter(position: number) {
  return {
    id: position + 1,
    sourceId: 1,
    position: asSourcePosition(position),
    title: `第${position + 1}章`,
    content: `正文${position + 1}`,
    range: {
      start: asUtf16Offset(position * 10),
      end: asUtf16Offset(position * 10 + 5),
    },
    clippedByBoundary: false,
  };
}

describe('Canon analysis scope planner', () => {
  it('keeps only the most recent 10 bounded chapters for fast continuation', () => {
    const plan = planAnalysisScope(
      Array.from({ length: 80 }, (_, index) => chapter(index)),
      FAST_CONTINUATION_SCOPE,
    );

    expect(plan.nearChapters).toHaveLength(10);
    expect(plan.nearChapters[0].position).toBe(70);
    expect(plan.nearChapters.at(-1)?.position).toBe(79);
    expect(plan.historicalChapters).toHaveLength(70);
    expect(plan.analyzedRanges).toEqual([
      { startPosition: 70, endPosition: 80 },
    ]);
  });

  it('uses all available chapters when the source is shorter than the fast window', () => {
    const plan = planAnalysisScope(
      Array.from({ length: 4 }, (_, index) => chapter(index)),
      FAST_CONTINUATION_SCOPE,
    );

    expect(plan.nearChapters).toHaveLength(4);
    expect(plan.historicalChapters).toHaveLength(0);
    expect(plan.analyzedRanges).toEqual([{ startPosition: 0, endPosition: 4 }]);
  });

  it('does not widen the quick window to fill a 30% batch budget (no 11th chapter)', () => {
    // A source with exactly 25 chapters must still select only the last 10,
    // never the last 11 to "fill" a token target. Chunking happens inside the
    // 10 selected chapters, never by reaching further back.
    const plan = planAnalysisScope(
      Array.from({ length: 25 }, (_, index) => chapter(index)),
      FAST_CONTINUATION_SCOPE,
    );
    expect(plan.nearChapters).toHaveLength(10);
    expect(plan.nearChapters[0].position).toBe(15);
    expect(plan.nearChapters.at(-1)?.position).toBe(24);
    expect(plan.historicalChapters).toHaveLength(15);
  });

  it('uses the full 10-chapter window when the source has more than 10', () => {
    const plan = planAnalysisScope(
      Array.from({ length: 12 }, (_, index) => chapter(index)),
      FAST_CONTINUATION_SCOPE,
    );
    expect(plan.nearChapters).toHaveLength(10);
    expect(plan.nearChapters[0].position).toBe(2);
    expect(plan.nearChapters.at(-1)?.position).toBe(11);
  });

  it('preserves the full source for the complete Canon scope', () => {
    const plan = planAnalysisScope(
      Array.from({ length: 35 }, (_, index) => chapter(index)),
      { schemaVersion: 1, kind: 'full', tailChapterCount: null },
    );

    expect(plan.nearChapters).toHaveLength(35);
    expect(plan.historicalChapters).toHaveLength(0);
    expect(plan.effectiveScope.kind).toBe('full');
  });
});
