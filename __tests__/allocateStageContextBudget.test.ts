import {
  allocateStageContextBudget,
  deriveDefaultSafetyMargin,
} from '../src/services/pipeline/budgetAllocator';

describe('allocateStageContextBudget', () => {
  test('allows full outline when mandatory fits; compresses optional only', () => {
    const result = allocateStageContextBudget({
      contextWindow: 10000,
      reservedOutputTokens: 1000,
      safetyMargin: 500,
      fixedMessagesTokens: 500,
      fullOutlineTokens: 3000,
      mandatoryBodyTokens: 1000,
      optionalSections: [
        { id: 'story', tokens: 5000, weight: 50 },
        { id: 'world', tokens: 5000, weight: 50 },
      ],
    });
    expect(result.fitsMandatory).toBe(true);
    expect(result.fits).toBe(true);
    // remaining = 10000-1000-500-500-3000-1000 = 4000
    expect(result.remainingForOptional).toBe(4000);
    expect(result.optionalAllocations[0].allocated).toBe(2000);
    expect(result.optionalAllocations[0].truncated).toBe(true);
  });

  test('blocks when outline + body cannot fit (no silent outline clip)', () => {
    const result = allocateStageContextBudget({
      contextWindow: 5000,
      reservedOutputTokens: 1000,
      safetyMargin: 500,
      fixedMessagesTokens: 500,
      fullOutlineTokens: 4000,
      mandatoryBodyTokens: 2000,
      optionalSections: [{ id: 'story', tokens: 100, weight: 100 }],
    });
    expect(result.fitsMandatory).toBe(false);
    expect(result.blockingReason).toBe('outline_or_body');
  });

  test('normalizes optional weights that sum over 100%', () => {
    const result = allocateStageContextBudget({
      contextWindow: 20000,
      reservedOutputTokens: 1000,
      safetyMargin: 0,
      fixedMessagesTokens: 0,
      fullOutlineTokens: 0,
      mandatoryBodyTokens: 0,
      optionalSections: [
        { id: 'a', tokens: 10000, weight: 80 },
        { id: 'b', tokens: 10000, weight: 80 },
      ],
    });
    // scale = 100/160; remaining 19000; caps ≈ 9500 each
    const sum = result.optionalAllocations.reduce(
      (s, a) => s + a.allocated,
      0,
    );
    expect(sum).toBeLessThanOrEqual(19000);
    expect(result.fits).toBe(true);
  });

  test('deriveDefaultSafetyMargin scales with window', () => {
    expect(deriveDefaultSafetyMargin(8000)).toBeGreaterThan(0);
    expect(deriveDefaultSafetyMargin(0)).toBe(512);
  });
});
