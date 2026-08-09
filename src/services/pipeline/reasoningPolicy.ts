import type { LLMRequestConfig, ReasoningEffort } from '../llm/types';
import { supportsReasoningEffort } from '../llm/openAICompatibleProvider';
import type { PipelineConfig, PipelineStageName } from '../../types/pipeline';
import type { PipelineExecutionSnapshot } from '../../types/pipelineExecution';

/** New V3 product tiers. `medium` is intentionally not part of this type. */
export type PipelineReasoningTier = 'low' | 'high' | 'max';

/** Historical V2 setting shape retained for frozen-task compatibility. */
export type PipelineReasoningEffort = 'low' | 'medium' | 'high';

export const DEFAULT_PIPELINE_REASONING_EFFORT: PipelineReasoningTier = 'high';

export const PIPELINE_REASONING_EFFORT_OPTIONS: Array<{
  value: PipelineReasoningTier;
  label: string;
  description: string;
}> = [
  {
    value: 'low',
    label: '快速',
    description: '低思考预算，优先响应速度，所有创作节点保留基础 Thinking。',
  },
  {
    value: 'high',
    label: '平衡',
    description: 'Draft/Review/FactCheck/Final 使用 high Thinking。',
  },
  {
    value: 'max',
    label: '质量',
    description: 'Draft/Final 使用 max，Review/FactCheck 最高为 high。',
  },
];

export function isPipelineReasoningTier(
  value: unknown,
): value is PipelineReasoningTier {
  return value === 'low' || value === 'high' || value === 'max';
}

/** Historical parser: accepts medium only for V1/V2 records. */
export function isPipelineReasoningEffort(
  value: unknown,
): value is PipelineReasoningEffort {
  return value === 'low' || value === 'medium' || value === 'high';
}

/**
 * Normalize a live/new setting to V3 semantics. Old values are migrated as
 * specified by the V3 plan: medium→high, high→max.
 */
export function normalizePipelineReasoningTier(
  value: unknown,
): PipelineReasoningTier {
  if (value === 'low') return 'low';
  if (value === 'medium') return 'high';
  if (value === 'high') return 'max';
  if (value === 'max') return 'max';
  return DEFAULT_PIPELINE_REASONING_EFFORT;
}

/**
 * Compatibility normalizer used only by V2 callers/tests. It intentionally
 * keeps medium instead of rewriting a historical fingerprint.
 */
export function normalizePipelineReasoningEffort(
  value: unknown,
): PipelineReasoningEffort {
  return isPipelineReasoningEffort(value) ? value : 'high';
}

/**
 * Deprecated V2 output multiplier. It remains exported so V2 tests and old
 * non-outline callers keep their exact budget semantics. V3 never calls it.
 */
export const PIPELINE_REASONING_OUTPUT_MULTIPLIER: Record<
  PipelineReasoningEffort,
  number
> = {
  low: 0.85,
  medium: 1,
  high: 1.45,
};

export function scalePipelineStageMaxTokens(
  baseTokens: number,
  effort: PipelineReasoningEffort,
): number {
  const base = Number.isFinite(baseTokens) && baseTokens > 0 ? baseTokens : 256;
  return Math.max(
    256,
    Math.ceil(base * PIPELINE_REASONING_OUTPUT_MULTIPLIER[effort]),
  );
}

/** Apply the legacy V2 multiplier. Do not use for V3. */
export function applyPipelineReasoningBudget(
  config: PipelineConfig,
  effort: PipelineReasoningEffort = normalizePipelineReasoningEffort(
    config.reasoningEffort,
  ),
): PipelineConfig {
  return {
    ...config,
    reasoningEffort: effort,
    draftMaxTokens: scalePipelineStageMaxTokens(config.draftMaxTokens, effort),
    reviewMaxTokens: scalePipelineStageMaxTokens(
      config.reviewMaxTokens,
      effort,
    ),
    factCheckMaxTokens: scalePipelineStageMaxTokens(
      config.factCheckMaxTokens,
      effort,
    ),
    proofMaxTokens: scalePipelineStageMaxTokens(config.proofMaxTokens, effort),
  };
}

export const STAGE_REASONING_PROFILE_V2: Record<
  PipelineReasoningTier,
  Record<PipelineStageName, PipelineReasoningTier>
> = {
  low: {
    draft: 'low',
    review: 'low',
    factCheck: 'low',
    brief: 'low',
    proof: 'low',
  },
  high: {
    draft: 'high',
    review: 'high',
    factCheck: 'high',
    brief: 'low',
    proof: 'high',
  },
  max: {
    draft: 'max',
    review: 'high',
    factCheck: 'high',
    brief: 'low',
    proof: 'max',
  },
};

export interface PipelineV3StageReasoning {
  stage: PipelineStageName;
  requestedTier: PipelineReasoningTier;
  effectiveTier: PipelineReasoningTier;
  thinking: { type: 'enabled' };
  effort: PipelineReasoningTier;
  supported: boolean;
  historical: false;
  downgradeReason?: string;
}

export function getV3StageTier(
  requested: PipelineReasoningTier,
  stage: PipelineStageName,
): PipelineReasoningTier {
  return STAGE_REASONING_PROFILE_V2[requested][stage];
}

/**
 * V3 stage profile. Brief is deliberately hard-coded to enabled + low: it is
 * a semantic compressor, not a user-facing quality dial. Provider support
 * only controls whether the extension is emitted, never whether Thinking is
 * semantically requested.
 */
export function resolveV3StageReasoning(
  requested: PipelineReasoningTier,
  stage: PipelineStageName,
  model: Pick<LLMRequestConfig, 'provider_type' | 'model_name' | 'url'>,
): PipelineV3StageReasoning {
  const effectiveTier = getV3StageTier(requested, stage);
  const supported = supportsReasoningEffort({
    providerType: model.provider_type,
    modelName: model.model_name,
    baseUrl: model.url,
  });
  return {
    stage,
    requestedTier: requested,
    effectiveTier,
    thinking: { type: 'enabled' },
    effort: effectiveTier,
    supported,
    historical: false,
    ...(effectiveTier !== requested
      ? {
          downgradeReason:
            stage === 'brief'
              ? 'Brief Compiler 固定使用 low Thinking，不随产品档位升级'
              : 'Review/FactCheck 阶段最高使用 high Thinking',
        }
      : {}),
  };
}

export interface PipelineReasoningDecision {
  effort?: PipelineReasoningEffort | PipelineReasoningTier;
  thinking?: { type: 'enabled' };
  supported: boolean;
  historical: boolean;
}

/** Resolve frozen V2 request semantics; kept unchanged for historical tasks. */
export function resolvePipelineReasoning(
  execution: Pick<
    PipelineExecutionSnapshot,
    'outlineWorkflowVersion' | 'reasoningEffort'
  >,
  model: Pick<LLMRequestConfig, 'provider_type' | 'model_name' | 'url'>,
): PipelineReasoningDecision {
  const effort = execution.reasoningEffort;
  if (
    execution.outlineWorkflowVersion !== 2 ||
    !isPipelineReasoningEffort(effort)
  ) {
    return {
      supported: false,
      historical: execution.outlineWorkflowVersion === 2 && !effort,
    };
  }
  if (
    !supportsReasoningEffort({
      providerType: model.provider_type,
      modelName: model.model_name,
      baseUrl: model.url,
    })
  ) {
    return { effort, supported: false, historical: false };
  }
  return {
    effort,
    thinking: { type: 'enabled' },
    supported: true,
    historical: false,
  };
}

export function toProviderReasoningEffort(
  effort: PipelineReasoningEffort | PipelineReasoningTier | undefined,
): ReasoningEffort | undefined {
  return effort;
}
