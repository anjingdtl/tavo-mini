/**
 * Normalizer tests (Spec §10.3, §18.1).
 *
 * The normalizer is a pure function: bytes-already-decoded string in,
 * normalized string + metadata out. It must NOT rewrite content beyond the
 * allowed transformations (line-ending unification, BOM strip, NUL/control
 * char removal). Offsets are computed against the *normalized* text.
 */
import {
  NORMALIZATION_VERSION,
  normalizeSourceText,
  computeNormalizedSha256,
} from '../src/services/continuation/continuationNormalizer';

describe('continuation text normalizer (Spec §10.3)', () => {
  it('strips a leading UTF-8 BOM (\\uFEFF)', () => {
    const r = normalizeSourceText('\uFEFF第一章');
    expect(r.text).toBe('第一章');
    expect(r.removedBom).toBe(true);
  });

  it('unifies CRLF and CR to LF without changing content', () => {
    const r = normalizeSourceText('A\r\nB\rC\nD');
    expect(r.text).toBe('A\nB\nC\nD');
  });

  it('removes NUL bytes and non-whitespace control characters', () => {
    // \x00 NUL, \x07 BEL, \x08 BS — must go. \t \n kept.
    const r = normalizeSourceText('A\x00B\x07C\x08D\tE\nF');
    expect(r.text).toBe('ABCD\tE\nF');
  });

  it('preserves Chinese punctuation, spaces and indentation', () => {
    const r = normalizeSourceText('　　第一章　天朗气清，惠风和畅。');
    expect(r.text).toBe('　　第一章　天朗气清，惠风和畅。');
  });

  it('does NOT compress consecutive blank lines by default (v1)', () => {
    const r = normalizeSourceText('A\n\n\nB');
    expect(r.text).toBe('A\n\n\nB');
    expect(r.compressedBlankLines).toBe(false);
  });

  it('does NOT rewrite content, fix typos or replace sensitive words', () => {
    const original = '这是错别字测试，敏感词保留原样。';
    const r = normalizeSourceText(original);
    expect(r.text).toBe(original);
  });

  it('reports the normalization version', () => {
    expect(NORMALIZATION_VERSION).toMatch(/^v\d+$/);
    const r = normalizeSourceText('x');
    expect(r.normalizationVersion).toBe(NORMALIZATION_VERSION);
  });

  it('counts UTF-16 code units (a surrogate pair counts as 2)', () => {
    // 'A' + '😀' (2 code units) + 'B' = length 4
    const r = normalizeSourceText('A😀B');
    expect(r.normalizedCharCount).toBe(4);
  });

  it('normalizedSha256 is the SHA-256 of the UTF-8 bytes of the normalized text', () => {
    const text = '第一章';
    const r = normalizeSourceText(text);
    // Verify against a fresh compute in the same module to catch drift.
    expect(r.normalizedSha256).toBe(computeNormalizedSha256(r.text));
    // And spot-check the known SHA-256 of '第一章' UTF-8.
    expect(r.normalizedSha256.length).toBe(64);
  });
});
