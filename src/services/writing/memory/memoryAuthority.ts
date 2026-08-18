/**
 * ONE Memory authority ranks and hard-fact conflict rules.
 *
 * This module is policy only. It does not store narrative memory, does not
 * call an LLM, and does not replace Story Memory or Canon.
 *
 * Rank (highest first):
 *   Canon
 *   Frozen Source Boundary
 *   Structured Continuity State
 *   Story Memory
 *   Recent Prose
 *
 * Conflict:
 *   Story Memory ≠ Canon → Canon wins
 *   Story Memory ≠ Continuity State → State wins
 *   Continuity State ≠ Canon (hard fact) → Conflict Gate
 */
export const MEMORY_AUTHORITY_ORDER = [
  'canon',
  'frozen_source_boundary',
  'structured_continuity_state',
  'story_memory',
  'recent_prose',
] as const;

export type MemoryAuthorityLayer = (typeof MEMORY_AUTHORITY_ORDER)[number];

export type MemoryConflictKind =
  | 'none'
  | 'story_memory_vs_canon'
  | 'story_memory_vs_continuity_state'
  | 'continuity_state_vs_canon'
  | 'boundary_vs_lower'
  | 'incomparable';

export const HARD_CONTINUITY_FIELDS = [
  'aliveState',
  'knowledgeBoundary',
  'identityState',
] as const;

export const SOFT_CONTINUITY_FIELDS = [
  'location',
  'physicalState',
  'emotionalState',
  'currentGoal',
  'activePlotThread',
] as const;

export type HardContinuityField = (typeof HARD_CONTINUITY_FIELDS)[number];
export type SoftContinuityField = (typeof SOFT_CONTINUITY_FIELDS)[number];

const HARD_FIELD_SET = new Set<string>(HARD_CONTINUITY_FIELDS);

export function memoryAuthorityRank(layer: MemoryAuthorityLayer): number {
  return MEMORY_AUTHORITY_ORDER.indexOf(layer);
}

export function compareMemoryAuthority(
  left: MemoryAuthorityLayer,
  right: MemoryAuthorityLayer,
): number {
  return memoryAuthorityRank(left) - memoryAuthorityRank(right);
}

export function isHardContinuityField(field: string): field is HardContinuityField {
  return HARD_FIELD_SET.has(field);
}

/**
 * Hard-fact conflict: both sides have a concrete, unequal value.
 * `unknown` / empty does not escalate.
 */
export function isHardFactConflict(
  field: string,
  higherValue: unknown,
  lowerValue: unknown,
): boolean {
  if (!isHardContinuityField(field)) return false;
  const left = normalizeFactValue(higherValue);
  const right = normalizeFactValue(lowerValue);
  if (left == null || right == null) return false;
  if (left === 'unknown' || right === 'unknown') return false;
  return left !== right;
}

export function resolveNarrativeFactConflict(input: {
  left: { layer: MemoryAuthorityLayer; value: unknown };
  right: { layer: MemoryAuthorityLayer; value: unknown };
  field?: string;
}): {
  winner: MemoryAuthorityLayer;
  loser: MemoryAuthorityLayer;
  kind: MemoryConflictKind;
  requiresUserConfirmation: boolean;
  winnerValue: unknown;
} {
  const cmp = compareMemoryAuthority(input.left.layer, input.right.layer);
  const higher = cmp <= 0 ? input.left : input.right;
  const lower = cmp <= 0 ? input.right : input.left;
  const valuesEqual =
    normalizeFactValue(input.left.value) === normalizeFactValue(input.right.value);

  if (valuesEqual || cmp === 0) {
    return {
      winner: higher.layer,
      loser: lower.layer,
      kind: 'none',
      requiresUserConfirmation: false,
      winnerValue: higher.value,
    };
  }

  const kind = classifyConflictKind(higher.layer, lower.layer);
  const hard =
    input.field != null ? isHardFactConflict(input.field, higher.value, lower.value) : true;
  const requiresUserConfirmation =
    kind === 'continuity_state_vs_canon' && hard;

  return {
    winner: higher.layer,
    loser: lower.layer,
    kind,
    requiresUserConfirmation,
    winnerValue: higher.value,
  };
}

export interface ContinuityEventApplyInput {
  eventType: string;
  entityRefId?: string | number | null;
  payload: Record<string, unknown>;
  canonAliveState?: string | null;
  canonIdentityState?: string | null;
  canonKnowledgeBoundary?: string | null;
}

export interface ContinuityEventApplyResult {
  appliedFields: Record<string, unknown>;
  omittedHardFields: string[];
  omittedReason: string | null;
  requiresUserConfirmation: boolean;
}

/**
 * Apply a confirmed continuity event onto Canon without letting State
 * silently overwrite a hard Canon fact. Soft runtime fields may overlay.
 */
export function applyContinuityEventWithAuthority(
  input: ContinuityEventApplyInput,
): ContinuityEventApplyResult {
  const fields = extractContinuityFields(input.payload);
  const appliedFields: Record<string, unknown> = { ...fields };
  const omittedHardFields: string[] = [];

  const checks: Array<{ field: HardContinuityField; canon: string | null | undefined }> = [
    { field: 'aliveState', canon: input.canonAliveState },
    { field: 'identityState', canon: input.canonIdentityState },
    { field: 'knowledgeBoundary', canon: input.canonKnowledgeBoundary },
  ];

  for (const check of checks) {
    const incoming = appliedFields[check.field];
    if (incoming == null || incoming === '') continue;
    const resolution = resolveNarrativeFactConflict({
      field: check.field,
      left: { layer: 'canon', value: check.canon },
      right: { layer: 'structured_continuity_state', value: incoming },
    });
    if (resolution.requiresUserConfirmation) {
      delete appliedFields[check.field];
      omittedHardFields.push(check.field);
    }
  }

  return {
    appliedFields,
    omittedHardFields,
    omittedReason:
      omittedHardFields.length > 0
        ? `continuity_state_vs_canon:${omittedHardFields.join(',')}`
        : null,
    requiresUserConfirmation: omittedHardFields.length > 0,
  };
}

function classifyConflictKind(
  higher: MemoryAuthorityLayer,
  lower: MemoryAuthorityLayer,
): MemoryConflictKind {
  if (higher === 'canon' && lower === 'story_memory') {
    return 'story_memory_vs_canon';
  }
  if (higher === 'structured_continuity_state' && lower === 'story_memory') {
    return 'story_memory_vs_continuity_state';
  }
  if (higher === 'canon' && lower === 'structured_continuity_state') {
    return 'continuity_state_vs_canon';
  }
  if (higher === 'frozen_source_boundary') {
    return 'boundary_vs_lower';
  }
  return 'incomparable';
}

function extractContinuityFields(payload: Record<string, unknown>): Record<string, unknown> {
  const nested =
    payload.fields && typeof payload.fields === 'object' && !Array.isArray(payload.fields)
      ? (payload.fields as Record<string, unknown>)
      : {};
  const out: Record<string, unknown> = { ...nested };
  for (const key of [...HARD_CONTINUITY_FIELDS, ...SOFT_CONTINUITY_FIELDS]) {
    if (payload[key] != null && out[key] == null) {
      out[key] = payload[key];
    }
  }
  return out;
}

function normalizeFactValue(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim().toLowerCase();
  return text.length > 0 ? text : null;
}
