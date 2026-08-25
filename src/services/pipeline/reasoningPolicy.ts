import { supportsReasoningEffort } from '../llm/openAICompatibleProvider';
import type { LLMRequestConfig } from '../llm/types';
import type { PipelineStageName } from '../../types/pipeline';

/** New V3 product tiers. `medium` is intentionally not part of this type. */
export type PipelineReasoningTier = 'low' | 'high' | 'max';

export const DEFAULT_PIPELINE_REASONING_EFFORT: PipelineReasoningTier = 'high';

export const PIPELINE_REASONING_EFFORT_OPTIONS: Array<{
  value: PipelineReasoningTier;
  label: string;
  description: string;
}> = [
  {
    value: 'low',
    label: '低',
    description: '所有阶段使用低思考预算；事实核查固定 low。',
  },
  {
    value: 'high',
    label: '中',
    description: 'Draft/Review/Brief/Final 使用 high；FactCheck 固定 low。',
  },
  {
    value: 'max',
    label: '高',
    description: 'Draft/Review/Brief/Final 使用 max；FactCheck 固定 low。',
  },
];

/**
 * 极速 (One-Shot) thinking-tier preset. `one_shot` is an Execution Profile —
 * NOT a reasoningEffort tier: it caps the chapter at one paid Draft call and
 * formally skips the AI audit/revision stages. Context still follows the
 * existing elastic budget. The preset pairs with tier `low` for the single
 * Draft request.
 */
export const PIPELINE_ONE_SHOT_TIER_PRESET = {
  value: 'one_shot' as const,
  label: '极速',
  description:
    '仅调用模型一次，跳过 AI 审查和修订，速度与成本最低。适合网文日更、轻创作和快速草稿。上下文仍按当前弹性预算自动装载。',
  subLabel: '一次生成 · 不审稿 · 不复写',
  executionProfile: 'one_shot' as const,
  reasoningEffort: 'low' as const,
};

export type PipelineThinkingPresetValue =
  | typeof PIPELINE_ONE_SHOT_TIER_PRESET['value']
  | PipelineReasoningTier;

export function isPipelineReasoningTier(
  value: unknown,
): value is PipelineReasoningTier {
  return value === 'low' || value === 'high' || value === 'max';
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

/** Current unified profile: Review follows the user tier; FactCheck stays low. */
export const STAGE_REASONING_PROFILE_V33: Record<
  PipelineReasoningTier,
  Record<PipelineStageName, PipelineReasoningTier>
> = {
  low: {
    draft: 'low',
    qa: 'low',
    review: 'low',
    factCheck: 'low',
    brief: 'low',
    proof: 'low',
  },
  high: {
    draft: 'high',
    qa: 'high',
    review: 'high',
    factCheck: 'low',
    brief: 'high',
    proof: 'high',
  },
  max: {
    draft: 'max',
    qa: 'max',
    review: 'max',
    factCheck: 'low',
    brief: 'max',
    proof: 'max',
  },
};

export interface PipelineV3StageReasoning {
  stage: PipelineStageName;
  requestedTier: PipelineReasoningTier;
  effectiveTier: PipelineReasoningTier;
  thinking: { type: 'enabled' | 'disabled' };
  effort: PipelineReasoningTier;
  supported: boolean;
  historical: false;
  downgradeReason?: string;
}

/** Resolve the current unified semantics: Review follows tier; FactCheck stays low. */
export function resolveV33StageReasoning(
  requested: PipelineReasoningTier,
  stage: PipelineStageName,
  model: Pick<LLMRequestConfig, 'provider_type' | 'model_name' | 'url'>,
): PipelineV3StageReasoning {
  const effectiveTier = STAGE_REASONING_PROFILE_V33[requested][stage];
  const supported = supportsReasoningEffort({
    providerType: model.provider_type,
    modelName: model.model_name,
    baseUrl: model.url,
  });
  const factCheckStage = stage === 'factCheck';
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
          downgradeReason: factCheckStage
            ? '当前统一流水线的 FactCheck 固定使用 low'
            : undefined,
        }
      : {}),
  };
}