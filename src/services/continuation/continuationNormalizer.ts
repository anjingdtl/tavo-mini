/**
 * Continuation source text normalizer (Spec §10.3).
 *
 * Pure function: takes the already-decoded source string and produces the
 * normalized text plus metadata (char count, byte count, hash, version).
 *
 * Allowed transformations (Spec §10.3):
 *   - line endings → \n
 *   - strip leading BOM
 *   - remove NUL and non-whitespace control characters
 * Forbidden:
 *   - rewriting content, fixing typos, replacing sensitive words
 *   - compressing blank lines (would require bumping normalization_version)
 *
 * Offsets used by chunks/chapters/boundary are UTF-16 code-unit offsets into
 * the returned `text` (Spec §6).
 */
import { Sha256Stream, sha256Hex, utf8ByteLength } from './hashUtils';

/** Bumped only when the normalization algorithm changes (Spec §10.3). */
export const NORMALIZATION_VERSION = 'v1';

export interface NormalizedSource {
  text: string;
  normalizedCharCount: number;
  normalizedByteCount: number;
  normalizedSha256: string;
  normalizationVersion: string;
  removedBom: boolean;
  compressedBlankLines: boolean;
}

/** Remove a leading UTF-8/UTF-16 BOM if present. */
function stripBom(input: string): { text: string; removed: boolean } {
  if (input.charCodeAt(0) === 0xfeff) {
    return { text: input.slice(1), removed: true };
  }
  return { text: input, removed: false };
}

/** Remove NUL and non-whitespace C0/C1 control chars, keep \t \n \r. */
function stripControlChars(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    // Allow tab (0x09), LF (0x0A), CR (0x0D). Drop other C0 controls and DEL.
    if (ch === 0x09 || ch === 0x0a || ch === 0x0d) {
      out += input[i];
      continue;
    }
    if (ch < 0x20 || ch === 0x7f) {
      // NUL, BEL, BS, etc. — dropped.
      continue;
    }
    out += input[i];
  }
  return out;
}

/** Unify CRLF / CR to LF. Must run AFTER BOM strip and control-char removal. */
function unifyLineEndings(input: string): string {
  // Replace \r\n first, then any lone \r.
  return input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** Apply the full normalization pipeline (Spec §10.3). */
export function normalizeSourceText(raw: string): NormalizedSource {
  const bomStripped = stripBom(raw);
  const noControls = stripControlChars(bomStripped.text);
  const unified = unifyLineEndings(noControls);

  return {
    text: unified,
    normalizedCharCount: unified.length,
    normalizedByteCount: utf8ByteLength(unified),
    normalizedSha256: sha256Hex(unified),
    normalizationVersion: NORMALIZATION_VERSION,
    removedBom: bomStripped.removed,
    // Blank-line compression is NOT applied in v1 (Spec §10.3). The field is
    // reported so a future version can signal the change in previews.
    compressedBlankLines: false,
  };
}

/** Convenience: recompute the normalized SHA-256 for an already-normalized text. */
export function computeNormalizedSha256(normalizedText: string): string {
  return sha256Hex(normalizedText);
}

/**
 * Streaming normalizer metadata returned by {@link createStreamingNormalizer}.
 *
 * `normalizedCharCount` / `normalizedByteCount` / `normalizedSha256` mirror the
 * fields of {@link NormalizedSource} and are computed incrementally so the full
 * text never has to reside in memory at once.
 */
export interface StreamingNormalizerResult {
  normalizedCharCount: number;
  normalizedByteCount: number;
  normalizedSha256: string;
  normalizationVersion: string;
  removedBom: boolean;
  compressedBlankLines: boolean;
}

/**
 * Incremental normalizer (Spec §10.3, streaming variant).
 *
 * The one-shot {@link normalizeSourceText} forces the whole novel into memory.
 * The streaming variant keeps only a 1-char carry (`pendingCR`) plus running
 * counters, so memory is O(1). Feeding the same bytes in any chunking must
 * produce the same `normalizedCharCount` / `normalizedByteCount` /
 * `normalizedSha256` as the one-shot path.
 *
 * The only cross-chunk edge case is CRLF: `\r` at the end of one chunk and `\n`
 * at the start of the next must collapse to a single `\n`, matching the
 * `/\r\n/g` replacement in the one-shot path. We carry a `pendingCR` flag and
 * resolve it against the next chunk's first character.
 */
export interface StreamingNormalizer {
  /**
   * Normalize one decoded chunk. Returns the normalized text produced from this
   * chunk (the concatenation of all `push` outputs equals the one-shot result).
   */
  push(chunk: string): string;
  /** Finalize and return the aggregate metadata. No more `push` calls after this. */
  finalize(): StreamingNormalizerResult;
}

export function createStreamingNormalizer(): StreamingNormalizer {
  let seenFirstChunk = false;
  let removedBom = false;
  let pendingCR = false; // previous chunk ended with a lone \r awaiting resolution
  // If a chunk ends with a lone high surrogate (the first half of an emoji),
  // defer it to the next chunk so byte-length and hashing operate on whole
  // code points. In production the native decoder never splits a code point,
  // but the streaming API must stay correct for any chunking.
  let pendingHighSurrogate = '';
  let charCount = 0;
  let byteCount = 0;
  const hasher = new Sha256Stream();

  const push = (chunk: string): string => {
    let text = pendingHighSurrogate + chunk;
    pendingHighSurrogate = '';
    // Carry a trailing lone high surrogate (U+D800..U+DBFF) to the next chunk.
    if (text.length > 0) {
      const last = text.charCodeAt(text.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) {
        pendingHighSurrogate = text.slice(text.length - 1);
        text = text.slice(0, text.length - 1);
      }
    }

    // BOM strip — only on the very first chunk, mirroring stripBom().
    if (!seenFirstChunk) {
      seenFirstChunk = true;
      if (text.charCodeAt(0) === 0xfeff) {
        text = text.slice(1);
        removedBom = true;
      }
    }

    // Control-char strip is stateless and per-character (keeps \t \n \r). Doing
    // it before CRLF resolution matches the one-shot order (stripControlChars
    // then unifyLineEndings) and guarantees \r survives to this step.
    text = stripControlChars(text);

    // Resolve a pending \r from the previous chunk against this chunk's start.
    // One-shot does /\r\n/g → \n then /\r/g → \n, so either way the \r becomes
    // a single \n; the only question is whether the next chunk's leading \n is
    // consumed as the CRLF partner (drop it) or left in place (lone-\r case).
    let prefix = '';
    if (pendingCR) {
      pendingCR = false;
      prefix = '\n';
      if (text.charCodeAt(0) === 0x0a) {
        // CRLF partner: consume the \n so we emit exactly one \n total.
        text = text.slice(1);
      }
    }
    text = prefix + text;

    // A trailing lone \r must be deferred to the next chunk in case it pairs
    // with a leading \n there. After trimming it, any remaining \r in this
    // chunk cannot pair across the trimmed boundary, so collapse CRLF pairs
    // first (matching one-shot /\r\n/g → \n) then convert any lone \r → \n.
    if (text.length > 0 && text.charCodeAt(text.length - 1) === 0x0d) {
      pendingCR = true;
      text = text.slice(0, -1);
    }
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    charCount += text.length;
    byteCount += utf8ByteLength(text);
    hasher.updateString(text);
    return text;
  };

  const finalize = (): StreamingNormalizerResult => {
    // Flush a deferred high surrogate: an orphaned high surrogate is not valid
    // UTF-8, but utf8Encode encodes it as 3 bytes (matching the one-shot path
    // if the source ended mid-pair — which is a malformed source anyway).
    if (pendingHighSurrogate) {
      const carried = pendingHighSurrogate;
      pendingHighSurrogate = '';
      // Re-run only the byte/hash accounting for the carried char; control-char
      // strip and BOM already handled on prior chunks. \r is impossible here.
      charCount += carried.length;
      byteCount += utf8ByteLength(carried);
      hasher.updateString(carried);
    }
    // A dangling pendingCR (chunk ended with \r and no more input) is a lone \r
    // → \n, matching the one-shot /\r/g replacement at EOF.
    if (pendingCR) {
      const tail = '\n';
      charCount += tail.length;
      byteCount += utf8ByteLength(tail);
      hasher.updateString(tail);
      pendingCR = false;
    }
    return {
      normalizedCharCount: charCount,
      normalizedByteCount: byteCount,
      normalizedSha256: hasher.digest(),
      normalizationVersion: NORMALIZATION_VERSION,
      removedBom,
      compressedBlankLines: false,
    };
  };

  return { push, finalize };
}
