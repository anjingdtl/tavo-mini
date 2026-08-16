import { sha256Hex } from '../../continuation/hashUtils';
import type {
  FrozenWritingContext,
  WritingKernelStage,
  WritingKernelStageEvent,
  WritingKernelTrace,
} from '../contracts/frozenWritingContext';
import type { WritingRequest } from '../contracts/writingSource';

export function createWritingKernelTrace(input: {
  request: WritingRequest;
  frozenContext: FrozenWritingContext;
  events?: WritingKernelStageEvent[];
}): WritingKernelTrace {
  return {
    version: 1,
    writingRunId: input.request.writingRunId,
    generationTraceId: input.request.generationTraceId,
    scenario: input.request.scenario,
    sourceFingerprint: input.frozenContext.sourceFingerprint,
    contextPlanFingerprint: input.frozenContext.plan.fingerprint,
    allocationFingerprint: input.frozenContext.allocation.fingerprint,
    renderFingerprint: input.frozenContext.rendered.fingerprint,
    freezeFingerprint: input.frozenContext.freezeFingerprint,
    requirementsFingerprint: input.frozenContext.requirements.fingerprint,
    stagePolicyFingerprint: sha256Hex(
      JSON.stringify(input.frozenContext.stagePolicy),
    ),
    events: [...(input.events || [])],
    silentContextLossCount: input.frozenContext.allocation.items.filter(
      item => item.clipped && item.allocationReason === 'mandatory_budget_clipped_and_traced',
    ).length,
    unexpectedLiveReadCount: 0,
    fatalCount: 0,
    falseAppliedRequirementCount: 0,
  };
}

export function appendWritingKernelStageEvent(
  trace: WritingKernelTrace,
  stage: WritingKernelStage,
  status: WritingKernelStageEvent['status'],
  detail?: string,
): WritingKernelTrace {
  return {
    ...trace,
    events: [...trace.events, { stage, status, ...(detail ? { detail } : {}) }],
  };
}

export function fingerprintWritingKernelDecision(trace: WritingKernelTrace): string {
  return sha256Hex(
    JSON.stringify({
      ...trace,
      events: trace.events,
    }),
  );
}
