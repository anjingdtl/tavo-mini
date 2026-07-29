/**
 * Continuation context planning is deliberately independent from the outline
 * pipeline allocator. Its first-class inputs are source seam and continuation
 * memory, not freeform resources.
 *
 * WP3: each generation stage (Planner/Writer/Checker/Repair) may use a different
 * LLM config, so capacity is resolved per stage rather than sharing Writer's
 * budget or taking min(context_window) as a universal limit (Spec §7.1).
 */

export interface ResolvedStageCapacity {
  llmConfigId: number;
  contextWindow: number;
  maxOutputTokens: number;
  promptSkeletonTokens: number;
  safetyTokens: number;
  inputBudget: number;
}

export interface ContinuationStageBudgets {
  planner: ResolvedStageCapacity;
  writer: ResolvedStageCapacity;
  checker: ResolvedStageCapacity | null;
  repair: ResolvedStageCapacity | null;
}

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
  /** Share of inputBudget reserved for original-style profile injection. */
  styleTokens: number;
}

const MIN_CONTEXT = 1024;
const FIXED_SAFETY_TOKENS = 512;
const DEFAULT_PROMPT_SKELETON_TOKENS = 768;

function integer(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function cappedShare(input: number, ratio: number, cap: number): number {
  return Math.max(0, Math.min(cap, Math.floor(input * ratio)));
}

/**
 * Resolve a single stage's usable input budget from its actual LLM config.
 * Does not share Writer budget across stages and does not take min of all models.
 *
 * stageInputBudget = context_window - max_output - safety - promptSkeleton
 */
export function planStageCapacity(input: {
  llmConfigId: number;
  contextWindow: number;
  maxOutputTokens: number;
  promptSkeletonTokens?: number;
}): ResolvedStageCapacity {
  const contextWindow = Math.max(
    MIN_CONTEXT,
    integer(input.contextWindow, 8192),
  );
  const maxOutputTokens = integer(input.maxOutputTokens, 2048);
  const promptSkeletonTokens = integer(
    input.promptSkeletonTokens ?? DEFAULT_PROMPT_SKELETON_TOKENS,
    DEFAULT_PROMPT_SKELETON_TOKENS,
  );
  // Safety scales mildly with window so 1M models keep estimator headroom,
  // without eating the whole budget on small 8K models.
  const safetyTokens = Math.max(
    FIXED_SAFETY_TOKENS,
    Math.min(2048, Math.floor(contextWindow * 0.02)),
  );
  const inputBudget = Math.max(
    256,
    contextWindow - maxOutputTokens - safetyTokens - promptSkeletonTokens,
  );
  return {
    llmConfigId: Number.isFinite(input.llmConfigId) ? Math.floor(input.llmConfigId) : 0,
    contextWindow,
    maxOutputTokens,
    promptSkeletonTokens,
    safetyTokens,
    inputBudget,
  };
}

/**
 * Plan a bounded input layout for the frozen context snapshot (typically driven
 * by the Writer stage window, since Writer is the primary consumer of full
 * style + continuity packs). Output reservation follows the actual writer
 * output limit with a capped percentage guard; a 1M context should not lose
 * 150K tokens merely because an old fixed 15% rule was applied.
 *
 * Category ratios leave ~15–18% for stage prompt skeleton, framing, and
 * estimator variance. Style gets a dedicated share (~10%, capped) so it is not
 * silently crowded out by soft supplements.
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

  // Ratios sum to ~0.84 so skeleton/framing/variance still have headroom.
  // Caps prevent an advertised 1M window from becoming an unbounded request.
  return {
    modelContextLimit,
    reservedOutputTokens,
    safetyTokens: FIXED_SAFETY_TOKENS,
    inputBudget,
    canonTokens: cappedShare(inputBudget, 0.2, 128_000),
    supplementTokens: cappedShare(inputBudget, 0.05, 48_000),
    sourceSeamTokens: cappedShare(inputBudget, 0.15, 96_000),
    recentBridgeTokens: cappedShare(inputBudget, 0.15, 96_000),
    storyMemoryTokens: cappedShare(inputBudget, 0.1, 32_000),
    episodicTokens: cappedShare(inputBudget, 0.07, 24_000),
    styleTokens: cappedShare(inputBudget, 0.1, 16_000),
  };
}
