/**
 * User-facing generation quality: 极速 / 标准 / 质量.
 *
 * This is a Freeze-time mapping onto the existing ONE Kernel contracts:
 *   WritingExecutionProfile + stageReasoning + WritingStagePolicy.
 * It never selects a second Writer, Prompt Compiler, Context, QA, or Memory.
 * Historical frozen tasks without this key resume from their original policy.
 */
import {
  normalizeWritingExecutionProfile,
  type WritingExecutionProfile,
} from './executionProfile';

export type GenerationQualityProfile = 'fast' | 'standard' | 'quality';

export interface GenerationQualityMapping {
  executionProfile: WritingExecutionProfile;
  reasoningEffort: 'low' | 'high' | 'max';
}

export const GENERATION_QUALITY_PROFILE_OPTIONS: Array<{
  value: GenerationQualityProfile;
  label: string;
  description: string;
  subLabel: string;
}> = [
  {
    value: 'fast',
    label: '极速',
    description:
      '仅调用模型一次，跳过 AI 检查和修订，速度与成本最低。适合网文日更、轻创作和快速草稿。上下文仍按当前弹性预算自动装载。',
    subLabel: '一次生成 · 不审稿 · 不复写',
  },
  {
    value: 'standard',
    label: '标准',
    description:
      'Draft → ONE QA → Conditional Revision。默认推荐。生成、检查、修订跟随平衡思考预算。',
    subLabel: '平衡档 · Compact Standard',
  },
  {
    value: 'quality',
    label: '质量',
    description:
      '高质量 Draft → 严格 ONE QA → 按需高质量 Revision。不增加新的 Stage，只提高思考预算。',
    subLabel: '质量档 · Compact Standard',
  },
];

export function isGenerationQualityProfile(
  value: unknown,
): value is GenerationQualityProfile {
  return value === 'fast' || value === 'standard' || value === 'quality';
}

export function normalizeGenerationQualityProfile(
  value: unknown,
): GenerationQualityProfile {
  return isGenerationQualityProfile(value) ? value : 'standard';
}

export function mapGenerationQualityProfile(
  profile: GenerationQualityProfile,
): GenerationQualityMapping {
  if (profile === 'fast') {
    return { executionProfile: 'one_shot', reasoningEffort: 'low' };
  }
  if (profile === 'quality') {
    return { executionProfile: 'standard', reasoningEffort: 'max' };
  }
  return { executionProfile: 'standard', reasoningEffort: 'high' };
}

/**
 * Resolve the user-facing quality from an explicit freeze key, else from
 * the historical executionProfile + reasoningEffort pair.
 */
export function deriveGenerationQualityProfile(input: {
  qualityProfile?: unknown;
  executionProfile?: unknown;
  reasoningEffort?: unknown;
}): GenerationQualityProfile {
  if (isGenerationQualityProfile(input.qualityProfile)) {
    return input.qualityProfile;
  }
  if (normalizeWritingExecutionProfile(input.executionProfile) === 'one_shot') {
    return 'fast';
  }
  if (input.reasoningEffort === 'max') return 'quality';
  return 'standard';
}

export function resolveQualityProfileFromValues(
  values: Record<string, unknown> | undefined | null,
): GenerationQualityProfile | undefined {
  if (isGenerationQualityProfile(values?.qualityProfile)) {
    return values.qualityProfile;
  }
  return undefined;
}

export function generationQualityLabel(
  profile: GenerationQualityProfile | undefined | null,
): string {
  const match = GENERATION_QUALITY_PROFILE_OPTIONS.find(
    option => option.value === profile,
  );
  return match?.label || '标准';
}
