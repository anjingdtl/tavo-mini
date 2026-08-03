import { stripModelJson } from '../canon/canonJsonValidators';
import type { ContinuationCheckResult } from './types';
import {
  countHanCharacters,
  evaluateContinuationLength,
  isContinuationLengthIssueSubtype,
  resolveContinuationLengthContract,
} from './continuationLengthContract';

export interface RepairPatch {
  start: number;
  end: number;
  replacement: string;
}

export type RepairCandidateMode = 'standard' | 'additional';

export interface RepairPatchCoverage {
  coveredIssues: RepairCoverageIssue[];
  uncoveredIssues: RepairCoverageIssue[];
  chapterLengthIssues: RepairCoverageIssue[];
}

export type RepairCoverageIssue = Pick<
  ContinuationCheckResult,
  'id' | 'severity' | 'subtype' | 'generatedStart' | 'generatedEnd'
>;

function isSevere(issue: RepairCoverageIssue): boolean {
  return issue.severity === 'error' || issue.severity === 'blocking';
}

function isNaturalParagraphBoundary(
  original: string,
  position: number,
): boolean {
  if (position === 0 || position === original.length) return true;
  const before = original.slice(0, position);
  const after = original.slice(position);
  return /(?:\r?\n){2}$/.test(before) || /^(?:\r?\n){2}/.test(after);
}

/** Parse the model response once, without accepting full-text fallbacks. */
export function parseRepairPatches(raw: string): RepairPatch[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripModelJson(raw));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const values = (parsed as Record<string, unknown>).patches;
  if (!Array.isArray(values) || values.length === 0) return null;

  const patches: RepairPatch[] = [];
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const patch = value as Record<string, unknown>;
    if (
      typeof patch.start !== 'number' ||
      typeof patch.end !== 'number' ||
      !Number.isSafeInteger(patch.start) ||
      !Number.isSafeInteger(patch.end) ||
      typeof patch.replacement !== 'string' ||
      !patch.replacement.trim()
    ) {
      return null;
    }
    patches.push({
      start: patch.start,
      end: patch.end,
      replacement: patch.replacement,
    });
  }
  return patches;
}

/** Validate offsets, paragraph-boundary insertions, and patch ordering. */
export function validateRepairPatches(
  original: string,
  patches: RepairPatch[],
): boolean {
  if (!Array.isArray(patches) || patches.length === 0) return false;

  for (const patch of patches) {
    if (
      !patch ||
      typeof patch !== 'object' ||
      !Number.isSafeInteger(patch.start) ||
      !Number.isSafeInteger(patch.end) ||
      patch.start < 0 ||
      patch.end < patch.start ||
      patch.end > original.length ||
      typeof patch.replacement !== 'string' ||
      !patch.replacement.trim()
    ) {
      return false;
    }
    if (
      patch.start === patch.end &&
      !isNaturalParagraphBoundary(original, patch.start)
    ) {
      return false;
    }
  }

  const sorted = patches
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (current.start < previous.end || current.start === previous.start) {
      return false;
    }
  }
  return true;
}

/** Apply already parsed and validated patches to the complete original text. */
export function applyParsedRepairPatches(
  original: string,
  patches: RepairPatch[],
): string {
  return patches
    .slice()
    .sort((a, b) => b.start - a.start || b.end - a.end)
    .reduce(
      (content, patch) =>
        `${content.slice(0, patch.start)}${patch.replacement}${content.slice(
          patch.end,
        )}`,
      original,
    );
}

/**
 * Strict convenience wrapper for callers that still receive raw model JSON.
 * Parsing happens exactly once here; callers that need coverage should use the
 * split parse/validate/coverage/apply functions instead.
 */
export function applyRepairPatches(
  original: string,
  raw: string,
): string | null {
  const patches = parseRepairPatches(raw);
  if (!patches || !validateRepairPatches(original, patches)) return null;
  return applyParsedRepairPatches(original, patches);
}

function patchIntersectsIssue(
  patch: RepairPatch,
  issueStart: number,
  issueEnd: number,
): boolean {
  if (patch.start === patch.end) {
    // An insertion at the first character of a hit is still a targeted edit;
    // an insertion immediately after the half-open range is not.
    return patch.start >= issueStart && patch.start < issueEnd;
  }
  return patch.start < issueEnd && patch.end > issueStart;
}

/**
 * Determine which severe issues a legal patch actually addresses.
 *
 * Chapter-level length issues intentionally have no local coverage requirement:
 * the caller must close them only after local length re-check. Other issues
 * without a valid UTF-16 range are explicitly uncovered, including local
 * global rules and semantic Checker issues; a merely valid unrelated patch is
 * never enough to close them.
 */
export function validateRepairPatchCoverage(input: {
  patches: RepairPatch[];
  issues: RepairCoverageIssue[];
}): RepairPatchCoverage {
  const severeIssues = input.issues.filter(isSevere);
  const chapterLengthIssues = severeIssues.filter(issue =>
    isContinuationLengthIssueSubtype(issue.subtype),
  );
  const ordinaryIssues = severeIssues.filter(
    issue => !isContinuationLengthIssueSubtype(issue.subtype),
  );

  const coveredIssues = ordinaryIssues.filter(
    issue =>
      Number.isInteger(issue.generatedStart) &&
      Number.isInteger(issue.generatedEnd) &&
      (issue.generatedStart as number) >= 0 &&
      (issue.generatedEnd as number) > (issue.generatedStart as number) &&
      input.patches.some(patch =>
        patchIntersectsIssue(
          patch,
          issue.generatedStart as number,
          issue.generatedEnd as number,
        ),
      ),
  );
  const coveredIds = new Set(coveredIssues.map(issue => issue.id));
  const uncoveredIssues = ordinaryIssues.filter(
    issue => !coveredIds.has(issue.id),
  );

  return { coveredIssues, uncoveredIssues, chapterLengthIssues };
}

/**
 * Repair may improve an already-invalid Writer candidate without reaching the
 * target band in one call. It must never break a previously valid chapter,
 * catastrophically contract the text, or move materially farther from target.
 */
export function isRepairCandidateUsable(
  original: string,
  candidate: string,
  targetChapterChars: number,
  mode: RepairCandidateMode = 'standard',
): boolean {
  if (mode !== 'standard' && mode !== 'additional') return false;
  if (candidate === original) return false;

  const contract = resolveContinuationLengthContract(targetChapterChars);
  const originalHan = countHanCharacters(original);
  const candidateHan = countHanCharacters(candidate);
  if (originalHan === 0 || candidateHan === 0) return false;

  const originalLength = evaluateContinuationLength(original, contract);
  const candidateLength = evaluateContinuationLength(candidate, contract);
  const originalDistance = Math.abs(originalHan - contract.targetHanCharacters);
  const candidateDistance = Math.abs(
    candidateHan - contract.targetHanCharacters,
  );

  if (
    originalLength.status === 'within' &&
    candidateLength.status !== 'within'
  ) {
    return false;
  }

  if (
    originalLength.status !== 'within' &&
    candidateDistance >= originalDistance
  ) {
    // An invalid candidate must make strict progress so a Repair cannot
    // preserve or worsen the length failure. A valid standard candidate only
    // needs to remain in the legal band; the additional user Repair is stricter
    // below and must not move farther from the target.
    return false;
  }

  if (mode === 'additional' && candidateDistance > originalDistance) {
    return false;
  }

  const preservationRatio = originalLength.status === 'within' ? 0.8 : 0.65;
  if (candidateHan < Math.floor(originalHan * preservationRatio)) {
    return false;
  }

  const expansionCeiling = Math.max(
    contract.maxHanCharacters,
    Math.ceil(originalHan * 1.5),
  );
  return candidateHan <= expansionCeiling;
}
