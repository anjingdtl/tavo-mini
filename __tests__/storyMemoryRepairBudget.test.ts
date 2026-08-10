import { shouldSkipRepairForInfeasibleSize } from '../src/services/storyMemory/storyMemoryCheckpointService';

describe('shouldSkipRepairForInfeasibleSize (governance §7.3)', () => {
  it('returns false when capability is unknown (legacy behavior)', () => {
    expect(
      shouldSkipRepairForInfeasibleSize({
        invalidOutputTokens: 999_999,
        baseInputTokens: 999_999,
        repairInstructionTokens: 200,
        hardInputLimit: 0,
        contextWindow: 0,
      }),
    ).toBe(false);
  });

  it('returns false when the repair dialog fits the window', () => {
    // 1M window, small invalid output: repair is safe.
    expect(
      shouldSkipRepairForInfeasibleSize({
        invalidOutputTokens: 4000,
        baseInputTokens: 6000,
        repairInstructionTokens: 200,
        hardInputLimit: 800_000,
        contextWindow: 1_000_000,
      }),
    ).toBe(false);
  });

  it('returns true when echoing the invalid output would exceed hard limit', () => {
    // Tiny window: base + a huge invalid output + repair instruction overflows.
    expect(
      shouldSkipRepairForInfeasibleSize({
        invalidOutputTokens: 50_000,
        baseInputTokens: 4000,
        repairInstructionTokens: 200,
        hardInputLimit: 30_000,
        contextWindow: 65_536,
      }),
    ).toBe(true);
  });

  it('returns true when invalid output alone nearly equals the window', () => {
    expect(
      shouldSkipRepairForInfeasibleSize({
        invalidOutputTokens: 120_000,
        baseInputTokens: 4000,
        repairInstructionTokens: 200,
        hardInputLimit: 100_000,
        contextWindow: 128_000,
      }),
    ).toBe(true);
  });

  it('boundary: exactly at the hard limit is NOT skipped (fits)', () => {
    expect(
      shouldSkipRepairForInfeasibleSize({
        invalidOutputTokens: 5000,
        baseInputTokens: 4000,
        repairInstructionTokens: 200,
        hardInputLimit: 9200,
        contextWindow: 16_384,
      }),
    ).toBe(false);
  });

  it('boundary: one token over the hard limit IS skipped', () => {
    expect(
      shouldSkipRepairForInfeasibleSize({
        invalidOutputTokens: 5001,
        baseInputTokens: 4000,
        repairInstructionTokens: 200,
        hardInputLimit: 9200,
        contextWindow: 16_384,
      }),
    ).toBe(true);
  });
});
