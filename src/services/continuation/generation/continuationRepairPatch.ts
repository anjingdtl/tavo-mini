import { stripModelJson } from '../canon/canonJsonValidators';
import {
  countHanCharacters,
  evaluateContinuationLength,
  resolveContinuationLengthContract,
} from './continuationLengthContract';

interface RepairPatch {
  start: number;
  end: number;
  replacement: string;
}

/**
 * Apply UTF-16 half-open repair patches to a complete chapter. `start === end`
 * is a pure insertion, used when a length-under-target issue needs new prose.
 */
export function applyRepairPatches(
  original: string,
  raw: string,
): string | null {
  let parsed: { patches?: unknown };
  try {
    parsed = JSON.parse(stripModelJson(raw));
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.patches) || !parsed.patches.length) {
    return null;
  }

  const patches: RepairPatch[] = [];
  for (const value of parsed.patches) {
    if (!value || typeof value !== 'object') return null;
    const patch = value as Record<string, unknown>;
    const start = Number(patch.start);
    const end = Number(patch.end);
    const replacement = patch.replacement;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end < start ||
      end > original.length ||
      typeof replacement !== 'string' ||
      !replacement.trim()
    ) {
      return null;
    }
    if (
      start === end &&
      start > 0 &&
      start < original.length &&
      original[start - 1] !== '\n' &&
      original[start] !== '\n'
    ) {
      return null;
    }
    patches.push({ start, end, replacement });
  }

  patches.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let index = 1; index < patches.length; index += 1) {
    const previous = patches[index - 1];
    const current = patches[index];
    if (current.start < previous.end) return null;
    if (current.start === previous.start) return null;
  }

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
 * Repair may improve an already-invalid Writer candidate without reaching the
 * target band in one call. It must never break a previously valid chapter,
 * catastrophically contract the text, or move materially farther from target.
 */
export function isRepairCandidateUsable(
  original: string,
  candidate: string,
  targetChapterChars: number,
): boolean {
  const contract = resolveContinuationLengthContract(targetChapterChars);
  const originalHan = countHanCharacters(original);
  const candidateHan = countHanCharacters(candidate);
  if (originalHan === 0 || candidateHan === 0) return false;

  const originalLength = evaluateContinuationLength(original, contract);
  const candidateLength = evaluateContinuationLength(candidate, contract);

  if (
    originalLength.status === 'within' &&
    candidateLength.status !== 'within'
  ) {
    return false;
  }

  const preservationRatio = originalLength.status === 'within' ? 0.8 : 0.65;
  if (candidateHan < Math.floor(originalHan * preservationRatio)) {
    return false;
  }

  if (originalLength.status !== 'within') {
    const originalDistance = Math.abs(
      originalHan - contract.targetHanCharacters,
    );
    const candidateDistance = Math.abs(
      candidateHan - contract.targetHanCharacters,
    );
    const allowedRegression = Math.min(
      100,
      Math.floor(contract.toleranceHanCharacters * 0.2),
    );
    if (candidateDistance > originalDistance + allowedRegression) {
      return false;
    }
  }

  const expansionCeiling = Math.max(
    contract.maxHanCharacters,
    Math.ceil(originalHan * 1.5),
  );
  return candidateHan <= expansionCeiling;
}
