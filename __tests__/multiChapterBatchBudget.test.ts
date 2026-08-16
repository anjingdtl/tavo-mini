import { deriveAutomaticBatchBudget } from '../src/services/multiChapterBatch/batchBudget';

describe('deriveAutomaticBatchBudget', () => {
  test('multiplies the per-call 80/20 envelope by the chapter attempt envelope', () => {
    expect(deriveAutomaticBatchBudget({ contextWindow: 1_000_000, chapterCount: 1 })).toEqual({
      maxLlmCalls: 12,
      maxInputTokens: 9_600_000,
      maxOutputTokens: 2_400_000,
    });
    expect(deriveAutomaticBatchBudget({ contextWindow: 1_000_000, chapterCount: 2 })).toEqual({
      maxLlmCalls: 24,
      maxInputTokens: 19_200_000,
      maxOutputTokens: 4_800_000,
    });
  });

  test('scales both token pools with chapter count and calls per chapter', () => {
    expect(deriveAutomaticBatchBudget({ contextWindow: 1_000_000, chapterCount: 3 })).toEqual({
      maxLlmCalls: 36,
      maxInputTokens: 28_800_000,
      maxOutputTokens: 7_200_000,
    });
    expect(deriveAutomaticBatchBudget({ contextWindow: 128_000, chapterCount: 20 })).toEqual({
      maxLlmCalls: 240,
      maxInputTokens: 24_576_000,
      maxOutputTokens: 6_144_000,
    });
  });

  test('honors a smaller configured provider output ceiling per call', () => {
    expect(
      deriveAutomaticBatchBudget({
        contextWindow: 1_000_000,
        chapterCount: 5,
        modelMaxOutputTokens: 100_000,
      }),
    ).toEqual({
      maxLlmCalls: 60,
      maxInputTokens: 48_000_000,
      maxOutputTokens: 6_000_000,
    });
  });

  test('normalizes invalid counts and windows without producing negative caps', () => {
    expect(deriveAutomaticBatchBudget({ contextWindow: 0, chapterCount: 0 })).toEqual({
      maxLlmCalls: 12,
      maxInputTokens: 0,
      maxOutputTokens: 0,
    });
  });
});
