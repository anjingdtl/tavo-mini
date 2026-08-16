export interface AutomaticBatchBudget {
  maxLlmCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
}

/** The retry/repair envelope reserved for one chapter in a batch. */
export const BATCH_LLM_CALLS_PER_CHAPTER = 12;
export const BATCH_INPUT_ENVELOPE_RATIO = 0.8;
export const BATCH_OUTPUT_ENVELOPE_RATIO = 0.2;

/**
 * Automatic cumulative hard caps for a newly planned batch.
 *
 * One chapter attempt is allowed the same envelope as one elastic request:
 * 80% of the model window on input and 20% on output. The cumulative batch
 * cap is that per-request envelope multiplied by the frozen chapter count and
 * the retry/repair call envelope. This is accounting only; every actual
 * request still goes through the per-stage elastic allocator and its own
 * safety margin / hard-window check.
 */
export function deriveAutomaticBatchBudget(input: {
  contextWindow: number;
  chapterCount: number;
  modelMaxOutputTokens?: number | null;
}): AutomaticBatchBudget {
  const contextWindow = Math.max(
    0,
    Math.floor(Number(input.contextWindow) || 0),
  );
  const chapterCount = Math.max(1, Math.floor(Number(input.chapterCount) || 0));
  const calls = chapterCount * BATCH_LLM_CALLS_PER_CHAPTER;
  const perCallInput = Math.floor(
    contextWindow * BATCH_INPUT_ENVELOPE_RATIO,
  );
  const perCallOutputEnvelope = Math.floor(
    contextWindow * BATCH_OUTPUT_ENVELOPE_RATIO,
  );
  const configuredOutput = Math.max(
    0,
    Math.floor(Number(input.modelMaxOutputTokens) || 0),
  );
  const perCallOutput =
    configuredOutput > 0
      ? Math.min(configuredOutput, perCallOutputEnvelope)
      : perCallOutputEnvelope;
  return {
    maxLlmCalls: calls,
    maxInputTokens: perCallInput * calls,
    maxOutputTokens: perCallOutput * calls,
  };
}
