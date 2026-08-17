/**
 * Execution Profile contract for the 极速 (One-Shot) tier.
 *
 * The profile is a PIPELINE EXECUTION STRATEGY expressed only through the
 * frozen WritingStagePolicy (skip rules + values). It is deliberately NOT a
 * reasoningEffort tier and never selects a second Writer Core, Prompt
 * Compiler, or Context Builder. It also never caps the input context: the
 * existing Hierarchical / Elastic Context Budget is inherited unchanged —
 * 极速 runs fewer stages, it does not shrink the prompt.
 */

/** User-selectable execution profiles. `standard` is the historical default. */
export type WritingExecutionProfile = 'standard' | 'one_shot';

export interface WritingExecutionProfilePolicy {
  id: WritingExecutionProfile;
  /** Hard cap on paid LLM requests per chapter under this profile. */
  maxPaidLlmCalls: number;
  /** Whether the thinking-disabled Formatter rescue call may run. */
  allowFormatter: boolean;
  /** Whether an automatic Primary retry/replay may run. */
  allowPrimaryRetry: boolean;
}

export const ONE_SHOT_EXECUTION_PROFILE_POLICY: WritingExecutionProfilePolicy =
  {
    id: 'one_shot',
    maxPaidLlmCalls: 1,
    allowFormatter: false,
    allowPrimaryRetry: false,
  };

export function normalizeWritingExecutionProfile(
  value: unknown,
): WritingExecutionProfile {
  return value === 'one_shot' ? 'one_shot' : 'standard';
}

/** Read the frozen profile from policy values (the only post-Freeze source). */
export function resolveExecutionProfileFromValues(
  values: Record<string, unknown> | undefined | null,
): WritingExecutionProfile {
  return normalizeWritingExecutionProfile(values?.executionProfile);
}

export function isOneShotValues(
  values: Record<string, unknown> | undefined | null,
): boolean {
  return resolveExecutionProfileFromValues(values) === 'one_shot';
}

export function isOneShotStagePolicy(policy: {
  values?: Record<string, unknown>;
} | null | undefined): boolean {
  return isOneShotValues(policy?.values);
}

/** True when the frozen policy forbids the Formatter rescue call. */
export function allowsFormatterCall(policy: {
  values?: Record<string, unknown>;
} | null | undefined): boolean {
  if (isOneShotStagePolicy(policy)) return false;
  return true;
}

/** True when the frozen policy forbids an automatic Primary retry. */
export function allowsPrimaryRetry(policy: {
  values?: Record<string, unknown>;
} | null | undefined): boolean {
  if (isOneShotStagePolicy(policy)) return false;
  return true;
}
