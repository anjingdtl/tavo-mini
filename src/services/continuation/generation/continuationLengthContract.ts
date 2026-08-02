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

export function countHanCharacters(text: string): number {
  return (
    text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? []
  ).length;
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
