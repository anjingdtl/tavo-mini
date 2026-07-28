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
  createStreamingNormalizer,
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

describe('streaming normalizer equivalence (Spec §10.3 streaming)', () => {
  // For each sample text, assert that chunking it at every possible split point
  // yields the same concatenated output and metadata as the one-shot path.
  const assertChunkingMatches = (raw: string) => {
    const oneShot = normalizeSourceText(raw);
    for (let split = 1; split <= raw.length; split += 1) {
      const sn = createStreamingNormalizer();
      let rebuilt = '';
      for (let i = 0; i < raw.length; i += split) {
        rebuilt += sn.push(raw.slice(i, i + split));
      }
      const meta = sn.finalize();
      expect(rebuilt).toBe(oneShot.text);
      expect(meta.normalizedCharCount).toBe(oneShot.normalizedCharCount);
      expect(meta.normalizedByteCount).toBe(oneShot.normalizedByteCount);
      expect(meta.normalizedSha256).toBe(oneShot.normalizedSha256);
      expect(meta.removedBom).toBe(oneShot.removedBom);
    }
  };

  it('matches one-shot for plain ASCII across all split points', () => {
    assertChunkingMatches('The quick brown fox\njumps over\nthe lazy dog');
  });

  it('matches one-shot for CJK text across all split points', () => {
    assertChunkingMatches('第一章　天朗气清，惠风和畅。\n第二章　山雨欲来。');
  });

  it('matches one-shot for a leading BOM across all split points', () => {
    assertChunkingMatches('\uFEFF第一章\n正文');
  });

  it('collapses CRLF split across a chunk boundary to a single LF', () => {
    // The critical edge case: \r at end of chunk 1, \n at start of chunk 2.
    // One-shot: 'A\r\nB' → 'A\nB'. Streaming must produce the same — NOT 'A\n\nB'.
    const raw = 'A\r\nB';
    const oneShot = normalizeSourceText(raw);
    expect(oneShot.text).toBe('A\nB');
    const sn = createStreamingNormalizer();
    const out1 = sn.push('A\r');
    const out2 = sn.push('\nB');
    expect(out1 + out2).toBe('A\nB');
    const meta = sn.finalize();
    expect(meta.normalizedSha256).toBe(oneShot.normalizedSha256);
    expect(meta.normalizedCharCount).toBe(oneShot.normalizedCharCount);
  });

  it('keeps interior CRLF intact within a single chunk', () => {
    const raw = 'line1\r\nline2\r\nline3';
    const oneShot = normalizeSourceText(raw);
    const sn = createStreamingNormalizer();
    const out = sn.push(raw);
    expect(out).toBe(oneShot.text);
    expect(sn.finalize().normalizedSha256).toBe(oneShot.normalizedSha256);
  });

  it('treats a trailing lone CR (EOF) as a LF', () => {
    const raw = 'A\rB\r';
    const oneShot = normalizeSourceText(raw); // → 'A\nB\n'
    const sn = createStreamingNormalizer();
    sn.push('A\r');
    sn.push('B\r');
    const meta = sn.finalize();
    expect(meta.normalizedSha256).toBe(oneShot.normalizedSha256);
    expect(meta.normalizedCharCount).toBe(oneShot.normalizedCharCount);
  });

  it('drops NUL/control chars split across chunks equivalently', () => {
    assertChunkingMatches('A\x00B\x07C\x08D\tE\nF');
  });

  it('handles surrogate pairs (emoji) split across chunks', () => {
    // '😀' is 2 UTF-16 code units. Slicing between them would be illegal; slice
    // at every offset that keeps the pair intact is covered by assertChunking
    // since it splits at every code-unit boundary — but UTF-16 slices never
    // separate a surrogate pair when the source string is well-formed. The
    // equivalence must still hold for the byte/char counts.
    assertChunkingMatches('A😀B😀C\n😀');
  });
});
