import {
  buildHistoricalDigestRequestOptions,
  resolveHistoricalDigestInputCharBudget,
  resolveHistoricalDigestMaxTokens,
  summarizeHistoricalDigestCoverage,
} from '../src/services/continuation/canon/historicalDigestService';
import { asSourcePosition } from '../src/services/continuation/continuationSourceRepository';

describe('historical digest LLM request options', () => {
  it('preserves thinking while using bounded chapter groups and a real completion budget', () => {
    const options = buildHistoricalDigestRequestOptions(7, 'digest-1', undefined);
    expect(options).toEqual(
      expect.objectContaining({
        responseFormat: 'json_object',
        projectId: 7,
        taskId: 'digest-1',
      }),
    );
    expect('thinking' in options).toBe(false);
    expect(
      resolveHistoricalDigestInputCharBudget(1_000_000, 200_000),
    ).toBeGreaterThan(1_000_000);
    expect(resolveHistoricalDigestMaxTokens(200_000)).toBe(65_536);
  });

  it('merges overlapping ready digest ranges before reporting historical coverage', () => {
    expect(
      summarizeHistoricalDigestCoverage([
        { status: 'ready', startPosition: asSourcePosition(0), endPosition: asSourcePosition(30) },
        { status: 'ready', startPosition: asSourcePosition(30), endPosition: asSourcePosition(60) },
        { status: 'ready', startPosition: asSourcePosition(0), endPosition: asSourcePosition(60) },
        { status: 'failed', startPosition: asSourcePosition(60), endPosition: asSourcePosition(90) },
      ]),
    ).toEqual({
      readyDigestCount: 3,
      readyChapterCount: 60,
      ranges: [{ startPosition: 0, endPosition: 60 }],
    });
  });
});
