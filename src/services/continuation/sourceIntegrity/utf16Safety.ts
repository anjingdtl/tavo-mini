/**
 * UTF-16 code-unit helpers for continuation source chunking / hashing.
 *
 * JS strings are UTF-16. A fixed cut at N code units can land between a high
 * and low surrogate (e.g. emoji). That yields unpaired surrogates in adjacent
 * chunks; after Android SQLite TEXT round-trips the content length can diverge
 * from declared offsets and SourceReader absolute vs chapter-local slices
 * disagree — which surfaces as style-sample hash mismatch past ~65536.
 */

export function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

export function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Adjust a proposed exclusive end index so it does not split a surrogate pair.
 * Never returns 0 when `proposedEnd > 0` and `text` is non-empty (callers rely
 * on forward progress when flushing fixed-size bands).
 */
export function adjustUtf16ChunkEnd(text: string, proposedEnd: number): number {
  let end = Math.max(0, Math.min(Math.floor(proposedEnd), text.length));
  if (end > 0 && end < text.length) {
    const left = text.charCodeAt(end - 1);
    const right = text.charCodeAt(end);
    if (isHighSurrogate(left) && isLowSurrogate(right)) {
      end -= 1;
    }
  }
  if (end === 0 && text.length > 0 && proposedEnd > 0) {
    // Pathological: proposed cut was 1 and that single unit is a high surrogate
    // of a pair — take the full pair when available so we never emit an empty
    // chunk or stall the band flush loop.
    if (
      text.length >= 2 &&
      isHighSurrogate(text.charCodeAt(0)) &&
      isLowSurrogate(text.charCodeAt(1))
    ) {
      return 2;
    }
    return 1;
  }
  return end;
}

/**
 * Advance a cursor by up to `targetSize` UTF-16 units without splitting a
 * surrogate pair. Returns the exclusive end index.
 */
export function nextUtf16ChunkEnd(
  text: string,
  start: number,
  targetSize: number,
): number {
  if (start >= text.length) return start;
  const proposed = Math.min(start + Math.max(1, targetSize), text.length);
  // Rebase to a slice-local adjust so boundary logic stays local.
  const localEnd = adjustUtf16ChunkEnd(text.slice(start), proposed - start);
  return start + localEnd;
}
