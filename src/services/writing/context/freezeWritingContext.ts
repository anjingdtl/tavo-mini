import { sha256Hex } from '../../continuation/hashUtils';
import type { WritingRequest } from '../contracts/writingSource';
import type {
  FrozenWritingContext,
  WritingBudgetAllocation,
  WritingContextPlan,
  RenderedWritingContext,
  WritingMaterialCandidate,
} from '../contracts/frozenWritingContext';
import { fingerprintWritingSourceBundle } from '../contracts/writingFingerprint';

export function freezeWritingContext(input: {
  request: WritingRequest;
  candidates: WritingMaterialCandidate[];
  plan: WritingContextPlan;
  allocation: WritingBudgetAllocation;
  rendered: RenderedWritingContext;
}): FrozenWritingContext {
  const sourceFingerprint = fingerprintWritingSourceBundle(input.request.sourceBundle);
  const freezeFingerprint = sha256Hex(
    JSON.stringify({
      writingRunId: input.request.writingRunId,
      generationTraceId: input.request.generationTraceId,
      projectId: input.request.projectId,
      chapterId: input.request.chapterId,
      instruction: input.request.instruction,
      sourceFingerprint,
      plan: input.plan.fingerprint,
      allocation: input.allocation.fingerprint,
      rendered: input.rendered.fingerprint,
      model: input.request.model,
      policy: input.request.policy,
    }),
  );
  return {
    version: 1,
    writingRunId: input.request.writingRunId,
    generationTraceId: input.request.generationTraceId,
    projectId: input.request.projectId,
    chapterId: input.request.chapterId,
    instruction: { ...input.request.instruction },
    sourceBundle: {
      mandatory: input.request.sourceBundle.mandatory.map(source => ({ ...source })),
      preferred: input.request.sourceBundle.preferred.map(source => ({ ...source })),
      optional: input.request.sourceBundle.optional.map(source => ({ ...source })),
    },
    model: { ...input.request.model },
    policy: { ...input.request.policy, values: { ...input.request.policy.values } },
    materials: input.candidates.map(candidate => ({
      source: { ...candidate.source },
      sourceOrder: candidate.sourceOrder,
      demandTokens: candidate.demandTokens,
    })),
    plan: { ...input.plan, items: input.plan.items.map(item => ({ ...item })) },
    allocation: {
      ...input.allocation,
      items: input.allocation.items.map(item => ({ ...item })),
    },
    rendered: {
      ...input.rendered,
      items: input.rendered.items.map(item => ({ ...item })),
    },
    sourceFingerprint,
    freezeFingerprint,
  };
}
