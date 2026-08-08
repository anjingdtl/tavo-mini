import type { LLMRequestConfig, ReasoningEffort } from '../llm/types';
import { supportsReasoningEffort } from '../llm/openAICompatibleProvider';
import type { PipelineConfig } from '../../types/pipeline';
import type { PipelineExecutionSnapshot } from '../../types/pipelineExecution';

/** User-facing V2 pipeline reasoning tiers. */
export type PipelineReasoningEffort = 'low' | 'medium' | 'high';

export const DEFAULT_PIPELINE_REASONING_EFFORT: PipelineReasoningEffort = 'medium';

export const PIPELINE_REASONING_EFFORT_OPTIONS: Array<{
  value: PipelineReasoningEffort;
  label: string;
  description: string;
}> = [
  {
    value: 'low',
    label: '快速',
    description: '低思考预算，优先响应速度。',
  },
  {
    value: 'medium',
    label: '平衡',
    description: '中思考预算，速度与一致性均衡。',
  },
  {
    value: 'high',
    label: '质量',
    description: '高思考预算，为四个节点保留更多推理空间。',
  },
];

/** Output reserve multiplier relative to the balanced (medium) baseline. */
export const PIPELINE_REASONING_OUTPUT_MULTIPLIER: Record<
  PipelineReasoningEffort,
  number
> = {
  low: 0.85,
  medium: 1,
  high: 1.45,
};

export function isPipelineReasoningEffort(
  value: unknown,
): value is PipelineReasoningEffort {
  return value === 'low' || value === 'medium' || value === 'high';
}

/** Missing/legacy setting falls back to the balanced product tier. */
export function normalizePipelineReasoningEffort(
  value: unknown,
): PipelineReasoningEffort {
  return isPipelineReasoningEffort(value)
    ? value
    : DEFAULT_PIPELINE_REASONING_EFFORT;
}

/**
 * Scale every V2 stage's output reserve together. Context compilers subtract
 * this reserve before allocating optional input modules, so high thinking
 * automatically borrows from optional context instead of starving the model.
 */
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

/** Apply the selected tier to the four V2 stage output reserves. */
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
    reviewMaxTokens: scalePipelineStageMaxTokens(config.reviewMaxTokens, effort),
    factCheckMaxTokens: scalePipelineStageMaxTokens(
      config.factCheckMaxTokens,
      effort,
    ),
    proofMaxTokens: scalePipelineStageMaxTokens(config.proofMaxTokens, effort),
  };
}

export interface PipelineReasoningDecision {
  effort?: PipelineReasoningEffort;
  thinking?: { type: 'enabled' };
  supported: boolean;
  historical: boolean;
}

/**
 * Resolve frozen V2 request semantics for any of the four normal stages.
 * Historical snapshots without a selected effort intentionally omit both
 * vendor extensions so Resume does not silently change its old behavior.
 */
export function resolvePipelineReasoning(
  execution: Pick<
    PipelineExecutionSnapshot,
    'outlineWorkflowVersion' | 'reasoningEffort'
  >,
  model: Pick<LLMRequestConfig, 'provider_type' | 'model_name' | 'url'>,
): PipelineReasoningDecision {
  const effort = execution.reasoningEffort;
  if (execution.outlineWorkflowVersion !== 2 || !isPipelineReasoningEffort(effort)) {
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

/** Keep the provider-facing type explicit at the boundary. */
export function toProviderReasoningEffort(
  effort: PipelineReasoningEffort | undefined,
): ReasoningEffort | undefined {
  return effort;
}
