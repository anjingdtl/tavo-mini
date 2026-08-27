import { sha256Hex } from '../../continuation/hashUtils';
import type {
  WritingMaterialCandidate,
} from '../contracts/frozenWritingContext';
import { writingSourceContentHash } from '../contracts/writingFingerprint';
import type { WritingSource } from '../contracts/writingSource';
import type { CollectedWritingMaterials } from './collectWritingMaterials';
import { estimateTokens } from '../../../utils/tokenEstimator';

export interface NormalizedWritingMaterials {
  sources: WritingSource[];
  candidates: WritingMaterialCandidate[];
  rejectedCandidateIds: string[];
  fingerprint: string;
}

/** Pure identity/hash/empty-content normalization. */
export function normalizeWritingMaterials(
  input: CollectedWritingMaterials,
): NormalizedWritingMaterials {
  const seen = new Set<string>();
  const rejectedCandidateIds: string[] = [];
  const candidates = input.candidates
    .map(candidate => {
      const content = String(candidate.source.content ?? '').trim();
      const source = {
        ...candidate.source,
        content,
        contentHash: writingSourceContentHash(content),
        revision: candidate.source.revision
          ? String(candidate.source.revision)
          : null,
      };
      return {
        ...candidate,
        source,
        // Recompute after normalization with the same tokenizer used by
        // renderWritingContext; never use a character-count proxy here.
        demandTokens: Math.max(1, estimateTokens(content)),
      };
    })
    .filter(candidate => {
      if (seen.has(candidate.source.candidateId)) {
        rejectedCandidateIds.push(candidate.source.candidateId);
        return false;
      }
      seen.add(candidate.source.candidateId);
      if (!candidate.source.content && candidate.source.requirement !== 'mandatory') {
        rejectedCandidateIds.push(candidate.source.candidateId);
        return false;
      }
      return true;
    })
    .sort((left, right) => left.source.candidateId.localeCompare(right.source.candidateId));

  const sources = candidates.map(candidate => candidate.source);
  const fingerprint = sha256Hex(
    JSON.stringify(
      candidates.map(candidate => ({
        candidateId: candidate.source.candidateId,
        kind: candidate.source.kind,
        contentHash: candidate.source.contentHash,
        revision: candidate.source.revision,
        requirement: candidate.source.requirement,
      })),
    ),
  );
  return { sources, candidates, rejectedCandidateIds, fingerprint };
}
