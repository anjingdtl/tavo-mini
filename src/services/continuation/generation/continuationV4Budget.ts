import type {
  ContextAutomationPolicyV2,
  ContinuationV4Stage,
  RatioCurve,
} from '../../contextAutomationPolicy';

export type { ContinuationV4Stage } from '../../contextAutomationPolicy';

export interface FrozenContinuationStageModel {
  configId: number;
  contextWindow: number;
  maxOutputTokens: number;
}

export interface ResolveContinuationStageBudgetInput {
  stage: ContinuationV4Stage;
  frozenModelConfig: FrozenContinuationStageModel;
  frozenPolicy: ContextAutomationPolicyV2;
  /** Estimated tokens for the compiled request, excluding policy reserve. */
  compiledPromptTokens: number;
  /** Measured protocol/schema skeleton demand for this stage. */
  protocolSkeletonTokens: number;
  targetChapterChars: number;
  writerDraftTokens?: number;
  paragraphCount?: number;
  hardContextTokens?: number;
}

export interface ContinuationV4StageBudget {
  stage: ContinuationV4Stage;
  configId: number;
  contextWindow: number;
  effectiveWindow: number;
  declaredMaxOutputTokens: number;
  maxOutputRatio: number;
  compiledPromptTokens: number;
  protocolSkeletonTokens: number;
  promptReserveTokens: number;
  safetyReserveTokens: number;
  hardContextTokens: number;
  inputBudget: number;
  availableOutputTokens: number;
  demandTokens: number;
  minimumOutputTokens: number;
  maximumOutputTokens: number;
  targetChapterChars: number;
  writerDraftTokens: number;
  paragraphCount: number;
  pressure: number;
  reportDensity: number | null;
  blockedReason: string | null;
}

export interface ContinuationStageBudgetPreflight {
  ok: boolean;
  stage: ContinuationV4Stage;
  reason: string | null;
  budget: ContinuationV4StageBudget;
}

export interface ContinuationV4BudgetPreviewInput {
  frozenPolicy: ContextAutomationPolicyV2;
  stages: Record<ContinuationV4Stage, FrozenContinuationStageModel>;
  targetChapterChars?: number;
  writerDraftTokens?: number;
  paragraphCount?: number;
  compiledPromptTokens?: number | Partial<Record<ContinuationV4Stage, number>>;
  protocolSkeletonTokens?:
    | number
    | Partial<Record<ContinuationV4Stage, number>>;
  hardContextTokens?: number | Partial<Record<ContinuationV4Stage, number>>;
}

export interface ContinuationV4BudgetPreview {
  stages: Record<ContinuationV4Stage, ContinuationV4StageBudget>;
}

const STAGES: ContinuationV4Stage[] = [
  'writer',
  'checker',
  'control',
  'repair',
];

function requirePositiveNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(
      `${label} 必须来自有效的冻结模型能力，收到：${String(value)}`,
    );
  }
  return Math.floor(value);
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} 必须为非负实测值，收到：${String(value)}`);
  }
  return Math.floor(value);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function interpolate(curve: RatioCurve, pressure: number): number {
  return curve.min + (curve.max - curve.min) * clamp01(pressure);
}

function resolveDemand(input: {
  stage: ContinuationV4Stage;
  policy: ContextAutomationPolicyV2;
  targetChapterChars: number;
  writerDraftTokens: number;
  paragraphCount: number;
  contextWindow: number;
}): {
  demandTokens: number;
  minimumOutputTokens: number;
  reportDensity: number | null;
  pressure: number;
} {
  const {
    stage,
    policy,
    targetChapterChars,
    writerDraftTokens,
    paragraphCount,
    contextWindow,
  } = input;
  const targetDemand =
    targetChapterChars * policy.continuation.hanDemand.estimatedTokensPerHan;
  const pressure = clamp01(
    (stage === 'writer' || stage === 'repair'
      ? targetDemand
      : writerDraftTokens) / contextWindow,
  );
  const coverage = policy.continuation.hanDemand.minimumCompletionCoverageRatio;

  if (stage === 'writer' || stage === 'repair') {
    const demandTokens = Math.ceil(targetDemand);
    return {
      demandTokens,
      minimumOutputTokens: Math.ceil(demandTokens * coverage),
      reportDensity: null,
      pressure,
    };
  }

  const densityCurve =
    stage === 'checker'
      ? policy.continuation.checkerReportDensity
      : policy.continuation.controlReportDensity;
  const reportDensity = interpolate(densityCurve, pressure);
  const paragraphMultiplier =
    stage === 'control'
      ? 1 +
        clamp01(paragraphCount / Math.max(writerDraftTokens, paragraphCount))
      : 1;
  const demandTokens = Math.ceil(
    writerDraftTokens * reportDensity * paragraphMultiplier,
  );
  return {
    demandTokens,
    minimumOutputTokens: Math.ceil(demandTokens * coverage),
    reportDensity,
    pressure,
  };
}

/**
 * Resolve one V4 request from the persisted policy, the stage's own frozen
 * model capabilities and measured prompt/demand inputs. No stage has a
 * fallback window or a fixed token floor here.
 */
export function resolveContinuationStageBudget(
  input: ResolveContinuationStageBudgetInput,
): ContinuationV4StageBudget {
  const contextWindow = requirePositiveNumber(
    input.frozenModelConfig.contextWindow,
    'context_window',
  );
  const declaredMaxOutputTokens = requirePositiveNumber(
    input.frozenModelConfig.maxOutputTokens,
    'max_output_tokens',
  );
  const compiledPromptTokens = nonNegativeNumber(
    input.compiledPromptTokens,
    'compiledPromptTokens',
  );
  const protocolSkeletonTokens = nonNegativeNumber(
    input.protocolSkeletonTokens,
    'protocolSkeletonTokens',
  );
  const targetChapterChars = nonNegativeNumber(
    input.targetChapterChars,
    'targetChapterChars',
  );
  const writerDraftTokens = nonNegativeNumber(
    input.writerDraftTokens ?? 0,
    'writerDraftTokens',
  );
  const paragraphCount = nonNegativeNumber(
    input.paragraphCount ?? 0,
    'paragraphCount',
  );
  const hardContextTokens = nonNegativeNumber(
    input.hardContextTokens ?? 0,
    'hardContextTokens',
  );
  const stageRule = input.frozenPolicy.continuation[input.stage];
  const effectiveWindow = Math.floor(
    contextWindow * input.frozenPolicy.utilization.effectiveWindowRatio,
  );
  const promptReserveTokens = Math.max(
    protocolSkeletonTokens,
    Math.floor(
      effectiveWindow * input.frozenPolicy.utilization.promptReserveRatio,
    ),
  );
  const safetyReserveTokens = Math.floor(
    effectiveWindow * input.frozenPolicy.utilization.safetyReserveRatio,
  );
  // hardContextTokens is normally a subset of the compiled prompt. Taking
  // the larger measured value prevents a malformed trace from under-reserving
  // input space without double-counting a correctly compiled prompt.
  const measuredInputTokens = Math.max(compiledPromptTokens, hardContextTokens);
  const availableOutputTokens = Math.max(
    0,
    effectiveWindow -
      measuredInputTokens -
      promptReserveTokens -
      safetyReserveTokens,
  );
  const maximumByPolicy = Math.floor(contextWindow * stageRule.maxOutputRatio);
  const maximumOutputTokens = Math.max(
    0,
    Math.min(declaredMaxOutputTokens, maximumByPolicy, availableOutputTokens),
  );
  const demand = resolveDemand({
    stage: input.stage,
    policy: input.frozenPolicy,
    targetChapterChars,
    writerDraftTokens,
    paragraphCount,
    contextWindow,
  });
  const minimumOutputTokens = Math.max(
    protocolSkeletonTokens,
    demand.minimumOutputTokens,
  );
  const inputBudget = Math.max(
    0,
    effectiveWindow -
      maximumOutputTokens -
      safetyReserveTokens -
      promptReserveTokens,
  );
  const blockedReason =
    maximumOutputTokens < minimumOutputTokens
      ? `${input.stage} 阶段预算不足：当前最大输出 ${maximumOutputTokens}，` +
        `动态最低需求 ${minimumOutputTokens}；context_window=${contextWindow}，` +
        `max_output_tokens=${declaredMaxOutputTokens}。请调整上下文自动化比例、` +
        '模型能力或本次章节需求后重试。'
      : null;

  return {
    stage: input.stage,
    configId: Math.floor(input.frozenModelConfig.configId),
    contextWindow,
    effectiveWindow,
    declaredMaxOutputTokens,
    maxOutputRatio: stageRule.maxOutputRatio,
    compiledPromptTokens,
    protocolSkeletonTokens,
    promptReserveTokens,
    safetyReserveTokens,
    hardContextTokens,
    inputBudget,
    availableOutputTokens,
    demandTokens: demand.demandTokens,
    minimumOutputTokens,
    maximumOutputTokens,
    targetChapterChars,
    writerDraftTokens,
    paragraphCount,
    pressure: demand.pressure,
    reportDensity: demand.reportDensity,
    blockedReason,
  };
}

export function preflightContinuationStageBudget(
  budget: ContinuationV4StageBudget,
): ContinuationStageBudgetPreflight {
  const withinWindow =
    Math.max(budget.compiledPromptTokens, budget.hardContextTokens) +
      budget.maximumOutputTokens +
      budget.safetyReserveTokens <=
    budget.effectiveWindow;
  const reason = !withinWindow
    ? `${budget.stage} 阶段的 prompt + max output + safety 超出有效窗口。`
    : budget.blockedReason;
  return {
    ok: reason == null,
    stage: budget.stage,
    reason,
    budget,
  };
}

export function assertContinuationStageBudget(
  budget: ContinuationV4StageBudget,
): void {
  const preflight = preflightContinuationStageBudget(budget);
  if (!preflight.ok) {
    throw new Error(preflight.reason || `${budget.stage} 阶段预算不可用。`);
  }
}

export function resolveContinuationV4BudgetPreview(
  input: ContinuationV4BudgetPreviewInput,
): ContinuationV4BudgetPreview {
  const stages = {} as Record<ContinuationV4Stage, ContinuationV4StageBudget>;
  const stageValue = (
    value: number | Partial<Record<ContinuationV4Stage, number>> | undefined,
    stage: ContinuationV4Stage,
  ): number => (typeof value === 'number' ? value : value?.[stage] ?? 0);
  for (const stage of STAGES) {
    stages[stage] = resolveContinuationStageBudget({
      stage,
      frozenModelConfig: input.stages[stage],
      frozenPolicy: input.frozenPolicy,
      compiledPromptTokens: stageValue(input.compiledPromptTokens, stage),
      protocolSkeletonTokens: stageValue(input.protocolSkeletonTokens, stage),
      targetChapterChars: input.targetChapterChars ?? 0,
      writerDraftTokens: input.writerDraftTokens ?? 0,
      paragraphCount: input.paragraphCount ?? 0,
      hardContextTokens: stageValue(input.hardContextTokens, stage),
    });
  }
  return { stages };
}
