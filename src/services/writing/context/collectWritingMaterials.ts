import type { WritingRequest, WritingSource } from '../contracts/writingSource';
import { assertValidWritingSourceBundle } from '../contracts/writingSourceValidation';
import type { WritingMaterialCandidate } from '../contracts/frozenWritingContext';
import { estimateTokens } from '../../../utils/tokenEstimator';

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
      // Keep demand, allocation and clipping on the same tokenizer. A
      // character-count heuristic truncates CJK resource names before the
      // entity body, which makes the Evidence QA hit gate silently fall back.
      demandTokens: Math.max(1, estimateTokens(source.content)),
    })),
  };
}
