/**
 * Five-dimension hard acceptance gate unit tests (quality spec §7 / §12).
 *
 * Verifies the gate logic independently of the DB layer:
 *   - any dimension at 0 fails
 *   - all dimensions at >= 1 passes
 *   - counts come from the current run + snapshot only (mocked)
 *   - missing dimensions are reported in declared order
 */
import {
  evaluateFiveDimensionGate,
  describeGateResult,
  countValidCanonRowsForGate,
  REQUIRED_CANON_DIMENSIONS,
  REQUIRED_MIN_COUNT,
  DIMENSION_TO_REQUEST_GROUP,
} from '../src/services/continuation/canon/canonFiveDimensionGate';

function mockDbWithCounts(count: number) {
  return {
    executeSql: jest.fn().mockResolvedValue([
      { rows: { item: () => ({ c: count }) } },
    ]),
  } as unknown as Parameters<typeof countValidCanonRowsForGate>[0];
}

describe('evaluateFiveDimensionGate', () => {
  it('passes when every dimension has at least 1', () => {
    const result = evaluateFiveDimensionGate({
      characters: 1,
      worldRules: 1,
      relationships: 1,
      plotThreads: 1,
      experiences: 1,
    });
    expect(result.passed).toBe(true);
    expect(result.missingDimensions).toEqual([]);
  });

  it('fails when any dimension is 0', () => {
    const result = evaluateFiveDimensionGate({
      characters: 0,
      worldRules: 5,
      relationships: 5,
      plotThreads: 5,
      experiences: 5,
    });
    expect(result.passed).toBe(false);
    expect(result.missingDimensions).toContain('characters');
  });

  it('passes when a dimension is exactly 1 (single-protagonist novels)', () => {
    const result = evaluateFiveDimensionGate({
      characters: 1,
      worldRules: 5,
      relationships: 5,
      plotThreads: 5,
      experiences: 5,
    });
    expect(result.passed).toBe(true);
    expect(result.missingDimensions).toEqual([]);
  });

  it('reports all missing dimensions, not just the first', () => {
    const result = evaluateFiveDimensionGate({
      characters: 5,
      worldRules: 0,
      relationships: 5,
      plotThreads: 0,
      experiences: 5,
    });
    expect(result.passed).toBe(false);
    expect(result.missingDimensions).toEqual(['worldRules', 'plotThreads']);
  });

  it('passes with large counts (no upper issue)', () => {
    const result = evaluateFiveDimensionGate({
      characters: 50,
      worldRules: 30,
      relationships: 20,
      plotThreads: 15,
      experiences: 40,
    });
    expect(result.passed).toBe(true);
  });
});

describe('countValidCanonRowsForGate', () => {
  it('queries each dimension table scoped to the current run + snapshot', async () => {
    const db = mockDbWithCounts(4);
    const counts = await countValidCanonRowsForGate(db, 'snap-1', 'run-1');
    expect(counts).toEqual({
      characters: 4,
      worldRules: 4,
      relationships: 4,
      plotThreads: 4,
      experiences: 4,
    });
    // Five SELECT COUNT(*) calls, one per dimension.
    expect(db.executeSql).toHaveBeenCalledTimes(5);
    // Each call must scope to snapshot_id + analysis_run_id and exclude
    // superseded/ignored rows.
    for (const call of (db.executeSql as jest.Mock).mock.calls) {
      const sql = call[0] as string;
      expect(sql).toMatch(/snapshot_id = \?/);
      expect(sql).toMatch(/analysis_run_id = \?/);
      expect(sql).toMatch(/review_status NOT IN \('superseded', 'ignored'\)/);
    }
  });
});

describe('describeGateResult', () => {
  it('produces a Chinese summary naming each dimension and its count', () => {
    const result = evaluateFiveDimensionGate({
      characters: 5,
      worldRules: 0,
      relationships: 5,
      plotThreads: 5,
      experiences: 5,
    });
    const text = describeGateResult(result);
    expect(text).toContain('世界观规则 0 条');
    expect(text).toContain('不足维度');
  });

  it('reports pass when the gate is satisfied', () => {
    const result = evaluateFiveDimensionGate({
      characters: 1,
      worldRules: 1,
      relationships: 1,
      plotThreads: 1,
      experiences: 1,
    });
    expect(describeGateResult(result)).toContain('通过');
  });
});

describe('DIMENSION_TO_REQUEST_GROUP', () => {
  it('maps every required dimension to a v3.1 request group', () => {
    for (const dim of REQUIRED_CANON_DIMENSIONS) {
      const group = DIMENSION_TO_REQUEST_GROUP[dim];
      expect(group === 'character_state' || group === 'world_plot').toBe(true);
    }
  });

  it('routes character-owned dimensions to character_state', () => {
    expect(DIMENSION_TO_REQUEST_GROUP.characters).toBe('character_state');
    expect(DIMENSION_TO_REQUEST_GROUP.relationships).toBe('character_state');
    expect(DIMENSION_TO_REQUEST_GROUP.experiences).toBe('character_state');
  });

  it('routes world/plot dimensions to world_plot', () => {
    expect(DIMENSION_TO_REQUEST_GROUP.worldRules).toBe('world_plot');
    expect(DIMENSION_TO_REQUEST_GROUP.plotThreads).toBe('world_plot');
  });
});

describe('constants', () => {
  it('requires exactly the five user-facing dimensions', () => {
    expect(REQUIRED_CANON_DIMENSIONS).toEqual([
      'characters',
      'worldRules',
      'relationships',
      'plotThreads',
      'experiences',
    ]);
  });

  it('sets the minimum count to 1', () => {
    expect(REQUIRED_MIN_COUNT).toBe(1);
  });
});
