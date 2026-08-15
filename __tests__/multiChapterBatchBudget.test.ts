import { deriveAutomaticBatchBudget } from '../src/services/multiChapterBatch/batchBudget';

describe('deriveAutomaticBatchBudget', () => {
  test('keeps the existing minimum envelope for one and two chapters', () => {
    expect(deriveAutomaticBatchBudget({ contextWindow: 1_000_000, chapterCount: 1 })).toEqual({
      maxLlmCalls: 12,
      maxInputTokens: 4_000_000,
      maxOutputTokens: 2_000_000,
    });
    expect(deriveAutomaticBatchBudget({ contextWindow: 1_000_000, chapterCount: 2 })).toEqual({
      maxLlmCalls: 24,
      maxInputTokens: 4_000_000,
      maxOutputTokens: 2_000_000,
    });
  });

  test('scales input and output envelopes with chapter count', () => {
    expect(deriveAutomaticBatchBudget({ contextWindow: 1_000_000, chapterCount: 3 })).toEqual({
      maxLlmCalls: 36,
      maxInputTokens: 6_000_000,
      maxOutputTokens: 3_000_000,
    });
    expect(deriveAutomaticBatchBudget({ contextWindow: 128_000, chapterCount: 20 })).toEqual({
      maxLlmCalls: 240,
      maxInputTokens: 5_120_000,
      maxOutputTokens: 2_560_000,
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
