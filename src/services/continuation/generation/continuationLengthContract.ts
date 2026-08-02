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
 * Count Han characters across the full Unicode Han range (Implementation plan
 * §6.1). Covers:
 *  - BMP CJK Unified Ideographs (U+4E00–U+9FFF)
 *  - CJK Extension A (U+3400–U+4DBF)
 *  - CJK Compatibility Ideographs (U+F900–U+FAFF)
 *  - CJK Extension B–F and Compatibility Supplement (U+20000–U+2FA1F, SMP)
 *  - IDEOGRAPHIC NUMBER ZERO 〇 (U+3007) — explicitly included per plan §6.1
 *
 * Implementation note: we iterate by code point (not UTF-16 code unit) so
 * supplementary-plane characters (astral Han) are counted once each. The older
 * BMP-only regex matched astral Han zero times and 〇 zero times. Do NOT confuse
 * this Unicode Han count with UTF-16 patch offsets, which are code-unit based.
 */
export function countHanCharacters(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; ) {
    const code = text.codePointAt(i) ?? 0;
    if (isHanCodePoint(code)) count += 1;
    // Advance by 2 code units when inside the supplementary plane, else 1.
    i += code > 0xffff ? 2 : 1;
  }
  return count;
}

function isHanCodePoint(code: number): boolean {
  // BMP CJK Unified Ideographs
  if (code >= 0x4e00 && code <= 0x9fff) return true;
  // CJK Extension A
  if (code >= 0x3400 && code <= 0x4dbf) return true;
  // CJK Compatibility Ideographs
  if (code >= 0xf900 && code <= 0xfaff) return true;
  // CJK Extension B–F (supplementary plane, U+20000–U+2FA1F covers Ext B/C/D/E/F
  // and the CJK Compatibility Ideographs Supplement).
  if (code >= 0x20000 && code <= 0x2fa1f) return true;
  // IDEOGRAPHIC NUMBER ZERO 〇
  if (code === 0x3007) return true;
  return false;
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
