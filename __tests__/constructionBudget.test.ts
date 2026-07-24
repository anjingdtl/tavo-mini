import {
  CHARACTER_MIN_OUTPUT,
  DEFAULT_ENTRY_COUNT,
  DEFAULT_RESERVE_PERCENT,
  RESERVE_PERCENT_MAX,
  WORLDBOOK_ENTRY_MAX,
  WORLDBOOK_ENTRY_MIN,
  WORLDBOOK_MIN_OUTPUT_PER_ENTRY,
  clampEntryCount,
  clampPercent,
  computeConstructionBudget,
  computeSafetyMargin,
  findMinReservePercent,
  formatReserveLabel,
  requiredMinOutput,
} from '../src/services/construction/budget';

describe('construction budget', () => {
  describe('safety margin', () => {
    it('floors at 256 for small contexts', () => {
      expect(computeSafetyMargin(1000)).toBe(256);
      expect(computeSafetyMargin(25599)).toBe(256);
    });
    it('scales with 1% in the mid range', () => {
      expect(computeSafetyMargin(32768)).toBe(328);
      expect(computeSafetyMargin(50000)).toBe(500);
    });
    it('caps at 1024 for very large contexts', () => {
      expect(computeSafetyMargin(102400)).toBe(1024);
      expect(computeSafetyMargin(200000)).toBe(1024);
    });
    it('treats missing context as the floor', () => {
      expect(computeSafetyMargin(0)).toBe(256);
    });
  });

  describe('clamps', () => {
    it('clamps reserve percent into 1..15 and defaults to 5', () => {
      expect(clampPercent(0)).toBe(1);
      expect(clampPercent(7)).toBe(7);
      expect(clampPercent(20)).toBe(15);
      expect(clampPercent(NaN)).toBe(DEFAULT_RESERVE_PERCENT);
    });
    it('clamps worldbook entry count into 2..12 with default 6', () => {
      expect(clampEntryCount(0)).toBe(WORLDBOOK_ENTRY_MIN);
      expect(clampEntryCount(1)).toBe(WORLDBOOK_ENTRY_MIN);
      expect(clampEntryCount(9)).toBe(9);
      expect(clampEntryCount(99)).toBe(WORLDBOOK_ENTRY_MAX);
      expect(clampEntryCount(undefined)).toBe(DEFAULT_ENTRY_COUNT);
    });
  });

  it('requiredMinOutput: character=512, worldbook=256*entries', () => {
    expect(requiredMinOutput('character')).toBe(CHARACTER_MIN_OUTPUT);
    expect(requiredMinOutput('worldbook', 6)).toBe(
      WORLDBOOK_MIN_OUTPUT_PER_ENTRY * 6,
    );
    expect(requiredMinOutput('worldbook', 1)).toBe(
      WORLDBOOK_MIN_OUTPUT_PER_ENTRY * WORLDBOOK_ENTRY_MIN,
    );
  });

  describe('computeConstructionBudget — character', () => {
    it('matches SPEC §6.2 formula and is generatable at defaults', () => {
      // C=32768, M=4096, p=5
      const r = computeConstructionBudget({
        contextWindow: 32768,
        maxOutputTokens: 4096,
        reservePercent: 5,
        target: 'character',
      });
      expect(r.requestedOutput).toBe(1638); // round(32768*0.05)
      expect(r.safetyMargin).toBe(328);
      expect(r.outputReserve).toBe(1638); // min(1638,4096,32440)
      expect(r.sourceBudget).toBe(32768 - 1638 - 328);
      expect(r.requiredMinOutput).toBe(512);
      expect(r.generatable).toBe(true);
      expect(r.feasible).toBe(true);
      expect(r.cappedByMaxOutput).toBe(false);
      expect(r.cappedByContext).toBe(false);
    });

    it('caps outputReserve by max_output_tokens and flags it', () => {
      const r = computeConstructionBudget({
        contextWindow: 32768,
        maxOutputTokens: 1000,
        reservePercent: 5,
        target: 'character',
      });
      expect(r.outputReserve).toBe(1000);
      expect(r.cappedByMaxOutput).toBe(true);
      expect(r.cappedByContext).toBe(false);
      // 1000 still >= 512 → generatable
      expect(r.generatable).toBe(true);
    });

    it('is not generatable when the slider is too low, and reports min percent', () => {
      const r = computeConstructionBudget({
        contextWindow: 32768,
        maxOutputTokens: 4096,
        reservePercent: 1,
        target: 'character',
      });
      // p=1 → 328 < 512
      expect(r.outputReserve).toBe(328);
      expect(r.generatable).toBe(false);
      expect(r.feasible).toBe(true);
      expect(r.minReservePercent).toBe(2);
      expect(r.reason).toContain('2%');
    });

    it('is infeasible when max_output_tokens is below the minimum', () => {
      const r = computeConstructionBudget({
        contextWindow: 32768,
        maxOutputTokens: 300,
        reservePercent: 15,
        target: 'character',
      });
      expect(r.feasible).toBe(false);
      expect(r.minReservePercent).toBeNull();
      expect(r.reason).toContain('输出更大的在线模型');
    });
  });

  describe('computeConstructionBudget — worldbook', () => {
    it('requires 256 * entryCount and respects the count', () => {
      const r = computeConstructionBudget({
        contextWindow: 32768,
        maxOutputTokens: 4096,
        reservePercent: 15,
        target: 'worldbook',
        entryCount: 6,
      });
      expect(r.requiredMinOutput).toBe(256 * 6);
      // p=15 → 4915, capped by M=4096 → 4096 >= 1536 → generatable
      expect(r.outputReserve).toBe(4096);
      expect(r.cappedByMaxOutput).toBe(true);
      expect(r.generatable).toBe(true);
      expect(r.entryCount).toBe(6);
    });

    it('flags infeasibility when entry count needs >15% and guides the user', () => {
      // C=4096 → 15% = 614, but 6 entries need 1536
      const r = computeConstructionBudget({
        contextWindow: 4096,
        maxOutputTokens: 4096,
        reservePercent: 15,
        target: 'worldbook',
        entryCount: 6,
      });
      expect(r.feasible).toBe(false);
      expect(r.minReservePercent).toBeNull();
      expect(r.reason).toContain('减少条目数');
      expect(r.reason).toContain('1536');
    });

    it('recovers feasibility by lowering entry count', () => {
      const r = computeConstructionBudget({
        contextWindow: 4096,
        maxOutputTokens: 4096,
        reservePercent: 15,
        target: 'worldbook',
        entryCount: 2,
      });
      expect(r.requiredMinOutput).toBe(512);
      expect(r.generatable).toBe(true);
    });
  });

  describe('findMinReservePercent', () => {
    it('returns the smallest percent that satisfies the minimum', () => {
      // C=32768, min=512 → p=2 (655) is the first to clear 512
      expect(
        findMinReservePercent(32768, 4096, CHARACTER_MIN_OUTPUT),
      ).toBe(2);
    });
    it('returns null when the ceiling is below the minimum', () => {
      expect(findMinReservePercent(32768, 300, 512)).toBeNull();
    });
    it('respects the 1..15 slider ceiling', () => {
      // C=4096, M large, need 1536 → 15% only gives 614 → null
      expect(findMinReservePercent(4096, 99999, 1536)).toBeNull();
    });
  });

  it('formatReserveLabel renders percent with localized token count', () => {
    expect(formatReserveLabel(5, 1638)).toBe('5% · 1,638 Token');
    expect(formatReserveLabel(RESERVE_PERCENT_MAX, 0)).toBe('15% · 0 Token');
  });
});
