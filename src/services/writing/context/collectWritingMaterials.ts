import type { WritingRequest, WritingSource } from '../contracts/writingSource';
import { assertValidWritingSourceBundle } from '../contracts/writingSourceValidation';
import type { WritingMaterialCandidate } from '../contracts/frozenWritingContext';

export interface CollectedWritingMaterials {
  sources: WritingSource[];
  candidates: WritingMaterialCandidate[];
}

/** Collect only the Source Contract; no repositories or budget decisions. */
export function collectWritingMaterials(
  request: WritingRequest,
): CollectedWritingMaterials {
  assertValidWritingSourceBundle(request.scenario, request.sourceBundle);
  const sources = [
    ...request.sourceBundle.mandatory,
    ...request.sourceBundle.preferred,
    ...request.sourceBundle.optional,
  ];
  return {
    sources: sources.map(source => ({ ...source })),
    candidates: sources.map((source, sourceOrder) => ({
      source: { ...source },
      sourceOrder,
      demandTokens: Math.max(1, Math.ceil(source.content.length / 4)),
    })),
  };
}
