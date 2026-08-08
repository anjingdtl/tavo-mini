import type { PipelineExecutionSnapshot } from '../../types/pipelineExecution';
import type { PipelineRevisionContract } from '../../types/pipelineRevision';
import type { LLMRequestConfig, ReasoningEffort } from '../llm/types';
import { resolvePipelineReasoning } from './reasoningPolicy';

/** Frozen policy version for the Outline V2 Final Reviser. */
export type FinalReviserReasoningPolicyVersion = 1 | 2;

/** New tasks opt into the adaptive policy; historical snapshots stay Legacy. */
export const CURRENT_FINAL_REVISER_REASONING_POLICY_VERSION: FinalReviserReasoningPolicyVersion = 2;

export interface FinalReviserReasoningDecision {
  policyVersion: FinalReviserReasoningPolicyVersion | undefined;
  effort?: ReasoningEffort;
  thinking?: { type: 'enabled' };
  supported: boolean;
  complexity: 'legacy' | 'simple' | 'complex' | 'global';
}

/**
 * Deterministically classify the already compiled revision contract.  This
 * function deliberately receives no live settings, time, randomness or LLM
 * output beyond the frozen/normalized contract.
 */
export function classifyFinalReviserComplexity(
  contract: Pick<PipelineRevisionContract, 'workItems' | 'outlineObligations'>,
): Exclude<FinalReviserReasoningDecision['complexity'], 'legacy'> {
  const workItems = Array.isArray(contract.workItems) ? contract.workItems : [];
  const obligations = contract.outlineObligations;
  const hardItems = workItems.filter(item =>
    item.severity === 'hard' &&
    /(constraint|事实|知识|时间线|continuity|冲突)/i.test(
      String(item.dimension || ''),
    ),
  );

  if (
    workItems.some(item => item.scope === 'chapter') ||
    hardItems.length >= 2
  ) {
    return 'global';
  }

  if (
    workItems.length >= 6 ||
    workItems.some(item => item.scope === 'range') ||
    obligations.missingBeats.length > 0 ||
    obligations.mustNotAdvance.length > 0 ||
    Boolean(obligations.endingGoal && obligations.endingGoal.trim())
  ) {
    return 'complex';
  }

  return 'simple';
}

/**
 * Resolve the Final Reviser request semantics from the frozen product tier.
 * The same selected tier is used by Draft / Review / FactCheck / Proof; the
 * contract complexity remains diagnostic and no longer silently overrides the
 * user's pipeline-level choice.
 */
export function resolveFinalReviserReasoning(params: {
  execution: Pick<
    PipelineExecutionSnapshot,
    | 'outlineWorkflowVersion'
    | 'finalReviserReasoningPolicyVersion'
    | 'reasoningEffort'
  >;
  model: Pick<LLMRequestConfig, 'provider_type' | 'model_name' | 'url'>;
  contract: Pick<PipelineRevisionContract, 'workItems' | 'outlineObligations'>;
}): FinalReviserReasoningDecision {
  const policyVersion = params.execution.finalReviserReasoningPolicyVersion;
  if (params.execution.outlineWorkflowVersion !== 2 || policyVersion !== 2) {
    return {
      policyVersion,
      supported: false,
      complexity: 'legacy',
    };
  }

  const complexity = classifyFinalReviserComplexity(params.contract);
  const resolved = resolvePipelineReasoning(params.execution, params.model);
  if (!resolved.effort || !resolved.supported || !resolved.thinking) {
    return {
      policyVersion,
      supported: false,
      complexity,
    };
  }

  return {
    policyVersion,
    effort: resolved.effort as ReasoningEffort,
    thinking: resolved.thinking,
    supported: true,
    complexity,
  };
}
