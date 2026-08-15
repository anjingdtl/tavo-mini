export interface AutomaticBatchBudget {
  maxLlmCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
}

/**
 * Automatic hard caps for a newly planned batch.
 *
 * The single-chapter floor preserves the historical envelope. Larger batches
 * must scale with their frozen chapter count or a fixed window multiplier can
 * pause an otherwise healthy batch before its later chapters run.
 */
export function deriveAutomaticBatchBudget(input: {
  contextWindow: number;
  chapterCount: number;
}): AutomaticBatchBudget {
  const contextWindow = Math.max(
    0,
    Math.floor(Number(input.contextWindow) || 0),
  );
  const chapterCount = Math.max(1, Math.floor(Number(input.chapterCount) || 0));
  return {
    maxLlmCalls: chapterCount * 12,
    maxInputTokens:
      contextWindow * Math.max(4, chapterCount * 2),
    maxOutputTokens:
      contextWindow * Math.max(2, chapterCount),
  };
}
