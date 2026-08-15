import { estimateTokens } from '../../../utils/tokenEstimator';
import { sha256Hex } from '../../continuation/hashUtils';
import type { Chapter } from '../../../types/novel';
import type {
  GenerationCandidateContractV1,
  GenerationMaterialCandidate,
  NormalizedGenerationMaterials,
  CollectedGenerationMaterials,
} from './generationContracts';

function sourceContentHash(content: string): string {
  return sha256Hex(content);
}

function normalizeResourceCandidate(
  candidate: Partial<GenerationMaterialCandidate> & { candidateId: string },
  index: number,
): GenerationMaterialCandidate {
  const content = String(candidate.content ?? '');
  const demandTokens = Math.max(
    0,
    Math.floor(Number(candidate.demandTokens) || estimateTokens(content)),
  );
  const requirement = candidate.requirement ?? 'optional';
  const activation = candidate.activation ?? 'automatic';
  return {
    candidateId: String(candidate.candidateId),
    sourceType: candidate.sourceType ?? 'other',
    sourceId: candidate.sourceId ?? null,
    sourceRevision: candidate.sourceRevision ?? null,
    contentHash: candidate.contentHash || sourceContentHash(content),
    activation,
    selected: Boolean(candidate.selected ?? content),
    selectedReason:
      candidate.selectedReason ?? (content ? 'collected_and_eligible' : null),
    rejectedReason: candidate.rejectedReason ?? null,
    requirement,
    relevance:
      candidate.relevance == null
        ? null
        : Math.min(1, Math.max(0, Number(candidate.relevance) || 0)),
    priority:
      candidate.priority == null ? null : Math.max(0, Number(candidate.priority) || 0),
    selectionBoost:
      candidate.selectionBoost == null
        ? null
        : Math.max(0, Number(candidate.selectionBoost) || 0),
    demandTokens,
    content,
    sourceOrder: Number.isFinite(candidate.sourceOrder)
      ? Number(candidate.sourceOrder)
      : index,
  };
}

function normalizeChapterList(
  chapters: Chapter[],
  currentPosition: number,
): Chapter[] {
  return chapters
    .filter(chapter => Number(chapter.position) < currentPosition)
    .map(chapter => ({ ...chapter }))
    .sort((a, b) => Number(a.position) - Number(b.position));
}

function rejectedFutureCandidate(
  chapter: Chapter,
): GenerationCandidateContractV1 {
  const content = String(chapter.content || chapter.summary_json || '');
  return {
    candidateId: `chapter:${chapter.id ?? chapter.position}`,
    sourceType: 'chapter',
    sourceId: chapter.id ?? chapter.position,
    sourceRevision: String(chapter.updated_at ?? ''),
    contentHash: sourceContentHash(content),
    activation: 'automatic',
    selected: false,
    selectedReason: null,
    rejectedReason: 'future_source_guard',
    requirement: 'optional',
    relevance: null,
    priority: null,
    selectionBoost: null,
    demandTokens: estimateTokens(content),
  };
}

/**
 * Normalize is deliberately pure. It owns source identity/revision defaults,
 * empty content semantics, stable ordering, and the future-source boundary;
 * it does not read a repository, rank candidates, allocate budget, or render
 * messages.
 */
export function normalizeGenerationMaterials(
  input: CollectedGenerationMaterials,
): NormalizedGenerationMaterials {
  const currentPosition = Number(input.currentChapter.position);
  const previousChapters = normalizeChapterList(
    input.previousChapters,
    currentPosition,
  );
  const episodicCandidates = normalizeChapterList(
    input.episodicCandidates,
    currentPosition,
  );
  const rejectedCandidates = [
    ...((input.previousChapters || [])
      .filter(chapter => Number(chapter.position) >= currentPosition)
      .map(rejectedFutureCandidate)),
    ...((input.episodicCandidates || [])
      .filter(chapter => Number(chapter.position) >= currentPosition)
      .map(rejectedFutureCandidate)),
  ];
  const resourceCandidates = (input.resourceCandidates || []).map(
    (candidate, index) => normalizeResourceCandidate(candidate, index),
  );
  return {
    ...input,
    chapters: (input.chapters || []).map(chapter => ({ ...chapter })),
    previousChapters,
    episodicCandidates,
    resourceCandidates,
    rejectedCandidates,
  };
}
