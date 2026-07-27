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
import { sha256Hex, utf8ByteLength } from './hashUtils';

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
