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
  it('keeps only the most recent 30 bounded chapters for fast continuation', () => {
    const plan = planAnalysisScope(
      Array.from({ length: 80 }, (_, index) => chapter(index)),
      FAST_CONTINUATION_SCOPE,
    );

    expect(plan.nearChapters).toHaveLength(30);
    expect(plan.nearChapters[0].position).toBe(50);
    expect(plan.nearChapters.at(-1)?.position).toBe(79);
    expect(plan.historicalChapters).toHaveLength(50);
    expect(plan.analyzedRanges).toEqual([
      { startPosition: 50, endPosition: 80 },
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
