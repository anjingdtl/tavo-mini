import { sha256Hex } from '../../continuation/hashUtils';
import type { WritingRequest } from '../contracts/writingSource';
import type {
  FrozenWritingContext,
  WritingBudgetAllocation,
  WritingContextPlan,
  RenderedWritingContext,
  WritingMaterialCandidate,
} from '../contracts/frozenWritingContext';
import type { WritingRequirements } from '../contracts/writingRequirement';
import type { WritingStagePolicy } from '../contracts/writingPolicy';
import { fingerprintWritingSourceBundle } from '../contracts/writingFingerprint';
import { buildChapterTruthProjection } from '../contracts/chapterTruthProjection';

export function freezeWritingContext(input: {
  request: WritingRequest;
  candidates: WritingMaterialCandidate[];
  plan: WritingContextPlan;
  allocation: WritingBudgetAllocation;
  rendered: RenderedWritingContext;
  requirements: WritingRequirements;
  stagePolicy: WritingStagePolicy;
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
      requirements: input.requirements.fingerprint,
      stagePolicy: input.stagePolicy,
    }),
  );
  const frozen: FrozenWritingContext = {
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
    requirements: {
      ...input.requirements,
      items: input.requirements.items.map(item => ({
        ...item,
        metadata: item.metadata ? { ...item.metadata } : undefined,
      })),
    },
    stagePolicy: {
      ...input.stagePolicy,
      stageOrder: [...input.stagePolicy.stageOrder],
      values: { ...input.stagePolicy.values },
    },
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
  frozen.truthProjection = buildChapterTruthProjection(frozen);
  return frozen;
}
