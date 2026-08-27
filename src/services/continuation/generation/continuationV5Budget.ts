/**
 * Continuation V5 stage budgets.
 * Full-text nodes: draft_writer / revision_writer / final_reviser.
 * Structured nodes: narrative_architect / adversarial_auditor.
 */
import type { ContextAutomationPolicyV2 } from '../../contextAutomationPolicy';
import { resolveEffectiveMaxOutputTokens } from '../../llm/providerCapabilities';
import {
  CONTINUATION_V5_LENGTH_POLICY,
  resolveV5LengthTargets,
} from './continuationV5Contracts';
import type {
  ContinuationV5LengthPolicy,
  ContinuationV5PhysicalNode,
  ContinuationV5StageBudget,
  ContinuationV5StageBudgets,
  FrozenContinuationModelConfig,
} from './types';

export interface FrozenContinuationV5StageModel {
  configId: number;
  contextWindow: number;
  maxOutputTokens: number;
  providerType?: string | null;
  modelName?: string | null;
  url?: string | null;
  providerAdapterId?: string | null;
}

export interface ResolveContinuationV5StageBudgetInput {
  stage: ContinuationV5PhysicalNode;
  frozenModelConfig: FrozenContinuationV5StageModel;
  frozenPolicy: ContextAutomationPolicyV2;
  compiledPromptTokens: number;
  protocolSkeletonTokens: number;
  targetChapterChars: number;
  lengthPolicy?: ContinuationV5LengthPolicy;
  hardContextTokens?: number;
}

export interface ContinuationV5StageBudgetPreflight {
  ok: boolean;
  stage: ContinuationV5PhysicalNode;
  reason: string | null;
  budget: ContinuationV5StageBudget;
}

const FULL_TEXT_STAGES: ContinuationV5PhysicalNode[] = [
  'draft_writer',
  'revision_writer',
  'final_reviser',
];

function requirePositive(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} 必须来自有效的冻结模型能力，收到：${String(value)}`);
  }
  return Math.floor(value);
}

function nonNegative(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} 必须为非负实测值，收到：${String(value)}`);
  }
  return Math.floor(value);
}

export function isV5FullTextStage(stage: ContinuationV5PhysicalNode): boolean {
  return FULL_TEXT_STAGES.includes(stage);
}

export function resolveContinuationV5StageBudget(
  input: ResolveContinuationV5StageBudgetInput,
): ContinuationV5StageBudget {
  const lengthPolicy = input.lengthPolicy ?? CONTINUATION_V5_LENGTH_POLICY;
  const contextWindow = requirePositive(
    input.frozenModelConfig.contextWindow,
    'contextWindow',
  );
  const declaredMaxOutputTokens = requirePositive(
    input.frozenModelConfig.maxOutputTokens,
    'maxOutputTokens',
  );
  const wireMaxOutputTokens = resolveEffectiveMaxOutputTokens({
    providerType: input.frozenModelConfig.providerType,
    modelName: input.frozenModelConfig.modelName,
    url: input.frozenModelConfig.url,
    configuredMaxOutputTokens: declaredMaxOutputTokens,
    providerAdapterId: input.frozenModelConfig.providerAdapterId,
  });
  const compiledPromptTokens = nonNegative(
    input.compiledPromptTokens,
    'compiledPromptTokens',
  );
  const protocolSkeletonTokens = nonNegative(
    input.protocolSkeletonTokens,
    'protocolSkeletonTokens',
  );
  const targetChapterChars = Math.max(1, Math.floor(input.targetChapterChars));
  const hardContextTokens = nonNegative(
    input.hardContextTokens ?? 0,
    'hardContextTokens',
  );
  const tokensPerHan =
    input.frozenPolicy.continuation.hanDemand.estimatedTokensPerHan;
  const coverage =
    input.frozenPolicy.continuation.hanDemand.minimumCompletionCoverageRatio;
  const promptReserveTokens = Math.max(
    64,
    Math.ceil(compiledPromptTokens * 0.05),
  );
  const safetyReserveTokens = Math.max(64, Math.ceil(contextWindow * 0.02));
  const effectiveWindow = Math.max(
    1,
    contextWindow - hardContextTokens - safetyReserveTokens,
  );
  const inputBudget = Math.max(
    0,
    effectiveWindow - promptReserveTokens - protocolSkeletonTokens,
  );

  let demandTokens: number;
  let minimumOutputTokens: number;
  if (isV5FullTextStage(input.stage)) {
    const targetDemand = Math.ceil(targetChapterChars * tokensPerHan);
    demandTokens = Math.ceil(
      targetDemand * lengthPolicy.outputHeadroomRatio + protocolSkeletonTokens,
    );
    minimumOutputTokens = Math.ceil(targetDemand * coverage);
  } else {
    // Structured JSON nodes: enough room for contracts, not full chapters.
    demandTokens = Math.max(
      1200,
      Math.ceil(targetChapterChars * tokensPerHan * 0.35) + protocolSkeletonTokens,
    );
    minimumOutputTokens = Math.ceil(demandTokens * 0.5);
  }

  const availableOutputTokens = Math.max(
    0,
    effectiveWindow - compiledPromptTokens - promptReserveTokens,
  );
  const maximumOutputTokens = Math.min(
    wireMaxOutputTokens,
    availableOutputTokens,
    Math.max(demandTokens, minimumOutputTokens),
  );
  const pressure = Math.min(
    1,
    Math.max(0, demandTokens / Math.max(contextWindow, 1)),
  );

  let blockedReason: string | null = null;
  if (compiledPromptTokens + minimumOutputTokens > contextWindow) {
    blockedReason = `${input.stage}_prompt_budget_exceeded`;
  } else if (maximumOutputTokens < minimumOutputTokens) {
    blockedReason = `${input.stage}_output_budget_insufficient`;
  } else if (compiledPromptTokens + maximumOutputTokens > contextWindow) {
    blockedReason = `${input.stage}_context_window_exceeded`;
  }

  return {
    stage: input.stage,
    configId: input.frozenModelConfig.configId,
    contextWindow,
    effectiveWindow,
    declaredMaxOutputTokens,
    wireMaxOutputTokens,
    compiledPromptTokens,
    protocolSkeletonTokens,
    promptReserveTokens,
    safetyReserveTokens,
    hardContextTokens,
    inputBudget,
    availableOutputTokens,
    demandTokens,
    minimumOutputTokens,
    maximumOutputTokens: Math.max(0, maximumOutputTokens),
    targetChapterChars,
    pressure,
    blockedReason,
  };
}

export function preflightContinuationV5StageBudget(
  input: ResolveContinuationV5StageBudgetInput,
): ContinuationV5StageBudgetPreflight {
  const budget = resolveContinuationV5StageBudget(input);
  return {
    ok: budget.blockedReason == null,
    stage: input.stage,
    reason: budget.blockedReason,
    budget,
  };
}

export function resolveContinuationV5BudgetPreview(input: {
  frozenPolicy: ContextAutomationPolicyV2;
  stages: Record<ContinuationV5PhysicalNode, FrozenContinuationV5StageModel>;
  targetChapterChars: number;
  compiledPromptTokens?:
    | number
    | Partial<Record<ContinuationV5PhysicalNode, number>>;
  protocolSkeletonTokens?:
    | number
    | Partial<Record<ContinuationV5PhysicalNode, number>>;
  hardContextTokens?: number | Partial<Record<ContinuationV5PhysicalNode, number>>;
  lengthPolicy?: ContinuationV5LengthPolicy;
}): ContinuationV5StageBudgets {
  const nodes: ContinuationV5PhysicalNode[] = [
    'draft_writer',
    'narrative_architect',
    'revision_writer',
    'adversarial_auditor',
    // Phase 4 §7.2: the unified_qa node is the compact Standard ONE QA; the
    // budget preview mirrors the same envelope so legacy and compact share
    // identical token math for the auditor role.
    'unified_qa',
    'final_reviser',
  ];
  const pick = (
    source:
      | number
      | Partial<Record<ContinuationV5PhysicalNode, number>>
      | undefined,
    stage: ContinuationV5PhysicalNode,
    fallback: number,
  ): number => {
    if (typeof source === 'number') return source;
    if (source && typeof source[stage] === 'number') return source[stage]!;
    return fallback;
  };
  const out = {} as ContinuationV5StageBudgets;
  for (const stage of nodes) {
    out[stage] = resolveContinuationV5StageBudget({
      stage,
      frozenModelConfig: input.stages[stage],
      frozenPolicy: input.frozenPolicy,
      compiledPromptTokens: pick(input.compiledPromptTokens, stage, 800),
      protocolSkeletonTokens: pick(input.protocolSkeletonTokens, stage, 200),
      targetChapterChars: input.targetChapterChars,
      lengthPolicy: input.lengthPolicy,
      hardContextTokens: pick(input.hardContextTokens, stage, 0),
    });
  }
  return out;
}

export function frozenModelToV5Stage(
  config: FrozenContinuationModelConfig,
): FrozenContinuationV5StageModel {
  return {
    configId: config.configId,
    contextWindow: config.contextWindow,
    maxOutputTokens: config.maxOutputTokens,
    providerType: config.providerType,
    modelName: config.modelName,
    url: config.url,
    providerAdapterId: config.providerAdapterId,
  };
}

export function v5LengthTargetsFor(
  targetChapterChars: number,
  policy?: ContinuationV5LengthPolicy,
) {
  return resolveV5LengthTargets(targetChapterChars, policy);
}
