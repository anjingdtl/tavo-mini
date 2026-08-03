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
  const toleranceHanCharacters = CONTINUATION_LENGTH_TOLERANCE_HAN;

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
