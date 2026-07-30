import {
  CHARACTER_MIN_OUTPUT,
  DEFAULT_ENTRY_COUNT,
  DEFAULT_RESERVE_PERCENT,
  RESERVE_PERCENT_MAX,
  WORLDBOOK_ENTRY_MAX,
  WORLDBOOK_ENTRY_MIN,
  WORLDBOOK_COLLECTION_OVERHEAD_TOKENS,
  WORLDBOOK_MIN_OUTPUT_PER_ENTRY,
  clampEntryCount,
  clampPercent,
  computeConstructionBudget,
  computeSafetyMargin,
  findMinReservePercent,
  formatReserveLabel,
  planWorldbookBatches,
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
    it('clamps worldbook entry count into 2..12 with default full-detail count', () => {
      expect(clampEntryCount(0)).toBe(WORLDBOOK_ENTRY_MIN);
      expect(clampEntryCount(1)).toBe(WORLDBOOK_ENTRY_MIN);
      expect(clampEntryCount(9)).toBe(9);
      expect(clampEntryCount(99)).toBe(WORLDBOOK_ENTRY_MAX);
      expect(clampEntryCount(undefined)).toBe(DEFAULT_ENTRY_COUNT);
    });
  });

  it('requiredMinOutput uses the default full-detail lower bound', () => {
    expect(requiredMinOutput('character')).toBe(CHARACTER_MIN_OUTPUT);
    expect(requiredMinOutput('worldbook', 6)).toBe(
      WORLDBOOK_COLLECTION_OVERHEAD_TOKENS + WORLDBOOK_MIN_OUTPUT_PER_ENTRY * 6,
    );
    expect(requiredMinOutput('worldbook', 1)).toBe(
      WORLDBOOK_COLLECTION_OVERHEAD_TOKENS + WORLDBOOK_MIN_OUTPUT_PER_ENTRY * WORLDBOOK_ENTRY_MIN,
    );
  });

  describe('computeConstructionBudget — character', () => {
    it('matches SPEC §6.2 formula and is generatable at defaults', () => {
      // C=32768, M=4096, p=5
      const r = computeConstructionBudget({
        contextWindow: 32768,
        maxOutputTokens: 4096,
        reservePercent: 10,
        target: 'character',
      });
      expect(r.requestedOutput).toBe(3277); // round(32768*0.10)
      expect(r.safetyMargin).toBe(328);
      expect(r.outputReserve).toBe(3277); // min(3277,4096,32440)
      expect(r.sourceBudget).toBe(32768 - 3277 - 328);
      expect(r.requiredMinOutput).toBe(2800);
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
      // 1000 is below the default full-detail lower bound.
      expect(r.generatable).toBe(false);
    });

    it('is not generatable when the slider is too low, and reports min percent', () => {
      const r = computeConstructionBudget({
        contextWindow: 32768,
        maxOutputTokens: 4096,
        reservePercent: 1,
        target: 'character',
      });
      // p=1 → 328 < 2800
      expect(r.outputReserve).toBe(328);
      expect(r.generatable).toBe(false);
      expect(r.feasible).toBe(true);
      expect(r.minReservePercent).toBe(9);
      expect(r.reason).toContain('9%');
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
    it('requires overhead + per-entry lower bounds and respects the count', () => {
      const r = computeConstructionBudget({
        contextWindow: 32768,
        maxOutputTokens: 4096,
        reservePercent: 15,
        target: 'worldbook',
        entryCount: 4,
      });
      expect(r.requiredMinOutput).toBe(200 + 650 * 4);
      // p=15 → 4915, capped by M=4096 → 4096 >= 2800 → generatable
      expect(r.outputReserve).toBe(4096);
      expect(r.cappedByMaxOutput).toBe(true);
      expect(r.generatable).toBe(true);
      expect(r.entryCount).toBe(4);
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
      expect(r.reason).toContain('4100');
    });

    it('recovers feasibility by lowering entry count', () => {
      const r = computeConstructionBudget({
        contextWindow: 10000,
        maxOutputTokens: 4096,
        reservePercent: 15,
        target: 'worldbook',
        entryCount: 2,
      });
      expect(r.requiredMinOutput).toBe(1500);
      expect(r.generatable).toBe(true);
    });
  });

  describe('findMinReservePercent', () => {
    it('returns the smallest percent that satisfies the minimum', () => {
      // C=32768, min=2800 → p=9 (2949) is the first to clear the default full bound
      expect(
        findMinReservePercent(32768, 4096, CHARACTER_MIN_OUTPUT),
      ).toBe(9);
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

  describe('planWorldbookBatches', () => {
    // full 档单条 650 token，overhead 200。
    // 单次目标（含 15% 余量）= ceil((200 + N*650) * 1.15)
    // 不分批阈值：outputReserve >= requiredMin（= 200 + N*650，不含余量）

    it('不分批：outputReserve ≥ 验收下限时走单次路径', () => {
      // 6 条 full：requiredMin = 200 + 6*650 = 4100
      const plan = planWorldbookBatches({
        entryCount: 6,
        detailLevel: 'full',
        outputReserve: 8192,
      });
      expect(plan.batched).toBe(false);
      expect(plan.batchCount).toBe(1);
      expect(plan.batchSizes).toEqual([6]);
      expect(plan.perBatchMaxTokens).toBe(8192);
      expect(plan.feasible).toBe(true);
    });

    it('不分批：outputReserve 刚好等于验收下限', () => {
      // 4 条 full：requiredMin = 200 + 4*650 = 2800
      const plan = planWorldbookBatches({
        entryCount: 4,
        detailLevel: 'full',
        outputReserve: 2800,
      });
      expect(plan.batched).toBe(false);
      expect(plan.batchSizes).toEqual([4]);
      expect(plan.feasible).toBe(true);
    });

    it('分批：10 条 deep + 8192 token 自动拆分', () => {
      // 10 条 deep：requiredMin = 200 + 10*900 = 9200 > 8192 → 分批
      // 单批目标含余量 = ceil((200 + N*900) * 1.15)
      // threshold=0.8 → ceiling = floor(8192*0.8) = 6553
      // N=6: ceil((200+5400)*1.15) = ceil(6440) = 6440 ≤ 6553 ✓
      // N=7: ceil((200+6300)*1.15) = ceil(7475) = 7475 > 6553 ✗
      // 所以 batchSize=6，10 条拆成 [6, 4] → 均匀化 → [5, 5]
      const plan = planWorldbookBatches({
        entryCount: 10,
        detailLevel: 'deep',
        outputReserve: 8192,
      });
      expect(plan.batched).toBe(true);
      expect(plan.feasible).toBe(true);
      expect(plan.batchCount).toBe(2);
      expect(plan.batchSizes.reduce((a, b) => a + b, 0)).toBe(10);
      // 均匀化：[6,4] → [5,5]
      expect(plan.batchSizes).toEqual([5, 5]);
      // 每批 max_tokens 能容纳 5 条 deep
      expect(plan.perBatchMaxTokens).toBe(
        Math.ceil((200 + 5 * 900) * 1.15),
      );
    });

    it('分批：6 条 full + 4096 token（刚好不够单次）', () => {
      // requiredMin = 4100 > 4096 → 分批
      // ceiling = floor(4096*0.8) = 3276
      // N=4: ceil((200+2600)*1.15) = ceil(3220) = 3220 ≤ 3276 ✓
      // N=5: ceil((200+3250)*1.15) = ceil(3968) = 3968 > 3276 ✗
      // batchSize=4，6 条拆成 [4, 2] → 均匀化 → [3, 3]
      const plan = planWorldbookBatches({
        entryCount: 6,
        detailLevel: 'full',
        outputReserve: 4096,
      });
      expect(plan.batched).toBe(true);
      expect(plan.batchSizes).toEqual([3, 3]);
      expect(plan.batchCount).toBe(2);
    });

    it('不可行：outputReserve 太小连单批最少 2 条都装不下', () => {
      // 2 条 compact：单批目标 = ceil((200+800)*1.15) = ceil(1150) = 1150
      // threshold=0.8，outputReserve=1000 → ceiling=800 < 1150 → 不可行
      const plan = planWorldbookBatches({
        entryCount: 4,
        detailLevel: 'compact',
        outputReserve: 1000,
      });
      expect(plan.feasible).toBe(false);
      expect(plan.batched).toBe(false);
      expect(plan.batchCount).toBe(0);
      expect(plan.batchSizes).toEqual([]);
      expect(plan.reason).toContain('不足以容纳');
    });

    it('不可行：outputReserve 为 0', () => {
      const plan = planWorldbookBatches({
        entryCount: 6,
        detailLevel: 'full',
        outputReserve: 0,
      });
      expect(plan.feasible).toBe(false);
      expect(plan.reason).toContain('输出预留为 0');
    });

    it('均匀分配：10 条按每批 4 → [4, 3, 3] 而非 [4, 4, 2]', () => {
      // 10 条 compact：requiredMin = 200 + 10*400 = 4200
      // outputReserve=3000 → 分批
      // ceiling = floor(3000*0.8) = 2400
      // N=4: ceil((200+1600)*1.15) = ceil(2070) = 2070 ≤ 2400 ✓
      // N=5: ceil((200+2000)*1.15) = ceil(2530) = 2530 > 2400 ✗
      // batchSize=4，10 条 → [4, 4, 2] → 均匀化 → [4, 3, 3]
      const plan = planWorldbookBatches({
        entryCount: 10,
        detailLevel: 'compact',
        outputReserve: 3000,
      });
      expect(plan.batched).toBe(true);
      expect(plan.batchSizes).toEqual([4, 3, 3]);
      expect(plan.batchCount).toBe(3);
    });

    it('尊重 maxBatchSize 限制', () => {
      // 12 条 compact + 大 outputReserve：不分批（12 条 requiredMin=5000 ≤ 20000）
      const plan = planWorldbookBatches({
        entryCount: 12,
        detailLevel: 'compact',
        outputReserve: 20000,
        maxBatchSize: 6,
      });
      // requiredMin = 200 + 12*400 = 5000 ≤ 20000 → 不分批
      expect(plan.batched).toBe(false);
      expect(plan.batchSizes).toEqual([12]);
    });

    it('分批时 perBatchMaxTokens 不超过 outputReserve', () => {
      const plan = planWorldbookBatches({
        entryCount: 10,
        detailLevel: 'deep',
        outputReserve: 8192,
      });
      expect(plan.feasible).toBe(true);
      expect(plan.perBatchMaxTokens).toBeLessThanOrEqual(8192);
    });
  });
});
