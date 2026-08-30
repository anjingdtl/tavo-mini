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

/**
 * Phase IV composition evidence. It describes the deterministic projection,
 * not a second allocator and not a model decision.
 */
export interface StageContextComposition {
  version: 1;
  mode: 'phase4';
  mandatoryCandidateIds: string[];
  includedPreferredCandidateIds: string[];
  includedOptionalCandidateIds: string[];
  droppedPreferredCandidateIds: string[];
  droppedOptionalCandidateIds: string[];
  mandatoryTokens: number;
  preferredTokens: number;
  optionalTokens: number;
}

/** '*' = keep the full frozen render. Arrays are kind allowlists. */
export const STAGE_CONTEXT_KIND_ALLOWLIST: Record<
  SharedWritingStageName,
  '*' | readonly WritingSourceKind[]
> = {
  draft: '*',
  // Phase 4 §7.2 ONE QA: the unified qa stage is the deterministic projection
  // that replaces Review / Audit / FactCheck. The allowlist is the union of
  // the three legacy QA lists (deduplicated) so every scenario's required
  // context is reachable from one stage. Scenario differences (Outline vs
  // Continuation) reach the QA only via frozen requirements, not via a
  // second context builder.
  qa: [
    'instruction',
    'outline',
    'writer_style',
    'preset',
    'note',
    'canon',
    'source_boundary',
    'seam',
    'primary_anchor',
    'character',
    'worldbook',
    'story_memory',
    'structured_continuity_state',
  ],
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
    'seam',
    'primary_anchor',
    'chapter',
    'writer_style',
    'preset',
    'story_memory',
    'structured_continuity_state',
    'character',
    'worldbook',
    'note',
    'episodic_memory',
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
  composition?: StageContextComposition;
}

export function projectFrozenContextForStage(input: {
  frozenContext: FrozenWritingContext;
  stage: SharedWritingStageName;
}): StageContextProjection {
  const allowlist = STAGE_CONTEXT_KIND_ALLOWLIST[input.stage];
  const fullText = input.frozenContext.rendered?.text || '';
  const materials = input.frozenContext.materials ?? [];
  const renderedItems = input.frozenContext.rendered?.items ?? [];
  const phase4 = input.frozenContext.stagePolicy?.values?.phase4GatePolicyVersion ===
    'phase4-gates-v1';
  if (phase4 && (input.stage === 'qa' || input.stage === 'revision')) {
    return projectPhase4ElasticContext({
      frozenContext: input.frozenContext,
      stage: input.stage,
      fullText,
      materials,
      renderedItems,
    });
  }
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

const PHASE4_ELASTIC_KINDS: Record<
  'qa' | 'revision',
  readonly WritingSourceKind[]
> = {
  qa: [
    'instruction',
    'outline',
    'writer_style',
    'canon',
    'source_boundary',
    'seam',
    'primary_anchor',
    'story_memory',
    'structured_continuity_state',
  ],
  revision: [
    'instruction',
    'outline',
    'writer_style',
    'canon',
    'source_boundary',
    'seam',
    'primary_anchor',
    'story_memory',
    'structured_continuity_state',
  ],
};

function projectPhase4ElasticContext(input: {
  frozenContext: FrozenWritingContext;
  stage: 'qa' | 'revision';
  fullText: string;
  materials: FrozenWritingContext['materials'];
  renderedItems: NonNullable<FrozenWritingContext['rendered']>['items'];
}): StageContextProjection {
  const materialById = new Map(
    input.materials.map(item => [item.source.candidateId, item.source]),
  );
  const allow = new Set(PHASE4_ELASTIC_KINDS[input.stage]);
  const blocks: string[] = [];
  const includedCandidateIds: string[] = [];
  const includedKinds: WritingSourceKind[] = [];
  const mandatoryCandidateIds: string[] = [];
  const includedPreferredCandidateIds: string[] = [];
  const includedOptionalCandidateIds: string[] = [];
  const droppedPreferredCandidateIds: string[] = [];
  const droppedOptionalCandidateIds: string[] = [];
  let mandatoryTokens = 0;
  let preferredTokens = 0;
  let optionalTokens = 0;

  for (const item of input.renderedItems) {
    const source = materialById.get(item.candidateId);
    if (!source) continue;
    const requirement = source.requirement;
    const block = item.included
      ? extractRenderedBlock(input.fullText, source.kind, item.candidateId)
      : '';
    // Phase IV pre-seal correction: relevance/value decides retention, never
    // kind alone.  Mandatory is always kept; a user-explicit or preferred
    // source stays even when its kind is not stage-allowlisted; only
    // low-relevance automatic Optional sources are trimmed first.  This is
    // still the same single frozen-context subset (no second builder).
    const valueEscapesKindFilter =
      source.activation === 'explicit' || requirement === 'preferred';
    const shouldInclude = Boolean(block) &&
      (requirement === 'mandatory' ||
        allow.has(source.kind) ||
        valueEscapesKindFilter);

    if (shouldInclude) {
      blocks.push(block);
      includedCandidateIds.push(item.candidateId);
      if (!includedKinds.includes(source.kind)) includedKinds.push(source.kind);
      if (requirement === 'mandatory') {
        mandatoryCandidateIds.push(item.candidateId);
        mandatoryTokens += estimateTokens(block);
      } else if (requirement === 'preferred') {
        includedPreferredCandidateIds.push(item.candidateId);
        preferredTokens += estimateTokens(block);
      } else {
        includedOptionalCandidateIds.push(item.candidateId);
        optionalTokens += estimateTokens(block);
      }
      continue;
    }

    if (requirement === 'mandatory') {
      // A missing rendered Mandatory source is recorded as absent by the
      // upstream freeze contract; this projection never silently promotes a
      // non-mandatory source in its place.
      mandatoryCandidateIds.push(item.candidateId);
    } else if (requirement === 'preferred') {
      droppedPreferredCandidateIds.push(item.candidateId);
    } else {
      droppedOptionalCandidateIds.push(item.candidateId);
    }
  }

  const text = blocks.join('\n\n');
  const composition: StageContextComposition = {
    version: 1,
    mode: 'phase4',
    mandatoryCandidateIds,
    includedPreferredCandidateIds,
    includedOptionalCandidateIds,
    droppedPreferredCandidateIds,
    droppedOptionalCandidateIds,
    mandatoryTokens,
    preferredTokens,
    optionalTokens,
  };
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
        mode: 'phase4',
        stage: input.stage,
        ids: includedCandidateIds,
        text,
        composition,
      }),
    ),
    carriesFullFrozenContext: false,
    composition,
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
