/**
 * Continuation context planning is deliberately independent from the outline
 * pipeline allocator. Its first-class inputs are source seam and continuation
 * memory, not freeform resources.
 */

export interface ContinuationContextBudgetPlan {
  modelContextLimit: number;
  reservedOutputTokens: number;
  safetyTokens: number;
  inputBudget: number;
  canonTokens: number;
  supplementTokens: number;
  sourceSeamTokens: number;
  recentBridgeTokens: number;
  storyMemoryTokens: number;
  episodicTokens: number;
}

const MIN_CONTEXT = 1024;
const FIXED_SAFETY_TOKENS = 512;

function integer(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function cappedShare(input: number, ratio: number, cap: number): number {
  return Math.max(0, Math.min(cap, Math.floor(input * ratio)));
}

/**
 * Plan a bounded input layout. Output reservation follows the actual writer
 * output limit with a capped percentage guard; a 1M context should not lose
 * 150K tokens merely because an old fixed 15% rule was applied.
 */
export function planContinuationContextBudget(input: {
  modelContextLimit: number;
  writerMaxOutputTokens: number;
}): ContinuationContextBudgetPlan {
  const modelContextLimit = Math.max(
    MIN_CONTEXT,
    integer(input.modelContextLimit, 8192),
  );
  const writerMaxOutputTokens = integer(input.writerMaxOutputTokens, 2048);
  const percentageGuard = Math.min(16_384, Math.floor(modelContextLimit * 0.08));
  const reservedOutputTokens = Math.max(writerMaxOutputTokens, percentageGuard);
  const inputBudget = Math.max(
    256,
    modelContextLimit - reservedOutputTokens - FIXED_SAFETY_TOKENS,
  );

  // Ratios deliberately leave 16% for the stage prompt skeleton, per-message
  // framing and token-estimator variance. The runtime stage gate remains the
  // final safety net, but normal 8K models should degrade by category rather
  // than fail solely because headings and instructions were omitted here.
  // Category caps prevent an advertised 1M window from becoming an unbounded
  // request while still preserving full normal-length chapters.
  return {
    modelContextLimit,
    reservedOutputTokens,
    safetyTokens: FIXED_SAFETY_TOKENS,
    inputBudget,
    canonTokens: cappedShare(inputBudget, 0.22, 128_000),
    supplementTokens: cappedShare(inputBudget, 0.06, 48_000),
    sourceSeamTokens: cappedShare(inputBudget, 0.16, 96_000),
    recentBridgeTokens: cappedShare(inputBudget, 0.16, 96_000),
    storyMemoryTokens: cappedShare(inputBudget, 0.12, 32_000),
    episodicTokens: cappedShare(inputBudget, 0.08, 24_000),
  };
}
