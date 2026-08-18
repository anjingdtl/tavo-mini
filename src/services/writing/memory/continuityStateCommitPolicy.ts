/**
 * Conflict-only confirmation policy for Continuation Structured State.
 *
 * Normal State Extraction auto-commits. User confirmation is reserved for:
 *   - Canon conflict (hard fact)
 *   - Major state conflict
 *   - Unmergeable payload
 *   - Low confidence that actually affects later chapters
 *
 * This is not a second long-term memory system.
 */
import {
  applyContinuityEventWithAuthority,
  isHardContinuityField,
} from './memoryAuthority';
import type { ProposalType } from '../../continuation/generation/types';

export const CONTINUITY_AUTO_COMMIT_RULE_ID = 'one_memory.auto_commit_routine';
export const CONTINUITY_CANON_CONFLICT_RULE_ID = 'one_memory.canon_conflict';
export const CONTINUITY_MAJOR_CONFLICT_RULE_ID = 'one_memory.major_state_conflict';
export const CONTINUITY_UNMERGEABLE_RULE_ID = 'one_memory.unmergeable';
export const CONTINUITY_LOW_CONFIDENCE_RULE_ID =
  'one_memory.low_confidence_affects_later';

export const LOW_CONFIDENCE_THRESHOLD = 0.5;

const LATER_CHAPTER_TYPES = new Set<ProposalType>([
  'relationship_change',
  'plot_advance',
  'knowledge_change',
  'new_world_fact',
  'new_character',
  'new_location',
  'new_organization',
  'foreshadowing',
]);

export type ContinuityConfirmationReason =
  | 'canon_conflict'
  | 'major_state_conflict'
  | 'unmergeable'
  | 'low_confidence_affects_later';

export type ContinuityCommitAction = 'auto_commit' | 'require_user_confirmation';

export interface ContinuityCommitCanonFact {
  characterId?: number;
  name?: string;
  aliveState?: string | null;
  identityState?: string | null;
  knowledgeBoundary?: string | null;
}

export interface ContinuityCommitDecision {
  action: ContinuityCommitAction;
  reason: ContinuityConfirmationReason | null;
  policyRuleId: string;
}

export function classifyContinuityProposalCommit(input: {
  proposalType: ProposalType;
  subjectRefType?: string | null;
  subjectRefId?: string | null;
  payloadJson: string;
  canonFacts?: ContinuityCommitCanonFact[];
  siblingPending?: Array<{
    proposalType: ProposalType;
    subjectRefType?: string | null;
    subjectRefId?: string | null;
    payloadJson: string;
  }>;
}): ContinuityCommitDecision {
  const payload = parsePayload(input.payloadJson);

  if (payload.unmergeable === true || payload.mergeConflict === true) {
    return confirm('unmergeable', CONTINUITY_UNMERGEABLE_RULE_ID);
  }
  if (isConfirmationReason(payload.confirmationReason)) {
    return confirm(
      payload.confirmationReason,
      ruleIdForReason(payload.confirmationReason),
    );
  }
  if (payload.requiresUserConfirmation === true) {
    return confirm('unmergeable', CONTINUITY_UNMERGEABLE_RULE_ID);
  }
  if (payload.canonConflict === true || payload.conflictsWithCanon === true) {
    return confirm('canon_conflict', CONTINUITY_CANON_CONFLICT_RULE_ID);
  }
  if (payload.majorConflict === true) {
    return confirm('major_state_conflict', CONTINUITY_MAJOR_CONFLICT_RULE_ID);
  }

  if (hasCanonHardConflict(input, payload)) {
    return confirm('canon_conflict', CONTINUITY_CANON_CONFLICT_RULE_ID);
  }

  if (hasSiblingMajorConflict(input, payload)) {
    return confirm('major_state_conflict', CONTINUITY_MAJOR_CONFLICT_RULE_ID);
  }

  const confidence = readConfidence(payload);
  if (
    confidence != null &&
    confidence < LOW_CONFIDENCE_THRESHOLD &&
    affectsLaterChapters(input.proposalType, payload)
  ) {
    return confirm('low_confidence_affects_later', CONTINUITY_LOW_CONFIDENCE_RULE_ID);
  }

  return {
    action: 'auto_commit',
    reason: null,
    policyRuleId: CONTINUITY_AUTO_COMMIT_RULE_ID,
  };
}

function confirm(
  reason: ContinuityConfirmationReason,
  policyRuleId: string,
): ContinuityCommitDecision {
  return {
    action: 'require_user_confirmation',
    reason,
    policyRuleId,
  };
}

function ruleIdForReason(reason: ContinuityConfirmationReason): string {
  switch (reason) {
    case 'canon_conflict':
      return CONTINUITY_CANON_CONFLICT_RULE_ID;
    case 'major_state_conflict':
      return CONTINUITY_MAJOR_CONFLICT_RULE_ID;
    case 'unmergeable':
      return CONTINUITY_UNMERGEABLE_RULE_ID;
    case 'low_confidence_affects_later':
      return CONTINUITY_LOW_CONFIDENCE_RULE_ID;
  }
}

function isConfirmationReason(value: unknown): value is ContinuityConfirmationReason {
  return (
    value === 'canon_conflict' ||
    value === 'major_state_conflict' ||
    value === 'unmergeable' ||
    value === 'low_confidence_affects_later'
  );
}

function hasCanonHardConflict(
  input: {
    proposalType: ProposalType;
    subjectRefId?: string | null;
    canonFacts?: ContinuityCommitCanonFact[];
  },
  payload: Record<string, unknown>,
): boolean {
  const facts = input.canonFacts ?? [];
  if (facts.length === 0) return false;

  const subjectId =
    input.subjectRefId != null && input.subjectRefId !== ''
      ? Number(input.subjectRefId)
      : NaN;
  const matched = Number.isFinite(subjectId)
    ? facts.filter(fact => fact.characterId === subjectId)
    : facts;

  for (const fact of matched) {
    const applied = applyContinuityEventWithAuthority({
      eventType: input.proposalType,
      entityRefId: input.subjectRefId,
      payload,
      canonAliveState: fact.aliveState,
      canonIdentityState: fact.identityState,
      canonKnowledgeBoundary: fact.knowledgeBoundary,
    });
    if (applied.requiresUserConfirmation) return true;
  }
  return false;
}

function hasSiblingMajorConflict(
  input: {
    proposalType: ProposalType;
    subjectRefType?: string | null;
    subjectRefId?: string | null;
    siblingPending?: Array<{
      proposalType: ProposalType;
      subjectRefType?: string | null;
      subjectRefId?: string | null;
      payloadJson: string;
    }>;
  },
  payload: Record<string, unknown>,
): boolean {
  const siblings = input.siblingPending ?? [];
  if (siblings.length === 0) return false;
  const selfAlive = readAliveState(payload);
  if (selfAlive == null) return false;
  for (const sibling of siblings) {
    if (!sameSubject(input, sibling)) continue;
    const otherAlive = readAliveState(parsePayload(sibling.payloadJson));
    if (otherAlive != null && otherAlive !== selfAlive && otherAlive !== 'unknown') {
      return true;
    }
  }
  return false;
}

function affectsLaterChapters(
  proposalType: ProposalType,
  payload: Record<string, unknown>,
): boolean {
  if (LATER_CHAPTER_TYPES.has(proposalType)) return true;
  const fields = payload.fields;
  if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
    return Object.keys(fields).some(key => isHardContinuityField(key));
  }
  return Object.keys(payload).some(key => isHardContinuityField(key));
}

function readConfidence(payload: Record<string, unknown>): number | null {
  const raw = payload.confidence ?? payload.confidenceScore;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return raw;
}

function readAliveState(payload: Record<string, unknown>): string | null {
  const nested =
    payload.fields && typeof payload.fields === 'object' && !Array.isArray(payload.fields)
      ? (payload.fields as Record<string, unknown>).aliveState
      : undefined;
  const raw = payload.aliveState ?? nested;
  if (raw == null) return null;
  const text = String(raw).trim().toLowerCase();
  return text.length > 0 ? text : null;
}

function sameSubject(
  left: { subjectRefType?: string | null; subjectRefId?: string | null },
  right: { subjectRefType?: string | null; subjectRefId?: string | null },
): boolean {
  if (!left.subjectRefId || !right.subjectRefId) return false;
  return (
    String(left.subjectRefType ?? '') === String(right.subjectRefType ?? '') &&
    String(left.subjectRefId) === String(right.subjectRefId)
  );
}

function parsePayload(payloadJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(payloadJson);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}
