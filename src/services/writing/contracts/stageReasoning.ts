import type { SharedWritingStageName } from './writingPolicy';
import { freezeContinuationThinking } from '../../continuation/generation/continuationV5Models';

export type FrozenKernelStageReasoning = {
  thinking: { type: 'enabled' | 'disabled' };
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max';
};

export type FrozenKernelStageReasoningTable = Partial<
  Record<SharedWritingStageName, FrozenKernelStageReasoning>
>;

const LLM_STAGES: SharedWritingStageName[] = [
  'draft',
  // Phase 4 (二 §7.2 ONE QA): the unified qa stage is an LLM stage too —
  // freeze-time and runtime reasoning tables must both carry it, otherwise
  // resolveFrozenStageReasoning('qa') returns undefined and the shared
  // writer throws on `stageReasoning.thinking`.
  'qa',
  'review',
  'audit',
  'factCheck',
  'revision',
  'proof',
];

function normalizeRequestedEffort(
  value: unknown,
): 'low' | 'high' | 'max' {
  if (value === 'low') return 'low';
  if (value === 'medium') return 'high';
  if (value === 'high' || value === 'max') return value;
  return 'high';
}

/**
 * Freeze-time per-stage thinking. This is the V3.3 / Continuation V4
 * first-pass contract, not a post-Freeze live model read.
 *
 * Outline: thinking stays enabled; FactCheck/Audit stay low.
 * Continuation: honor the frozen continuation thinking (DeepSeek V4 JSON
 * draft is disabled so the body is not eaten by reasoning).
 */
export function compileKernelStageReasoning(input: {
  scenario: 'outline' | 'continuation';
  modelName?: string;
  requestedEffort?: string | null;
  continuationThinking?: { type: 'enabled' | 'disabled' };
  outlineStageReasoning?: Record<
    string,
    {
      thinking?: 'enabled' | 'disabled' | { type: 'enabled' | 'disabled' };
      effort?: 'low' | 'medium' | 'high' | 'max' | null;
      effectiveTier?: 'low' | 'medium' | 'high' | 'max' | null;
    }
  >;
}): Record<SharedWritingStageName, FrozenKernelStageReasoning> {
  const requested = normalizeRequestedEffort(input.requestedEffort);
  const table = {} as Record<SharedWritingStageName, FrozenKernelStageReasoning>;
  for (const stage of LLM_STAGES) {
    const snapshot =
      input.outlineStageReasoning?.[
        stage === 'revision' ? 'brief' : stage
      ] || input.outlineStageReasoning?.[stage];
    if (snapshot) {
      const thinkingType =
        typeof snapshot.thinking === 'string'
          ? snapshot.thinking
          : snapshot.thinking?.type;
      table[stage] = {
        thinking: { type: thinkingType === 'disabled' ? 'disabled' : 'enabled' },
        reasoningEffort:
          snapshot.effort || snapshot.effectiveTier || requested,
      };
      continue;
    }
    if (input.scenario === 'continuation') {
      const thinking =
        input.continuationThinking ||
        freezeContinuationThinking(input.modelName, { type: 'enabled' }) ||
        { type: 'disabled' as const };
      table[stage] = {
        thinking,
        reasoningEffort: thinking.type === 'enabled' ? requested : undefined,
      };
      continue;
    }
    const structuredLow =
      stage === 'factCheck' || stage === 'audit' || stage === 'qa';
    table[stage] = {
      thinking: { type: 'enabled' },
      reasoningEffort: structuredLow ? 'low' : requested,
    };
  }
  table.finalValidate = { thinking: { type: 'disabled' } };
  table.persist = { thinking: { type: 'disabled' } };
  return table;
}

export function resolveFrozenStageReasoning(
  stage: SharedWritingStageName,
  input: {
    stagePolicy: { reviewMode?: string; values?: Record<string, unknown> };
    modelConfig: {
      modelName?: string;
      thinking?: { type: 'enabled' | 'disabled' };
      reasoningEffort?: 'low' | 'medium' | 'high' | 'max';
    };
  },
): FrozenKernelStageReasoning {
  const frozen = input.stagePolicy.values?.stageReasoning as
    | FrozenKernelStageReasoningTable
    | undefined;
  if (frozen?.[stage]?.thinking) return frozen[stage]!;
  const scenario =
    input.stagePolicy.reviewMode === 'continuation-v5'
      ? 'continuation'
      : 'outline';
  return compileKernelStageReasoning({
    scenario,
    modelName: input.modelConfig.modelName,
    requestedEffort: input.modelConfig.reasoningEffort,
    continuationThinking: input.modelConfig.thinking,
  })[stage];
}
