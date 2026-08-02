/**
 * V3 local quality gate aggregator (Implementation plan §6.3).
 *
 * Combines the three local hard gates — length contract, self-duplication, and
 * the existing deterministic checker (seam/Canon/future-leakage) — into a single
 * pass/fail result. V3 never decides a final artifact on `isRepairCandidateUsable()`
 * alone; it always runs through this gate.
 *
 * Pure function. No LLM, no DB. The Runner supplies the snapshot and the already
 * bound/filtered deterministic issues; this module only aggregates.
 */
import type { ContinuationContextSnapshot } from './types';
import type { RawCheckIssue } from './continuationChecker';
import {
  evaluateContinuationLength,
  resolveContinuationLengthContract,
  isContinuationLengthIssueSubtype,
} from './continuationLengthContract';
import {
  evaluateContinuationDuplicate,
  type ContinuationDuplicateEvaluation,
} from './continuationDuplicateDetector';
import type { ContinuationLengthEvaluation } from './continuationLengthContract';

export interface ContinuationQualityGateResult {
  /** True only when length, duplicate AND all severe local issues pass. */
  pass: boolean;
  length: ContinuationLengthEvaluation;
  duplicate: ContinuationDuplicateEvaluation;
  /** Already-bound/filtered deterministic issues for this artifact. */
  localIssues: RawCheckIssue[];
  /**
   * Subtypes that contributed to a hard block (length status, duplicate status,
   * or severe deterministic subtype). Useful for telemetry and UI without
   * re-deriving the decision.
   */
  hardBlockingSubtypes: string[];
  /** Human-readable summary reasons (Chinese). */
  reasons: string[];
}

function isSevere(issue: RawCheckIssue): boolean {
  return issue.severity === 'error' || issue.severity === 'blocking';
}

/**
 * Run the three local hard gates against a candidate artifact.
 *
 * `parent` is the Writer artifact content when evaluating a repair candidate,
 * and omitted when evaluating the Writer artifact itself. Passing it enables the
 * abnormal-parent-overlap check (plan §6.2 item 4).
 */
export function evaluateContinuationQualityGate(input: {
  candidate: string;
  snapshot: ContinuationContextSnapshot;
  /** Deterministic issues already bound to the candidate + filtered by settings. */
  localIssues: RawCheckIssue[];
  parent?: string;
}): ContinuationQualityGateResult {
  const targetChapterChars =
    input.snapshot.settingsSnapshot.values.targetChapterChars;
  const contract = resolveContinuationLengthContract(targetChapterChars);

  const length = evaluateContinuationLength(input.candidate, contract);
  const duplicate = evaluateContinuationDuplicate({
    candidate: input.candidate,
    parent: input.parent,
  });

  const hardBlockingSubtypes: string[] = [];
  const reasons: string[] = [];

  if (length.status !== 'within') {
    hardBlockingSubtypes.push(
      length.status === 'under'
        ? 'chapter_length_under_target'
        : 'chapter_length_over_target',
    );
    reasons.push(
      length.status === 'under'
        ? `章节长度不足：${length.actualHanCharacters} 汉字，下限 ${contract.minHanCharacters}`
        : `章节长度超限：${length.actualHanCharacters} 汉字，上限 ${contract.maxHanCharacters}`,
    );
  }

  if (duplicate.status === 'blocking') {
    hardBlockingSubtypes.push('chapter_self_duplication');
    reasons.push(...duplicate.reasons);
  }

  const severeLocal = input.localIssues.filter(isSevere);
  for (const issue of severeLocal) {
    // Length issues are already represented above; skip duplicating them.
    if (isContinuationLengthIssueSubtype(issue.subtype)) continue;
    hardBlockingSubtypes.push(issue.subtype);
    reasons.push(`[${issue.severity}/${issue.subtype}] ${issue.description}`);
  }

  const pass = hardBlockingSubtypes.length === 0;

  return {
    pass,
    length,
    duplicate,
    localIssues: input.localIssues,
    hardBlockingSubtypes,
    reasons,
  };
}
