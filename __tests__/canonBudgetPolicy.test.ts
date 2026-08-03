/**
 * Canon budget policy unit tests (quality spec §2–§6).
 *
 * Verifies the strict separation between the model's real capabilities
 * (context window, max output, thinking) and the single tuned quantity
 * (source-chunk size = 30% of the window).
 */
import {
  resolveCanonBudget,
  resolveCanonRequestMaxTokens,
  SOURCE_CHUNK_RATIO_NORMAL,
  RETRY_CHUNK_RATIOS,
  DEFAULT_OUTPUT_BASELINE_BY_PROFILE,
} from '../src/services/continuation/canon/canonBudgetPolicy';

describe('resolveCanonBudget', () => {
  it('sets the source-chunk target to floor(contextWindow * 0.30)', () => {
    const budget = resolveCanonBudget({
      profile: 'deep',
      declaredContextWindow: 1_000_000,
      configuredMaxOutputTokens: 200_000,
      promptOverhead: 600,
    });
    expect(budget.ok).toBe(true);
    expect(budget.sourceChunkTargetTokens).toBe(
      Math.floor(1_000_000 * SOURCE_CHUNK_RATIO_NORMAL),
    );
  });

  it('keeps the full configured max_output_tokens (never compressed)', () => {
    const budget = resolveCanonBudget({
      profile: 'deep',
      declaredContextWindow: 128_000,
      configuredMaxOutputTokens: 65_000,
      promptOverhead: 600,
    });
    expect(budget.ok).toBe(true);
    // 65K exceeds the old 25% share; the new policy keeps it in full.
    expect(budget.configuredMaxOutputTokens).toBe(65_000);
  });

  it('does not write back or alter the declared context window', () => {
    const budget = resolveCanonBudget({
      profile: 'standard',
      declaredContextWindow: 32_768,
      configuredMaxOutputTokens: 8_000,
      promptOverhead: 600,
    });
    expect(budget.declaredContextWindow).toBe(32_768);
  });

  it('shrinks the source chunk (not the output) when protocol compat binds', () => {
    // input + output must fit the window. With a small window and large output,
    // the chunk shrinks; output stays at the full configured value.
    const budget = resolveCanonBudget({
      profile: 'deep',
      declaredContextWindow: 16_000,
      configuredMaxOutputTokens: 10_000,
      promptOverhead: 600,
    });
    expect(budget.ok).toBe(true);
    expect(budget.configuredMaxOutputTokens).toBe(10_000);
    // raw 30% target = 4800, but protocol limit = 16000 - 10000 - 600 = 5400.
    // min(4800, 5400) = 4800. Output untouched.
    expect(budget.sourceChunkTargetTokens).toBe(4800);
  });

  it('refuses (without crippling the model) when config leaves no input room', () => {
    const budget = resolveCanonBudget({
      profile: 'deep',
      declaredContextWindow: 8_000,
      configuredMaxOutputTokens: 8_000,
      promptOverhead: 600,
    });
    expect(budget.ok).toBe(false);
    expect(budget.reason).toContain('max_output_tokens');
    expect(budget.reason).toContain('context_window');
    expect(budget.suggestedMaxOutputTokens).toBeGreaterThan(0);
    expect(budget.suggestedContextWindow).toBeGreaterThan(8_000);
  });

  it('uses the per-chunk ratio from the retry ladder on retries', () => {
    const normal = resolveCanonBudget({
      profile: 'deep',
      declaredContextWindow: 1_000_000,
      configuredMaxOutputTokens: 8_000,
      promptOverhead: 600,
      chunkRatio: RETRY_CHUNK_RATIOS[0],
    });
    const retry20 = resolveCanonBudget({
      profile: 'deep',
      declaredContextWindow: 1_000_000,
      configuredMaxOutputTokens: 8_000,
      promptOverhead: 600,
      chunkRatio: RETRY_CHUNK_RATIOS[1],
    });
    const retry12 = resolveCanonBudget({
      profile: 'deep',
      declaredContextWindow: 1_000_000,
      configuredMaxOutputTokens: 8_000,
      promptOverhead: 600,
      chunkRatio: RETRY_CHUNK_RATIOS[2],
    });
    // Output never changes across the ladder.
    expect(normal.configuredMaxOutputTokens).toBe(8_000);
    expect(retry20.configuredMaxOutputTokens).toBe(8_000);
    expect(retry12.configuredMaxOutputTokens).toBe(8_000);
    // Chunk shrinks: 30% > 20% > 12%.
    expect(normal.sourceChunkTargetTokens).toBeGreaterThan(
      retry20.sourceChunkTargetTokens,
    );
    expect(retry20.sourceChunkTargetTokens).toBeGreaterThan(
      retry12.sourceChunkTargetTokens,
    );
  });

  it('falls back to a derived default window when context_window is missing', () => {
    const budget = resolveCanonBudget({
      profile: 'deep',
      declaredContextWindow: null,
      configuredMaxOutputTokens: 4_096,
      promptOverhead: 600,
    });
    expect(budget.ok).toBe(true);
    // 8x max_output_tokens floor = 32768
    expect(budget.declaredContextWindow).toBeGreaterThanOrEqual(32_768);
  });
});

describe('resolveCanonRequestMaxTokens', () => {
  it('returns the full configured max_output_tokens', () => {
    expect(
      resolveCanonRequestMaxTokens({
        profile: 'deep',
        configuredMaxOutputTokens: 100_000,
      }),
    ).toBe(100_000);
  });

  it('uses the profile baseline only when config is missing', () => {
    expect(
      resolveCanonRequestMaxTokens({
        profile: 'deep',
        configuredMaxOutputTokens: null,
      }),
    ).toBe(DEFAULT_OUTPUT_BASELINE_BY_PROFILE.deep);
  });

  it('never applies a Canon-specific 64K/96K ceiling', () => {
    // A 200K configured output must be returned in full.
    expect(
      resolveCanonRequestMaxTokens({
        profile: 'deep',
        configuredMaxOutputTokens: 200_000,
      }),
    ).toBe(200_000);
  });
});

describe('RETRY_CHUNK_RATIOS', () => {
  it('is the 30% / 20% / 12% ladder', () => {
    expect(RETRY_CHUNK_RATIOS).toEqual([0.3, 0.2, 0.12]);
  });

  it('is strictly decreasing', () => {
    for (let i = 1; i < RETRY_CHUNK_RATIOS.length; i += 1) {
      expect(RETRY_CHUNK_RATIOS[i]).toBeLessThan(RETRY_CHUNK_RATIOS[i - 1]);
    }
  });
});
