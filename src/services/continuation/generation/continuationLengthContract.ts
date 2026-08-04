/**
 * Shared Han-length contract for continuation Writer / Checker / Repair.
 *
 * Tolerance is proportional (±30% of target), not a fixed ±500:
 *   1000 → 700–1300；3000 → 2100–3900；8000 → 5600–10400。
 *
 * Decision (V4 length-repair reform, 2026-08): both V4 and the legacy standard
 * path (`continuationPromptCompiler` / `continuationGenerationRunner`) share
 * this proportional contract. Fixed ±500 was too tight on large targets and
 * too loose on small ones; a single ratio keeps UX consistent across pipelines.
 * Do not reintroduce a separate fixed-tolerance branch without an explicit
 * product decision.
 */

/** Soft band around the user target Han count (inclusive min/max). */
export const CONTINUATION_LENGTH_TOLERANCE_RATIO = 0.3;

/**
 * @deprecated Fixed Han tolerance. Runtime uses CONTINUATION_LENGTH_TOLERANCE_RATIO.
 * Kept so older imports/docs still resolve; do not use for new contract math.
 */
export const CONTINUATION_LENGTH_TOLERANCE_HAN = 500;

export interface ContinuationLengthContract {
  targetHanCharacters: number;
  minHanCharacters: number;
  maxHanCharacters: number;
  toleranceHanCharacters: number;
}

export type ContinuationLengthEvaluation =
  | {
      status: 'within';
      actualHanCharacters: number;
      targetDelta: number;
      contract: ContinuationLengthContract;
    }
  | {
      status: 'under';
      actualHanCharacters: number;
      targetDelta: number;
      missingToMinimum: number;
      contract: ContinuationLengthContract;
    }
  | {
      status: 'over';
      actualHanCharacters: number;
      targetDelta: number;
      excessOverMaximum: number;
      contract: ContinuationLengthContract;
    };

const LENGTH_ISSUE_SUBTYPES = new Set([
  'chapter_length_under_target',
  'chapter_length_over_target',
]);

/**
 * Count Han characters in the implementation's supported ranges: BMP Unified
 * Ideographs, Extension A, Compatibility Ideographs, U+20000–U+2FA1F, and 〇.
 * This intentionally does not claim complete Unicode Han coverage. Iterate by
 * code point so supplementary-plane Han characters count once, while Repair
 * offsets remain UTF-16 code-unit offsets elsewhere in the workflow.
 */
export function countHanCharacters(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; ) {
    const code = text.codePointAt(i) ?? 0;
    if (isHanCodePoint(code)) count += 1;
    i += code > 0xffff ? 2 : 1;
  }
  return count;
}

function isHanCodePoint(code: number): boolean {
  if (code >= 0x4e00 && code <= 0x9fff) return true;
  if (code >= 0x3400 && code <= 0x4dbf) return true;
  if (code >= 0xf900 && code <= 0xfaff) return true;
  if (code >= 0x20000 && code <= 0x2fa1f) return true;
  return code === 0x3007;
}

export function resolveContinuationLengthContract(
  targetChapterChars: number,
): ContinuationLengthContract {
  const parsed = Number(targetChapterChars);
  const targetHanCharacters = Math.max(
    1,
    Math.floor(Number.isFinite(parsed) ? parsed : 1),
  );
  // Proportional ±30% (rounded). Same contract for V4 and legacy standard path.
  const toleranceHanCharacters = Math.max(
    1,
    Math.round(targetHanCharacters * CONTINUATION_LENGTH_TOLERANCE_RATIO),
  );

  return {
    targetHanCharacters,
    minHanCharacters: Math.max(
      1,
      targetHanCharacters - toleranceHanCharacters,
    ),
    maxHanCharacters: targetHanCharacters + toleranceHanCharacters,
    toleranceHanCharacters,
  };
}

export function evaluateContinuationLength(
  content: string,
  targetOrContract: number | ContinuationLengthContract,
): ContinuationLengthEvaluation {
  const contract =
    typeof targetOrContract === 'number'
      ? resolveContinuationLengthContract(targetOrContract)
      : targetOrContract;
  const actualHanCharacters = countHanCharacters(content);
  const targetDelta = actualHanCharacters - contract.targetHanCharacters;

  if (actualHanCharacters < contract.minHanCharacters) {
    return {
      status: 'under',
      actualHanCharacters,
      targetDelta,
      missingToMinimum: contract.minHanCharacters - actualHanCharacters,
      contract,
    };
  }

  if (actualHanCharacters > contract.maxHanCharacters) {
    return {
      status: 'over',
      actualHanCharacters,
      targetDelta,
      excessOverMaximum: actualHanCharacters - contract.maxHanCharacters,
      contract,
    };
  }

  return {
    status: 'within',
    actualHanCharacters,
    targetDelta,
    contract,
  };
}

export function isContinuationLengthIssueSubtype(subtype: string): boolean {
  return LENGTH_ISSUE_SUBTYPES.has(subtype);
}

/**
 * True when local length check should drive a single V4 Repair expansion pass.
 * Only severe shortfall (under the ±30% floor, i.e. &lt; target×0.7) qualifies.
 * Over-target never forces compress — that remains advisory only.
 */
export function isLengthExpansionIssue(
  issue: Pick<{ subtype: string; severity: string }, 'subtype' | 'severity'>,
): boolean {
  if (issue.severity !== 'error' && issue.severity !== 'blocking') return false;
  return issue.subtype === 'chapter_length_under_target';
}
