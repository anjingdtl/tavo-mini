/**
 * ONE Final Candidate Contract (Phase 2 §4).
 *
 * There is exactly ONE way to answer "what is the final body and its
 * requirement metadata" after the writing stages finish:
 *
 *   revision present  → Revision is Final Candidate
 *   revision absent   → Draft is Final Candidate
 *
 * This function is deliberately PURE and local: it never reads the live DB,
 * never consults the network, and never depends on a Proof artifact in the
 * compact (new-Standard) contract. Both `finalValidate` and `persist`, and
 * both durable adapters' final-body reads, derive from this single truth so
 * no second site re-builds a different priority chain (no dual truth).
 *
 * Legacy topology resume may ADD `proof` as the leading candidate source via
 * `mode: 'legacy'` — a compatibility mapping, never the compact contract.
 */
import type { SharedWritingStageName } from '../contracts/writingPolicy';
import type {
  SharedWritingArtifact,
  WritingStageArtifacts,
} from '../contracts/writingStage';

export type FinalCandidateMode = 'legacy' | 'compact';

export type FinalCandidateSourceStage = 'proof' | 'revision' | 'draft';

export interface FinalWritingCandidate {
  sourceStage: FinalCandidateSourceStage | null;
  body: string;
  structured?: Record<string, unknown>;
  appliedRequirementIds: string[];
  validNoOpRequirementIds?: string[];
  validNoOpReasons?: Record<string, string>;
}

/** Compact (new-Standard) candidate order: proof is NOT a candidate. */
const COMPACT_CANDIDATE_STAGES: readonly SharedWritingStageName[] = [
  'revision',
  'draft',
];

/** Legacy candidate order: proof may still carry the final body on resume. */
const LEGACY_CANDIDATE_STAGES: readonly SharedWritingStageName[] = [
  'proof',
  'revision',
  'draft',
];

/** A policy / runtime formal skip carries `{skipped:true}` provenance. */
function isFormalSkip(artifact: unknown): boolean {
  if (!artifact || typeof artifact !== 'object') return false;
  const structured = (artifact as Record<string, unknown>).structured;
  return (
    structured != null &&
    typeof structured === 'object' &&
    (structured as Record<string, unknown>).skipped === true
  );
}

function readBody(artifact: unknown): string {
  if (!artifact) return '';
  if (typeof artifact === 'string') return artifact.trim();
  const row = artifact as Record<string, unknown>;
  const body = row.body;
  if (typeof body === 'string') return body.trim();
  const content = row.content;
  if (typeof content === 'string') return content.trim();
  return '';
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => String(item || '').trim())
    .filter(Boolean);
}

function artifactOf(
  stage: SharedWritingStageName,
  artifact: unknown,
): SharedWritingArtifact {
  if (typeof artifact === 'string') return { stage, body: artifact };
  return (artifact as SharedWritingArtifact) || { stage, body: '' };
}

export function finalCandidateModeForPolicy(policy: {
  values?: Record<string, unknown>;
}): FinalCandidateMode {
  return (policy?.values as Record<string, unknown> | undefined)
    ?.pipelineTopologyVersion === 'compact_standard'
    ? 'compact'
    : 'legacy';
}

/**
 * Resolve the FINAL writing candidate from the completed stage artifacts.
 *
 * Rules:
 *  - A policy/formally skipped stage (`structured.skipped === true`) is not a
 *    candidate and is skipped over.
 *  - The first candidate stage with a real body wins and carries ALL of its
 *    requirement metadata (appliedRequirementIds / validNoOp*).
 *  - A present NON-skipped stage with an EMPTY body is fail-closed: it is a
 *    definitive empty candidate, never a silent fallback to an earlier stage
 *    that would fake success.
 */
export function resolveFinalWritingCandidate(
  artifacts: WritingStageArtifacts,
  options?: { mode?: FinalCandidateMode },
): FinalWritingCandidate {
  const stages =
    options?.mode === 'compact'
      ? COMPACT_CANDIDATE_STAGES
      : LEGACY_CANDIDATE_STAGES;
  for (const stage of stages) {
    const raw = artifacts[stage];
    if (raw == null) continue;
    if (isFormalSkip(raw)) continue;
    const artifact = artifactOf(stage, raw);
    const body = readBody(raw);
    const base = {
      sourceStage: stage as FinalCandidateSourceStage,
      body,
      ...(artifact.structured ? { structured: artifact.structured } : {}),
      appliedRequirementIds: asStringArray(artifact.appliedRequirementIds),
      ...(artifact.validNoOpRequirementIds
        ? { validNoOpRequirementIds: artifact.validNoOpRequirementIds }
        : {}),
      ...(artifact.validNoOpReasons
        ? { validNoOpReasons: artifact.validNoOpReasons }
        : {}),
    };
    if (body) return base;
    // Present, non-skip, but empty → definitive empty candidate (fail-closed).
    return base;
  }
  return { sourceStage: null, body: '', appliedRequirementIds: [] };
}