import { sha256Hex } from '../../continuation/hashUtils';
import type {
  WritingRequest,
  WritingSource,
} from './writingSource';

export type WritingRequirementKind =
  | 'outline'
  | 'canon'
  | 'boundary'
  | 'seam'
  | 'anchor'
  | 'style'
  | 'character'
  | 'world-rule'
  | 'obligation'
  | 'plot'
  | 'length'
  | 'protected-passage'
  | 'user-instruction'
  | 'fact'
  | 'continuity';

export type WritingRequirementSeverity =
  | 'mandatory'
  | 'blocking'
  | 'preferred'
  | 'advisory';

export type WritingRequirementValidation =
  | 'semantic'
  | 'literal'
  | 'hash'
  | 'structured'
  | 'local-only';

export interface WritingRequirement {
  id: string;
  kind: WritingRequirementKind;
  severity: WritingRequirementSeverity;
  text: string;
  sourceCandidateId?: string;
  validation: WritingRequirementValidation;
  metadata?: Record<string, unknown>;
}

export interface WritingRequirements {
  version: 1;
  items: WritingRequirement[];
  fingerprint: string;
}

export interface WritingRequirementResult {
  ok: boolean;
  satisfiedIds: string[];
  missingIds: string[];
  blockingIds: string[];
  falseAppliedIds: string[];
}

function kindForSource(source: WritingSource): WritingRequirementKind {
  switch (source.kind) {
    case 'source_boundary':
      return 'boundary';
    case 'primary_anchor':
      return 'anchor';
    case 'writer_style':
      return 'style';
    case 'instruction':
      return 'user-instruction';
    case 'character':
      return 'character';
    case 'worldbook':
      return 'world-rule';
    case 'chapter':
      return 'plot';
    case 'canon':
    case 'outline':
    case 'seam':
      return source.kind;
    case 'story_memory':
    case 'episodic_memory':
    case 'note':
    case 'preset':
    case 'other':
    default:
      return 'continuity';
  }
}

function severityForSource(
  source: WritingSource,
): WritingRequirementSeverity {
  switch (source.requirement) {
    case 'mandatory':
      return 'mandatory';
    case 'preferred':
      return 'preferred';
    case 'optional':
    default:
      return 'advisory';
  }
}

function validationForKind(
  kind: WritingRequirementKind,
): WritingRequirementValidation {
  if (kind === 'boundary' || kind === 'anchor') return 'hash';
  if (kind === 'style' || kind === 'length') return 'structured';
  if (kind === 'user-instruction' || kind === 'outline') return 'semantic';
  if (kind === 'protected-passage') return 'literal';
  return 'semantic';
}

function sourceRequirement(source: WritingSource): WritingRequirement {
  const kind = kindForSource(source);
  return {
    id: `source:${source.candidateId}`,
    kind,
    severity: severityForSource(source),
    text: source.content,
    sourceCandidateId: source.candidateId,
    validation: validationForKind(kind),
    metadata: {
      sourceId: source.sourceId,
      revision: source.revision,
      contentHash: source.contentHash,
      activation: source.activation,
      ...(source.metadata || {}),
    },
  };
}

function explicitRequirements(request: WritingRequest): WritingRequirement[] {
  const values = request.policy.values as Record<string, unknown>;
  const raw = values.requirements;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const text = typeof row.text === 'string' ? row.text.trim() : '';
    if (!text) return [];
    const kind = (typeof row.kind === 'string'
      ? row.kind
      : 'obligation') as WritingRequirementKind;
    const severity = (typeof row.severity === 'string'
      ? row.severity
      : 'mandatory') as WritingRequirementSeverity;
    return [
      {
        id: String(row.id || `policy:${index + 1}`),
        kind,
        severity,
        text,
        validation:
          (typeof row.validation === 'string'
            ? row.validation
            : validationForKind(kind)) as WritingRequirementValidation,
        metadata: row.metadata && typeof row.metadata === 'object'
          ? (row.metadata as Record<string, unknown>)
          : undefined,
      },
    ];
  });
}

/** Convert every pre-Freeze source/policy constraint into one immutable set. */
export function buildWritingRequirements(
  request: WritingRequest,
): WritingRequirements {
  const sources = [
    ...request.sourceBundle.mandatory,
    ...request.sourceBundle.preferred,
    ...request.sourceBundle.optional,
  ];
  const items = [...sources.map(sourceRequirement), ...explicitRequirements(request)]
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    version: 1,
    items,
    fingerprint: sha256Hex(
      JSON.stringify(
        items.map(item => ({
          ...item,
          metadata: item.metadata || null,
        })),
      ),
    ),
  };
}

/** Deterministic local result used by Review/Audit/Final Validate. */
export function evaluateWritingRequirements(input: {
  requirements: WritingRequirements;
  satisfiedIds?: Iterable<string>;
  appliedIds?: Iterable<string>;
}): WritingRequirementResult {
  const satisfied = new Set(input.satisfiedIds || []);
  const applied = new Set(input.appliedIds || []);
  const missingIds = input.requirements.items
    .filter(item =>
      (item.severity === 'mandatory' || item.severity === 'blocking') &&
      !satisfied.has(item.id),
    )
    .map(item => item.id);
  const blockingIds = input.requirements.items
    .filter(item => item.severity === 'blocking' && !satisfied.has(item.id))
    .map(item => item.id);
  const falseAppliedIds = [...applied].filter(
    id => !input.requirements.items.some(item => item.id === id),
  );
  return {
    ok: missingIds.length === 0 && falseAppliedIds.length === 0,
    satisfiedIds: [...satisfied].sort(),
    missingIds,
    blockingIds,
    falseAppliedIds,
  };
}
