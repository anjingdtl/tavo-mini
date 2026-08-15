import { sha256Hex } from '../../continuation/hashUtils';
import type {
  WritingContextPlan,
  WritingContextPlanItem,
} from '../contracts/frozenWritingContext';
import type { NormalizedWritingMaterials } from './normalizeWritingMaterials';

export function buildWritingContextPlan(
  input: NormalizedWritingMaterials,
): WritingContextPlan {
  const items: WritingContextPlanItem[] = input.candidates.map(candidate => ({
    candidateId: candidate.source.candidateId,
    requirement: candidate.source.requirement,
    selected: Boolean(candidate.source.content),
    priority:
      candidate.source.requirement === 'mandatory'
        ? 100
        : candidate.source.requirement === 'preferred'
          ? 50
          : 10,
    demandTokens: candidate.demandTokens,
    selectionReason: candidate.source.content ? 'source_contract_present' : null,
    exclusionReason: candidate.source.content ? null : 'empty_optional_source',
  }));
  const fingerprint = sha256Hex(JSON.stringify(items));
  return { version: 1, items, fingerprint };
}
