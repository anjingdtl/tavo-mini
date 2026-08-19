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
 * Model-agnostic compatibility for V3.1 structured-output stages. DeepSeek
 * V4 Flash is the acceptance benchmark that exposed this requirement, but
 * the safe tolerance is a contract property, not a model-name exception.
 * Any provider may compact semantically empty arrays or emit optional
 * findings in a shape that cannot be adopted. The validator still fails
 * closed for malformed roots, immutable-envelope drift, required/hard
 * evidence, hard facts and all final-artifact gates.
 */
export type StructuredOutputCompatibility =
  | 'strict'
  | 'compact-structured-output';

export function structuredOutputCompatibilityForConfig(
  _model: Pick<LLMRequestConfig, 'provider_type' | 'model_name' | 'url'>,
): StructuredOutputCompatibility {
  return 'compact-structured-output';
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
    // Phase 4 §7.2: the unified qa stage inherits the legacy review's tier
    // for V2 (high-tier QA requires high reasoning effort).
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
    factCheck: 'high',
    brief: 'low',
    proof: 'high',
  },
  max: {
    draft: 'max',
    qa: 'high',
    review: 'high',
    factCheck: 'high',
    brief: 'low',
    proof: 'max',
  },
};

/**
 * V3.1 fail-closed profile. Review, FactCheck and Brief remain semantically
 * strict but explicitly disable provider Thinking: these stages must put a
 * compact JSON contract in message.content, and hidden reasoning cannot be
 * adopted as an audit result. Only Draft and Final follow the user's quality
 * tier with Thinking enabled. Keep the historical V2 profile above because
 * old frozen tasks still need to reproduce their original request semantics.
 */
export const STAGE_REASONING_PROFILE_V31: Record<
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
    qa: 'low',
    review: 'low',
    factCheck: 'low',
    brief: 'low',
    proof: 'high',
  },
  max: {
    draft: 'max',
    qa: 'low',
    review: 'low',
    factCheck: 'low',
    brief: 'low',
    proof: 'max',
  },
};

/**
 * V3.2 structured-stage profile.  The semantic primary calls genuinely use
 * low Thinking; only the bounded Formatter calls disable Thinking.  Keep this
 * separate from V3.1 so a frozen historical task can never be silently
 * rewritten during resume.
 */
export const STAGE_REASONING_PROFILE_V32: Record<
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
    qa: 'low',
    review: 'low',
    factCheck: 'low',
    brief: 'low',
    proof: 'high',
  },
  max: {
    draft: 'max',
    qa: 'low',
    review: 'low',
    factCheck: 'low',
    brief: 'low',
    proof: 'max',
  },
};

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

/** Resolve the V3.1 fail-closed request semantics for a new task. */
export function resolveV31StageReasoning(
  requested: PipelineReasoningTier,
  stage: PipelineStageName,
  model: Pick<LLMRequestConfig, 'provider_type' | 'model_name' | 'url'>,
): PipelineV3StageReasoning {
  const effectiveTier = STAGE_REASONING_PROFILE_V31[requested][stage];
  const supported = supportsReasoningEffort({
    providerType: model.provider_type,
    modelName: model.model_name,
    baseUrl: model.url,
  });
  const structuredStage =
    stage === 'review' || stage === 'factCheck' || stage === 'brief';
  return {
    stage,
    requestedTier: requested,
    effectiveTier,
    thinking: { type: structuredStage ? 'disabled' : 'enabled' },
    effort: effectiveTier,
    supported,
    historical: false,
    ...(effectiveTier !== requested
      ? {
          downgradeReason:
            'V3.1 Review/FactCheck/Brief 关闭 Thinking；仅 Draft/Final 随产品档位变化',
        }
      : {}),
  };
}

/** Resolve V3.2 primary semantics: Review/FactCheck/Brief enabled + low. */
export function resolveV32StageReasoning(
  requested: PipelineReasoningTier,
  stage: PipelineStageName,
  model: Pick<LLMRequestConfig, 'provider_type' | 'model_name' | 'url'>,
): PipelineV3StageReasoning {
  const effectiveTier = STAGE_REASONING_PROFILE_V32[requested][stage];
  const supported = supportsReasoningEffort({
    providerType: model.provider_type,
    modelName: model.model_name,
    baseUrl: model.url,
  });
  const structuredPrimary =
    stage === 'review' || stage === 'factCheck' || stage === 'brief';
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
          downgradeReason: structuredPrimary
            ? 'V3.2 Review/FactCheck/Brief primary 固定使用 enabled + low'
            : 'V3.2 Draft/Final 随用户档位执行',
        }
      : {}),
  };
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

export interface PipelineReasoningDecision {
  effort?: PipelineReasoningEffort | PipelineReasoningTier;
  thinking?: { type: 'enabled' | 'disabled' };
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
