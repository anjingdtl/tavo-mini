/**
 * Phase IV-1: one explicit inventory for the gates that may affect the
 * writing path.  The inventory is intentionally data-first so a new gate
 * cannot quietly become a hard blocker without being classified and reviewed.
 */

export type Phase4GateDisposition =
  | 'hard_block'
  | 'advisory'
  | 'merge'
  | 'remove';

/** Frozen into new compact requests; historical legacy resumes do not opt in. */
export const PHASE4_GATE_POLICY_VERSION = 'phase4-gates-v1' as const;

export function isPhase4GatePolicy(
  values: Record<string, unknown> | null | undefined,
): boolean {
  return values?.phase4GatePolicyVersion === PHASE4_GATE_POLICY_VERSION;
}

export interface Phase4GateDefinition {
  id: string;
  name: string;
  stage: string;
  trigger: string;
  purpose: string;
  disposition: Phase4GateDisposition;
  blocks: boolean;
  failureConsequence: string;
  protectedObject: string;
  duplicate: boolean;
  needsLlm: boolean;
  needsJson: boolean;
  locallyNormalizable: boolean;
  worstCaseIfRemoved: string;
}

/**
 * Baseline inventory from the active compact path plus compatibility paths.
 * Eight rows are the actual safety/capability boundaries.  Quality protocol
 * shape, extra calls, and model-side bookkeeping are not allowed to join that
 * set by accident.
 */
export const PHASE4_GATE_INVENTORY: readonly Phase4GateDefinition[] = [
  {
    id: 'frozen_context_and_fingerprint',
    name: 'Frozen context / requirement binding',
    stage: 'all post-freeze stages',
    trigger: 'missing or drifting freeze / requirements fingerprint',
    purpose: 'Prevent a stage from reading a different request than the one frozen.',
    disposition: 'hard_block',
    blocks: true,
    failureConsequence: 'wrong request, stale evidence, or unsafe resume',
    protectedObject: 'frozen request and resume identity',
    duplicate: false,
    needsLlm: false,
    needsJson: false,
    locallyNormalizable: false,
    worstCaseIfRemoved: 'a resumed run could combine artifacts from different freezes',
  },
  {
    id: 'mandatory_truth',
    name: 'Chapter Truth projection integrity',
    stage: 'all post-freeze stages',
    trigger: 'truth projection fingerprint drift',
    purpose: 'Keep Mandatory Truth, Canon and continuity boundaries authoritative.',
    disposition: 'hard_block',
    blocks: true,
    failureConsequence: 'Canon or long-term story state can be polluted',
    protectedObject: 'Mandatory Truth / Canon / state boundary',
    duplicate: false,
    needsLlm: false,
    needsJson: false,
    locallyNormalizable: false,
    worstCaseIfRemoved: 'the model could write against live or mismatched facts',
  },
  {
    id: 'provider_capability_boundary',
    name: 'Provider hard capability boundary',
    stage: 'request boundary',
    trigger: 'mandatory context + minimum visible body + reasoning cannot fit',
    purpose: 'Do not send a mathematically impossible request.',
    disposition: 'hard_block',
    blocks: true,
    failureConsequence: 'provider rejects or truncates an impossible request',
    protectedObject: 'provider/context safety',
    duplicate: false,
    needsLlm: false,
    needsJson: false,
    locallyNormalizable: true,
    worstCaseIfRemoved: 'avoidable provider rejection or repeated truncation',
  },
  {
    id: 'truncated_output',
    name: 'finishReason=length',
    stage: 'writer / persistence boundary',
    trigger: 'provider reports a length-truncated response',
    purpose: 'Never persist incomplete prose as a final result.',
    disposition: 'hard_block',
    blocks: true,
    failureConsequence: 'truncated正文落库',
    protectedObject: 'final body integrity',
    duplicate: false,
    needsLlm: false,
    needsJson: false,
    locallyNormalizable: false,
    worstCaseIfRemoved: 'users receive incomplete chapters',
  },
  {
    id: 'outcome_unknown',
    name: 'Unknown provider outcome',
    stage: 'receipt / retry boundary',
    trigger: 'request may have executed but outcome is not known',
    purpose: 'Preserve accounting truth and prohibit automatic duplicate retry.',
    disposition: 'hard_block',
    blocks: true,
    failureConsequence: 'double charge or duplicate content request',
    protectedObject: 'paid-call accounting and idempotency',
    duplicate: false,
    needsLlm: false,
    needsJson: false,
    locallyNormalizable: false,
    worstCaseIfRemoved: 'a timeout could be resent and charged twice',
  },
  {
    id: 'final_body_integrity',
    name: 'Final body non-empty / complete',
    stage: 'Persistence Boundary',
    trigger: 'candidate is empty or final body is absent',
    purpose: 'Persist only a real final candidate.',
    disposition: 'hard_block',
    blocks: true,
    failureConsequence: 'empty or missing chapter replaces user content',
    protectedObject: 'chapter body',
    duplicate: false,
    needsLlm: false,
    needsJson: false,
    locallyNormalizable: false,
    worstCaseIfRemoved: 'an empty artifact could be marked complete',
  },
  {
    id: 'persistence_transaction',
    name: 'Durable transaction / checkpoint',
    stage: 'Persistence Boundary',
    trigger: 'DB transaction, checkpoint or durable write fails',
    purpose: 'Keep run state and chapter state recoverable and consistent.',
    disposition: 'hard_block',
    blocks: true,
    failureConsequence: 'partial adoption or a permanently running task',
    protectedObject: 'database integrity and Resume',
    duplicate: false,
    needsLlm: false,
    needsJson: false,
    locallyNormalizable: false,
    worstCaseIfRemoved: 'state and body can diverge after a crash',
  },
  {
    id: 'canon_state_safety',
    name: 'Canon / state mutation safety',
    stage: 'Final Validate / Persist',
    trigger: 'invalid proposal, drift, or unsafe state mutation',
    purpose: 'Decouple optional state sidecars from safe prose adoption.',
    disposition: 'hard_block',
    blocks: true,
    failureConsequence: 'long-term memory or Canon pollution',
    protectedObject: 'Canon and Story Memory',
    duplicate: false,
    needsLlm: false,
    needsJson: false,
    locallyNormalizable: true,
    worstCaseIfRemoved: 'a malformed state update could be committed with prose',
  },
  {
    id: 'quality_report_shape',
    name: 'QA / review report shape',
    stage: 'QA',
    trigger: 'missing optional report fields or non-critical finding detail',
    purpose: 'Make quality advice usable without turning it into a body gate.',
    disposition: 'advisory',
    blocks: false,
    failureConsequence: 'less precise review telemetry',
    protectedObject: 'quality diagnostics',
    duplicate: false,
    needsLlm: true,
    needsJson: true,
    locallyNormalizable: true,
    worstCaseIfRemoved: 'a malformed QA response may lose a recommendation',
  },
  {
    id: 'noncritical_finding',
    name: 'Style / repetition / length finding',
    stage: 'QA / Revision decision',
    trigger: 'non-safety quality concern',
    purpose: 'Keep a usable正文 when the issue is not a safety boundary.',
    disposition: 'advisory',
    blocks: false,
    failureConsequence: 'quality issue remains for user or next pass',
    protectedObject: 'quality signal only',
    duplicate: false,
    needsLlm: true,
    needsJson: false,
    locallyNormalizable: true,
    worstCaseIfRemoved: 'a minor quality issue may not be surfaced',
  },
  {
    id: 'state_sidecar_shape',
    name: 'Optional state sidecar shape',
    stage: 'Revision / Persist',
    trigger: 'optional state sidecar is malformed but prose is complete',
    purpose: 'Drop unsafe optional metadata while retaining complete prose.',
    disposition: 'advisory',
    blocks: false,
    failureConsequence: 'state update is omitted from this run',
    protectedObject: 'optional state metadata',
    duplicate: false,
    needsLlm: false,
    needsJson: true,
    locallyNormalizable: true,
    worstCaseIfRemoved: 'a valid prose result may lose a state hint',
  },
  {
    id: 'final_candidate_and_persistence',
    name: 'Final Candidate + Persistence Boundary',
    stage: 'Final Validate / Persist',
    trigger: 'multiple sites rebuild candidate or safety decision',
    purpose: 'Use one local candidate and one final safety decision.',
    disposition: 'merge',
    blocks: false,
    failureConsequence: 'different callers can disagree about the final body',
    protectedObject: 'candidate authority',
    duplicate: true,
    needsLlm: false,
    needsJson: false,
    locallyNormalizable: true,
    worstCaseIfRemoved: 'dual-truth regression in finalization',
  },
  {
    id: 'review_audit_factcheck',
    name: 'Review + Audit + FactCheck',
    stage: 'QA',
    trigger: 'three overlapping report stages in the active compact path',
    purpose: 'Collapse quality inspection to one compact QA stage.',
    disposition: 'merge',
    blocks: false,
    failureConsequence: 'quality coverage becomes narrower if requirements are lost',
    protectedObject: 'one QA semantic pass',
    duplicate: true,
    needsLlm: true,
    needsJson: true,
    locallyNormalizable: false,
    worstCaseIfRemoved: 'a required Canon check could disappear',
  },
  {
    id: 'local_hash_fingerprint_diff',
    name: 'Hash / fingerprint / diff / changeset',
    stage: 'Revision / Persist',
    trigger: 'model is asked to emit deterministic bookkeeping',
    purpose: 'Move deterministic calculations to the client.',
    disposition: 'merge',
    blocks: false,
    failureConsequence: 'more protocol tokens and mismatch risk',
    protectedObject: 'local deterministic metadata',
    duplicate: true,
    needsLlm: false,
    needsJson: false,
    locallyNormalizable: true,
    worstCaseIfRemoved: 'bookkeeping must be regenerated locally',
  },
  {
    id: 'governor_current_request',
    name: 'Governor current-request veto',
    stage: 'request boundary',
    trigger: 'learned recommendation is below demand floor',
    purpose: 'Historical limiter that should have been next-request feedback only.',
    disposition: 'remove',
    blocks: false,
    failureConsequence: 'valid request is needlessly rejected',
    protectedObject: 'none; tuning belongs in the side channel',
    duplicate: true,
    needsLlm: false,
    needsJson: false,
    locallyNormalizable: true,
    worstCaseIfRemoved: 'hard capability boundary still protects impossible requests',
  },
  {
    id: 'formatter_rescue_call',
    name: 'Formatter rescue LLM call',
    stage: 'writer recovery',
    trigger: 'primary response has no adopted content',
    purpose: 'Old rescue path for malformed/empty model output.',
    disposition: 'remove',
    blocks: false,
    failureConsequence: 'a malformed response remains advisory/failed locally',
    protectedObject: 'no additional paid call',
    duplicate: true,
    needsLlm: true,
    needsJson: true,
    locallyNormalizable: true,
    worstCaseIfRemoved: 'some malformed responses need an explicit user retry',
  },
  {
    id: 'model_side_fingerprint',
    name: 'Model-emitted hash / fingerprint',
    stage: 'Revision contract',
    trigger: 'model emits data derivable from final body',
    purpose: 'Prevent deterministic bookkeeping from expanding the contract.',
    disposition: 'remove',
    blocks: false,
    failureConsequence: 'none when calculated locally',
    protectedObject: 'local final-body identity',
    duplicate: true,
    needsLlm: false,
    needsJson: true,
    locallyNormalizable: true,
    worstCaseIfRemoved: 'local code must calculate the value',
  },
  {
    id: 'duplicate_quality_diagnostics',
    name: 'Duplicated quality diagnostics',
    stage: 'QA / Revision / Proof',
    trigger: 'same finding is copied into multiple envelopes',
    purpose: 'Keep one bounded findings representation.',
    disposition: 'remove',
    blocks: false,
    failureConsequence: 'telemetry loses a redundant copy',
    protectedObject: 'protocol size and prompt budget',
    duplicate: true,
    needsLlm: false,
    needsJson: false,
    locallyNormalizable: true,
    worstCaseIfRemoved: 'diagnostics are kept in Receipt only',
  },
] as const;

export function classifyPhase4Gate(
  gateId: string,
): Phase4GateDisposition {
  return (
    PHASE4_GATE_INVENTORY.find(gate => gate.id === gateId)?.disposition ||
    'advisory'
  );
}

export function isPhase4HardGate(gateId: string): boolean {
  return classifyPhase4Gate(gateId) === 'hard_block';
}

export function countPhase4Gates(
  inventory: readonly Phase4GateDefinition[] = PHASE4_GATE_INVENTORY,
): Record<'total' | 'hardBlock' | 'advisory' | 'merge' | 'remove', number> {
  return inventory.reduce(
    (counts, gate) => {
      counts.total += 1;
      if (gate.disposition === 'hard_block') counts.hardBlock += 1;
      if (gate.disposition === 'advisory') counts.advisory += 1;
      if (gate.disposition === 'merge') counts.merge += 1;
      if (gate.disposition === 'remove') counts.remove += 1;
      return counts;
    },
    { total: 0, hardBlock: 0, advisory: 0, merge: 0, remove: 0 },
  );
}
