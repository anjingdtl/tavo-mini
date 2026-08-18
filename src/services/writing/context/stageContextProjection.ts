/**
 * Deterministic Stage Projection over ONE Frozen Context.
 *
 * This is not a second budget and not five stage-specific allocators.
 * It only subsets already-rendered frozen candidates by kind allowlist.
 */
import { estimateTokens } from '../../../utils/tokenEstimator';
import { sha256Hex } from '../../continuation/hashUtils';
import type { FrozenWritingContext } from '../contracts/frozenWritingContext';
import type { SharedWritingStageName } from '../contracts/writingPolicy';
import type { WritingSourceKind } from '../contracts/writingSource';

export const STAGE_CONTEXT_PROJECTION_VERSION = 1 as const;

/** '*' = keep the full frozen render. Arrays are kind allowlists. */
export const STAGE_CONTEXT_KIND_ALLOWLIST: Record<
  SharedWritingStageName,
  '*' | readonly WritingSourceKind[]
> = {
  draft: '*',
  review: ['instruction', 'outline', 'writer_style', 'preset', 'note'],
  audit: [
    'canon',
    'source_boundary',
    'seam',
    'primary_anchor',
    'character',
    'worldbook',
    'story_memory',
    'structured_continuity_state',
  ],
  factCheck: [
    'canon',
    'source_boundary',
    'seam',
    'primary_anchor',
    'character',
    'worldbook',
    'story_memory',
    'structured_continuity_state',
  ],
  revision: [
    'instruction',
    'outline',
    'canon',
    'source_boundary',
    'writer_style',
    'story_memory',
    'structured_continuity_state',
  ],
  proof: ['writer_style', 'instruction'],
  finalValidate: [],
  persist: [],
};

export interface StageContextProjection {
  version: typeof STAGE_CONTEXT_PROJECTION_VERSION;
  stage: SharedWritingStageName;
  text: string;
  includedCandidateIds: string[];
  includedKinds: WritingSourceKind[];
  projectedTokens: number;
  fingerprint: string;
  carriesFullFrozenContext: boolean;
}

export function projectFrozenContextForStage(input: {
  frozenContext: FrozenWritingContext;
  stage: SharedWritingStageName;
}): StageContextProjection {
  const allowlist = STAGE_CONTEXT_KIND_ALLOWLIST[input.stage];
  const fullText = input.frozenContext.rendered?.text || '';
  const materials = input.frozenContext.materials ?? [];
  const renderedItems = input.frozenContext.rendered?.items ?? [];
  if (allowlist === '*' || materials.length === 0) {
    const kinds = uniqueKinds(materials);
    const includedCandidateIds = includedRenderedIds(renderedItems);
    return {
      version: STAGE_CONTEXT_PROJECTION_VERSION,
      stage: input.stage,
      text: fullText,
      includedCandidateIds,
      includedKinds: kinds,
      projectedTokens: estimateTokens(fullText),
      fingerprint: sha256Hex(
        JSON.stringify({
          v: STAGE_CONTEXT_PROJECTION_VERSION,
          stage: input.stage,
          ids: includedCandidateIds,
          text: fullText,
        }),
      ),
      carriesFullFrozenContext: fullText.length > 0,
    };
  }

  const allow = new Set<WritingSourceKind>(allowlist);
  const kindById = new Map(
    materials.map(item => [item.source.candidateId, item.source.kind]),
  );
  const blocks: string[] = [];
  const includedCandidateIds: string[] = [];
  const includedKinds: WritingSourceKind[] = [];
  for (const item of renderedItems) {
    if (!item.included) continue;
    const kind = kindById.get(item.candidateId);
    if (!kind || !allow.has(kind)) continue;
    const block = extractRenderedBlock(fullText, kind, item.candidateId);
    if (!block) continue;
    blocks.push(block);
    includedCandidateIds.push(item.candidateId);
    if (!includedKinds.includes(kind)) includedKinds.push(kind);
  }
  const text = blocks.join('\n\n');
  return {
    version: STAGE_CONTEXT_PROJECTION_VERSION,
    stage: input.stage,
    text,
    includedCandidateIds,
    includedKinds,
    projectedTokens: estimateTokens(text),
    fingerprint: sha256Hex(
      JSON.stringify({
        v: STAGE_CONTEXT_PROJECTION_VERSION,
        stage: input.stage,
        ids: includedCandidateIds,
        text,
      }),
    ),
    carriesFullFrozenContext: false,
  };
}

function uniqueKinds(
  materials: FrozenWritingContext['materials'],
): WritingSourceKind[] {
  const kinds: WritingSourceKind[] = [];
  for (const item of materials) {
    if (!kinds.includes(item.source.kind)) kinds.push(item.source.kind);
  }
  return kinds;
}

function includedRenderedIds(
  items: NonNullable<FrozenWritingContext['rendered']>['items'],
): string[] {
  return items.filter(item => item.included).map(item => item.candidateId);
}

function extractRenderedBlock(
  renderedText: string,
  kind: WritingSourceKind,
  candidateId: string,
): string {
  const header = `【${kind}:${candidateId}】`;
  const start = renderedText.indexOf(header);
  if (start < 0) return '';
  const next = renderedText.indexOf('\n\n【', start + header.length);
  return next < 0
    ? renderedText.slice(start).trim()
    : renderedText.slice(start, next).trim();
}
