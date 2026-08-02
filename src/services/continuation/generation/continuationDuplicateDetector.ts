/**
 * V3 self-duplication detector (Implementation plan §6.2).
 *
 * Pure functions only. No LLM, no DB, no side effects. The Runner/quality gate
 * calls `evaluateContinuationDuplicate()` and treats `status === 'blocking'` as
 * an unoverridable hard gate (plan §6.2: "整章重复、连续大段重复必须是不可
 * 覆盖的 blocking").
 *
 * The detector is intentionally conservative on false positives: a single long
 * repeated paragraph or whole-artifact duplication is blocking, while normal
 * rhetorical repetition (短句复沓) must not trigger a block.
 */
import { countHanCharacters } from './continuationLengthContract';

export type ContinuationDuplicateStatus = 'within' | 'suspicious' | 'blocking';

export interface ContinuationDuplicateEvaluation {
  status: ContinuationDuplicateStatus;
  /** 0–1 share of normalized paragraph hashes that recur. */
  repeatedParagraphRatio: number;
  /** 0–1 share of 8–12 char Han n-grams that recur. */
  repeatedNgramRatio: number;
  /** Longest run of consecutive Han characters that appears ≥2 times. */
  longestRepeatedHanSpan: number;
  /** True when the candidate equals original+original (± trivial glue). */
  wholeArtifactDuplication: boolean;
  /** True when the candidate's novel portion is an abnormal copy of `parent`. */
  highOverlapWithParent: boolean;
  reasons: string[];
}

const STATUS_BLOCKING_NGRAM_RATIO = 0.6;
const STATUS_BLOCKING_PARAGRAPH_RATIO = 0.5;
const STATUS_BLOCKING_LONGEST_HAN_SPAN = 80;
const STATUS_SUSPICIOUS_NGRAM_RATIO = 0.35;
const STATUS_SUSPICIOUS_PARAGRAPH_RATIO = 0.3;
const STATUS_SUSPICIOUS_LONGEST_HAN_SPAN = 40;

/** Normalize a paragraph for hash comparison: strip whitespace & punctuation. */
function normalizeParagraph(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]/gu, '');
}

/** Split content into non-empty paragraphs (blank-line separated). */
function splitParagraphs(text: string): string[] {
  return text
    .split(/(?:\r?\n){1,}/)
    .map(line => line.trim())
    .filter(line => line.length > 0);
}

/**
 * Extract all Han-character n-grams of length n from `hanText` (a string that
 * has already been reduced to Han characters only).
 */
function extractHanNgrams(hanText: string, n: number): string[] {
  if (hanText.length < n) return [];
  const out: string[] = [];
  for (let i = 0; i + n <= hanText.length; i += 1) {
    out.push(hanText.slice(i, i + n));
  }
  return out;
}

/**
 * Keep only Han characters (using the same code-point ranges as the length
 * contract counter) so n-gram analysis reflects prose, not punctuation.
 */
function hanOnly(text: string): string {
  const chars: string[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (isHanCodePoint(code)) chars.push(ch);
  }
  return chars.join('');
}

function isHanCodePoint(code: number): boolean {
  // BMP CJK Unified Ideographs
  if (code >= 0x4e00 && code <= 0x9fff) return true;
  // CJK Extension A
  if (code >= 0x3400 && code <= 0x4dbf) return true;
  // CJK Extension B–F (supplementary plane)
  if (code >= 0x20000 && code <= 0x2fa1f) return true;
  // CJK Compatibility Ideographs
  if (code >= 0xf900 && code <= 0xfaff) return true;
  // CJK Compatibility ideographs supplement
  if (code >= 0x2f800 && code <= 0x2fa1f) return true;
  // IDEOGRAPHIC NUMBER ZERO 〇 (explicitly included per plan §6.1)
  if (code === 0x3007) return true;
  return false;
}

/**
 * Find the longest substring (by Han-character count) that appears ≥2 times in
 * `hanText`. Uses a binary-search + rolling-hash approach to stay efficient on
 * long chapters (up to 30,000 target Han characters per plan §2.3).
 */
function longestDuplicatedHanSpan(hanText: string): number {
  if (hanText.length < 2) return 0;
  let lo = 4;
  let hi = Math.floor(hanText.length / 2);
  let best = 0;
  // Binary search on span length. For each candidate length L, check whether any
  // length-L window appears more than once via a Set of string slices. String
  // slicing is O(L), giving O(N·L) per probe; with binary search the total is
  // O(N·L·log N). For N≤30k this stays well under a second in JS.
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (hasDuplicatedWindow(hanText, mid)) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function hasDuplicatedWindow(hanText: string, length: number): boolean {
  if (length <= 0 || length > hanText.length / 2) return false;
  const seen = new Set<string>();
  for (let i = 0; i + length <= hanText.length; i += 1) {
    const window = hanText.slice(i, i + length);
    if (seen.has(window)) return true;
    seen.add(window);
  }
  return false;
}

/**
 * Detect whole-artifact duplication: `candidate === original + original` and its
 * near variants where a few whitespace / punctuation / connector characters sit
 * between the two halves.
 *
 * The real-world failure this catches (plan §1.3, emulator report §3): the
 * standard Repair returned a candidate whose content was the Writer body
 * repeated twice in a row. The offset-based patch coverage check missed it
 * because the second copy still intersected the length issue's range.
 */
export function detectWholeArtifactDuplication(
  original: string,
  candidate: string,
): boolean {
  if (candidate.length < 4) return false;
  // Case 1: exact doubled candidate (candidate === X + X). This is the most
  // common model failure where the repair returned writer+writer.
  const halfFloor = Math.floor(candidate.length / 2);
  for (const mid of [halfFloor, Math.ceil(candidate.length / 2)]) {
    if (mid < 2 || mid > candidate.length - 2) continue;
    const left = candidate.slice(0, mid);
    const right = candidate.slice(mid);
    if (left === right && left.trim().length > 0) return true;
  }
  // Case 2: candidate is two copies of a Han-only core, possibly separated by
  // whitespace/punctuation glue. Reduce both halves to Han-only and compare.
  const trimmed = candidate.trim();
  if (trimmed.length >= 8) {
    for (const mid of [Math.floor(trimmed.length / 2), Math.ceil(trimmed.length / 2)]) {
      if (mid < 4 || mid > trimmed.length - 4) continue;
      const left = hanOnly(trimmed.slice(0, mid));
      const right = hanOnly(trimmed.slice(mid));
      if (left.length >= 4 && left === right) return true;
    }
  }
  // Case 3: candidate literally equals original repeated. This matters when the
  // parent (Writer) text is supplied and the repair returned writer + writer.
  if (original.length >= 4) {
    const doubled = original + original;
    if (candidate === doubled) return true;
    if (hanOnly(candidate) === hanOnly(doubled) && hanOnly(candidate).length >= 8) {
      return true;
    }
  }
  return false;
}

/**
 * Share (0–1) of Han n-grams (averaged over n=8,9,10,11) that appear more than
 * once inside `text`. High values indicate the candidate reuses the same
 * phrases many times instead of advancing the narrative.
 */
function repeatedNgramShare(text: string): number {
  const han = hanOnly(text);
  if (han.length < 12) return 0;
  let sum = 0;
  let count = 0;
  for (const n of [8, 9, 10, 11]) {
    const grams = extractHanNgrams(han, n);
    if (grams.length === 0) continue;
    const freq = new Map<string, number>();
    for (const g of grams) freq.set(g, (freq.get(g) ?? 0) + 1);
    let repeated = 0;
    for (const v of freq.values()) if (v > 1) repeated += v - 1;
    sum += repeated / grams.length;
    count += 1;
  }
  return count > 0 ? sum / count : 0;
}

/**
 * Share (0–1) of normalized paragraph hashes that occur more than once. Whole
 * repeated paragraphs are a stronger signal than n-grams for cut-paste failures.
 */
function repeatedParagraphShare(text: string): number {
  const paragraphs = splitParagraphs(text);
  if (paragraphs.length < 2) return 0;
  const freq = new Map<string, number>();
  for (const p of paragraphs) {
    const norm = normalizeParagraph(p);
    if (norm.length === 0) continue;
    freq.set(norm, (freq.get(norm) ?? 0) + 1);
  }
  let total = 0;
  let repeated = 0;
  for (const v of freq.values()) {
    total += v;
    if (v > 1) repeated += v;
  }
  return total > 0 ? repeated / total : 0;
}

/**
 * Detect abnormal overlap between a revision candidate and its parent (Writer)
 * text. This catches the case where the "revision" merely copies the original
 * prose with trivial edits while claiming to have fixed the issues.
 *
 * Returns true when the candidate shares an unusually high fraction of its
 * Han n-grams with the parent — i.e. the revision did not substantively
 * rewrite the problematic passages.
 */
function abnormalParentOverlap(parent: string, candidate: string): boolean {
  const parentHan = hanOnly(parent);
  const candidateHan = hanOnly(candidate);
  if (parentHan.length < 40 || candidateHan.length < 40) return false;
  const parentSet = new Set(extractHanNgrams(parentHan, 12));
  if (parentSet.size === 0) return false;
  const candidateGrams = extractHanNgrams(candidateHan, 12);
  if (candidateGrams.length === 0) return false;
  let shared = 0;
  for (const g of candidateGrams) {
    if (parentSet.has(g)) shared += 1;
  }
  const overlap = shared / candidateGrams.length;
  // A revision that legitimately rewrites keeps ≤55% 12-grams in common with
  // the parent; ≥80% means the "revision" is essentially a copy. We block at
  // the higher bar to avoid false positives on chapters that were already good
  // and only needed a small fix.
  return overlap >= 0.8;
}

/**
 * Core V3 entry point. `parent` is optional (Writer artifact when evaluating a
 * revision candidate; omit for the Writer artifact itself).
 */
export function evaluateContinuationDuplicate(input: {
  candidate: string;
  parent?: string;
}): ContinuationDuplicateEvaluation {
  const candidate = input.candidate ?? '';
  const parent = input.parent;
  const reasons: string[] = [];

  const wholeArtifactDuplication = detectWholeArtifactDuplication(
    parent ?? '',
    candidate,
  );
  if (wholeArtifactDuplication) {
    reasons.push('整章正文自重复（candidate ≈ 原文 + 原文）');
  }

  const repeatedNgramRatio = repeatedNgramShare(candidate);
  const repeatedParagraphRatio = repeatedParagraphShare(candidate);
  const hanText = hanOnly(candidate);
  const longestRepeatedHanSpan = longestDuplicatedHanSpan(hanText);

  const highOverlapWithParent = parent
    ? abnormalParentOverlap(parent, candidate)
    : false;
  if (highOverlapWithParent) {
    reasons.push('修订稿与 Writer 原文的 12-gram 重合率 ≥ 80%，未实质改写');
  }

  if (
    repeatedNgramRatio >= STATUS_BLOCKING_NGRAM_RATIO &&
    countHanCharacters(candidate) >= 200
  ) {
    reasons.push(
      `8–11 汉字 n-gram 重复率 ${(repeatedNgramRatio * 100).toFixed(1)}% ≥ ${STATUS_BLOCKING_NGRAM_RATIO * 100}%`,
    );
  }
  if (repeatedParagraphRatio >= STATUS_BLOCKING_PARAGRAPH_RATIO) {
    reasons.push(
      `段落 hash 重复率 ${(repeatedParagraphRatio * 100).toFixed(1)}% ≥ ${STATUS_BLOCKING_PARAGRAPH_RATIO * 100}%`,
    );
  }
  if (longestRepeatedHanSpan >= STATUS_BLOCKING_LONGEST_HAN_SPAN) {
    reasons.push(
      `最长连续重复汉字片段 ${longestRepeatedHanSpan} ≥ ${STATUS_BLOCKING_LONGEST_HAN_SPAN}`,
    );
  }

  // Whole-artifact duplication and high parent overlap are always blocking
  // regardless of the numeric thresholds above.
  const blocking =
    wholeArtifactDuplication ||
    highOverlapWithParent ||
    repeatedNgramRatio >= STATUS_BLOCKING_NGRAM_RATIO ||
    repeatedParagraphRatio >= STATUS_BLOCKING_PARAGRAPH_RATIO ||
    longestRepeatedHanSpan >= STATUS_BLOCKING_LONGEST_HAN_SPAN;
  const suspicious =
    !blocking &&
    (repeatedNgramRatio >= STATUS_SUSPICIOUS_NGRAM_RATIO ||
      repeatedParagraphRatio >= STATUS_SUSPICIOUS_PARAGRAPH_RATIO ||
      longestRepeatedHanSpan >= STATUS_SUSPICIOUS_LONGEST_HAN_SPAN);

  const status: ContinuationDuplicateStatus = blocking
    ? 'blocking'
    : suspicious
    ? 'suspicious'
    : 'within';

  return {
    status,
    repeatedParagraphRatio,
    repeatedNgramRatio,
    longestRepeatedHanSpan,
    wholeArtifactDuplication,
    highOverlapWithParent,
    reasons,
  };
}
