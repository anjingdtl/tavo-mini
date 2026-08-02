/**
 * Continuation budgets are derived from the frozen model configuration and
 * the current chapter demand.  The ratios below are product policy, not token
 * ceilings: no category gets an absolute token cap.
 */

export const CONTINUATION_BUDGET_POLICY = {
  contextUtilizationRatio: 0.8,
  maxOutputRatio: 0.2,
  safetyRatio: 0.0625,
  promptSkeletonRatio: 0.04,
  minPlanShare: 0.12,
  maxPlanShare: 0.24,
  minProseCompletionShare: 0.72,
  maxProseCompletionShare: 0.86,
  categoryWeights: {
    canon: 0.3,
    primaryAnchor: 0.25,
    storyMemory: 0.15,
    recentBridge: 0.1,
    originalStyle: 0.1,
    episodic: 0.07,
    supplements: 0.03,
  },
} as const;

export type ContinuationContextCategory = keyof typeof CONTINUATION_BUDGET_POLICY.categoryWeights;

export interface ResolvedStageCapacity {
  llmConfigId: number;
  contextWindow: number;
  effectiveWindow: number;
  /** The configured ceiling after the product's output-share guard. */
  declaredOutputTokens: number;
  maxOutputTokens: number;
  promptSkeletonTokens: number;
  safetyTokens: number;
  inputBudget: number;
}

export interface ContinuationStageBudgets {
  /** Kept for legacy snapshots; workflowVersion 2 never calls Planner. */
  planner: ResolvedStageCapacity;
  writer: ResolvedStageCapacity;
  checker: ResolvedStageCapacity | null;
  repair: ResolvedStageCapacity | null;
}

export interface ContinuationContextBudgetPlan {
  modelContextLimit: number;
  effectiveWindow: number;
  reservedOutputTokens: number;
  safetyTokens: number;
  promptSkeletonTokens: number;
  inputBudget: number;
  residualContextBudget: number;
  canonTokens: number;
  supplementTokens: number;
  sourceSeamTokens: number;
  recentBridgeTokens: number;
  storyMemoryTokens: number;
  episodicTokens: number;
  styleTokens: number;
  hardContextTokens: number;
  pressure: number;
  declaredOutputRatio: number;
  hasPrimaryAnchor: boolean;
  categoryShares: Record<ContinuationContextCategory, number>;
  chapterDemand: number;
  planShare: number;
  minimumProseShare: number;
  desiredOutput: number;
  minimumOutput: number;
  requestedMaxTokens: number;
  declaredOutput: number;
}

export interface ContinuationWriterOutputBudget {
  contextWindow: number;
  effectiveWindow: number;
  declaredOutput: number;
  outputShareCap: number;
  chapterDemand: number;
  pressure: number;
  planShare: number;
  minimumProseShare: number;
  desiredOutput: number;
  minimumOutput: number;
  windowOutputCapacity: number;
  requestedMaxTokens: number;
  blockedReason?: string;
  /** Backward-readable aliases. New workflow never retries Writer. */
  initialOutputTokens: number;
  retryOutputTokens: number;
}

const FALLBACK_CONTEXT_WINDOW = 8192;

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function ratio(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function interpolate(min: number, max: number, pressure: number): number {
  return min + (max - min) * ratio(pressure);
}

export function estimateTargetChapterTokens(targetChapterChars: number): number {
  // This is a demand estimate, not a transport ceiling. A Chinese-character
  // target is not a token target: JSON plan fields, punctuation and the model's
  // tokenizer all consume additional completion tokens. Use an elastic 3x
  // demand signal so 3,000 Han characters do not masquerade as 3,000 tokens.
  return Math.max(1, Math.floor(positive(targetChapterChars, 1) * 3));
}

export function resolveContinuationCategoryShares(input: {
  pressure: number;
  declaredOutputRatio: number;
  hasPrimaryAnchor: boolean;
}): Record<ContinuationContextCategory, number> {
  const p = ratio(input.pressure);
  const outputPressure = ratio(input.declaredOutputRatio);
  const weights = CONTINUATION_BUDGET_POLICY.categoryWeights;
  const dynamic: Record<ContinuationContextCategory, number> = {
    canon: weights.canon * (1 + p * 0.75 + outputPressure * 0.25),
    primaryAnchor:
      weights.primaryAnchor *
      (1 + p * 0.75 + (input.hasPrimaryAnchor ? 0.15 : 0)),
    storyMemory: weights.storyMemory * (1 + (1 - p) * 0.5),
    recentBridge: weights.recentBridge * (1 + (1 - p) * 0.3),
    originalStyle: weights.originalStyle * (1 + p * 0.35),
    episodic: weights.episodic * (1 + (1 - p) * 0.25),
    supplements: weights.supplements * (1 - p * 0.7),
  };
  const total = Object.values(dynamic).reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(
    Object.entries(dynamic).map(([key, value]) => [key, value / total]),
  ) as Record<ContinuationContextCategory, number>;
}

/**
 * Resolve a stage's safe request envelope from its own frozen model config.
 * It intentionally does not take the minimum window across stages.
 */
export function planStageCapacity(input: {
  llmConfigId: number;
  contextWindow: number;
  maxOutputTokens?: number | null;
  promptSkeletonTokens?: number;
}): ResolvedStageCapacity {
  const contextWindow = positive(input.contextWindow, FALLBACK_CONTEXT_WINDOW);
  const effectiveWindow = Math.floor(
    contextWindow * CONTINUATION_BUDGET_POLICY.contextUtilizationRatio,
  );
  const declaredOutputTokens = positive(input.maxOutputTokens, contextWindow);
  const outputShareCap = Math.floor(
    contextWindow * CONTINUATION_BUDGET_POLICY.maxOutputRatio,
  );
  const maxOutputTokens = Math.min(declaredOutputTokens, outputShareCap);
  const promptSkeletonTokens = Math.max(
    0,
    Math.floor(
      input.promptSkeletonTokens ??
        effectiveWindow * CONTINUATION_BUDGET_POLICY.promptSkeletonRatio,
    ),
  );
  const safetyTokens = Math.floor(
    effectiveWindow * CONTINUATION_BUDGET_POLICY.safetyRatio,
  );
  const inputBudget = Math.max(
    0,
    effectiveWindow - maxOutputTokens - safetyTokens - promptSkeletonTokens,
  );
  return {
    llmConfigId: Number.isFinite(input.llmConfigId)
      ? Math.floor(input.llmConfigId)
      : 0,
    contextWindow,
    effectiveWindow,
    declaredOutputTokens,
    maxOutputTokens,
    promptSkeletonTokens,
    safetyTokens,
    inputBudget,
  };
}

export function resolveContinuationWriterOutputBudget(input: {
  contextWindow: number;
  targetChapterChars: number;
  configuredMaxOutputTokens?: number | null;
  requestedMaxOutputTokens?: number;
  hardContextTokens?: number;
}): ContinuationWriterOutputBudget {
  const contextWindow = positive(input.contextWindow, FALLBACK_CONTEXT_WINDOW);
  const effectiveWindow = Math.floor(
    contextWindow * CONTINUATION_BUDGET_POLICY.contextUtilizationRatio,
  );
  const declaredOutput = positive(
    input.requestedMaxOutputTokens ?? input.configuredMaxOutputTokens,
    contextWindow,
  );
  const outputShareCap = Math.floor(
    contextWindow * CONTINUATION_BUDGET_POLICY.maxOutputRatio,
  );
  const chapterDemand = estimateTargetChapterTokens(input.targetChapterChars);
  const pressure = ratio(chapterDemand / contextWindow);
  const planShare = interpolate(
    CONTINUATION_BUDGET_POLICY.minPlanShare,
    CONTINUATION_BUDGET_POLICY.maxPlanShare,
    pressure,
  );
  const minimumProseShare = interpolate(
    CONTINUATION_BUDGET_POLICY.minProseCompletionShare,
    CONTINUATION_BUDGET_POLICY.maxProseCompletionShare,
    pressure,
  );
  const desiredOutput = Math.ceil(chapterDemand / (1 - planShare));
  const minimumOutput = Math.ceil(
    (chapterDemand * minimumProseShare) / (1 - planShare),
  );
  const safetyTokens = Math.floor(
    effectiveWindow * CONTINUATION_BUDGET_POLICY.safetyRatio,
  );
  const skeletonTokens = Math.floor(
    effectiveWindow * CONTINUATION_BUDGET_POLICY.promptSkeletonRatio,
  );
  const hardContextTokens = Math.max(
    0,
    Math.floor(input.hardContextTokens ?? 0),
  );
  const windowOutputCapacity = Math.max(
    0,
    effectiveWindow - safetyTokens - skeletonTokens - hardContextTokens,
  );
  // `desiredOutput` is a demand signal for pressure/minimum-output checks. It
  // must not become the transport ceiling: after the plan was merged into the
  // Writer response, a chapter-length estimate of one token per character can
  // leave too little room for the required JSON plan plus prose (especially
  // for Chinese text). The actual request envelope is elastic and is tightened
  // again by stage preflight using the compiled prompt's real token estimate.
  // This keeps the only hard ceilings at the frozen config, the 20% window
  // share, and the effective window's remaining capacity.
  const requestedMaxTokens = Math.max(
    0,
    Math.min(declaredOutput, outputShareCap, windowOutputCapacity),
  );
  const blockedReason =
    requestedMaxTokens < minimumOutput
      ? `Writer 输出预算不足：当前最多 ${requestedMaxTokens} token，但按目标章节与计划仍至少需要 ${minimumOutput} token；请降低目标字数或选择更大的 context_window / max_output_tokens。`
      : undefined;
  return {
    contextWindow,
    effectiveWindow,
    declaredOutput,
    outputShareCap,
    chapterDemand,
    pressure,
    planShare,
    minimumProseShare,
    desiredOutput,
    minimumOutput,
    windowOutputCapacity,
    requestedMaxTokens,
    blockedReason,
    initialOutputTokens: requestedMaxTokens,
    retryOutputTokens: requestedMaxTokens,
  };
}

/**
 * Build the context layout from the Writer envelope. The hard Canon/locked
 * rule size is supplied when known and is removed before soft categories are
 * normalized. All category budgets therefore remain proportional.
 */
export function planContinuationContextBudget(input: {
  modelContextLimit: number;
  writerMaxOutputTokens: number;
  targetChapterChars?: number;
  hardContextTokens?: number;
  hasPrimaryAnchor?: boolean;
}): ContinuationContextBudgetPlan {
  const writer = planStageCapacity({
    llmConfigId: 0,
    contextWindow: input.modelContextLimit,
    maxOutputTokens: input.writerMaxOutputTokens,
  });
  const chapterDemand = estimateTargetChapterTokens(input.targetChapterChars ?? 1);
  const pressure = ratio(chapterDemand / writer.contextWindow);
  const planShare = interpolate(
    CONTINUATION_BUDGET_POLICY.minPlanShare,
    CONTINUATION_BUDGET_POLICY.maxPlanShare,
    pressure,
  );
  const minimumProseShare = interpolate(
    CONTINUATION_BUDGET_POLICY.minProseCompletionShare,
    CONTINUATION_BUDGET_POLICY.maxProseCompletionShare,
    pressure,
  );
  const desiredOutput = Math.ceil(chapterDemand / (1 - planShare));
  const minimumOutput = Math.ceil(
    (chapterDemand * minimumProseShare) / (1 - planShare),
  );
  const declaredOutputRatio = ratio(
    writer.declaredOutputTokens / writer.contextWindow,
  );
  const hasPrimaryAnchor = input.hasPrimaryAnchor === true;
  const shares = resolveContinuationCategoryShares({
    pressure,
    declaredOutputRatio,
    hasPrimaryAnchor,
  });
  const hardContextTokens = Math.max(0, Math.floor(input.hardContextTokens ?? 0));
  const residualContextBudget = Math.max(
    0,
    writer.inputBudget - hardContextTokens,
  );
  const allocate = (category: ContinuationContextCategory) =>
    Math.floor(residualContextBudget * shares[category]);
  return {
    modelContextLimit: writer.contextWindow,
    effectiveWindow: writer.effectiveWindow,
    reservedOutputTokens: writer.maxOutputTokens,
    safetyTokens: writer.safetyTokens,
    promptSkeletonTokens: writer.promptSkeletonTokens,
    inputBudget: writer.inputBudget,
    residualContextBudget,
    canonTokens: allocate('canon'),
    supplementTokens: allocate('supplements'),
    sourceSeamTokens: allocate('primaryAnchor'),
    recentBridgeTokens: allocate('recentBridge'),
    storyMemoryTokens: allocate('storyMemory'),
    episodicTokens: allocate('episodic'),
    styleTokens: allocate('originalStyle'),
    hardContextTokens,
    pressure,
    declaredOutputRatio,
    hasPrimaryAnchor,
    categoryShares: shares,
    chapterDemand,
    planShare,
    minimumProseShare,
    desiredOutput,
    minimumOutput,
    requestedMaxTokens: writer.maxOutputTokens,
    declaredOutput: writer.declaredOutputTokens,
  };
}
