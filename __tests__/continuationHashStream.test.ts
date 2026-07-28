/**
 * Sha256Stream tests (Spec §6 streaming variant).
 *
 * The streaming hasher must produce the same digest as the one-shot sha256Hex
 * for any input and any chunking. The continuation import pipeline relies on
 * this equivalence to hash multi-MB novels without holding them in memory.
 */
import { sha256Hex, Sha256Stream, utf8Encode } from '../src/services/continuation/hashUtils';

describe('Sha256Stream equivalence with one-shot sha256Hex', () => {
  it('matches sha256Hex for an empty input', () => {
    const oneShot = sha256Hex('');
    const stream = new Sha256Stream();
    expect(stream.digest()).toBe(oneShot);
  });

  it('matches sha256Hex for ASCII text across many split points', () => {
    const text = 'The quick brown fox jumps over the lazy dog';
    const oneShot = sha256Hex(text);
    for (const splitEvery of [1, 2, 3, 7, 16, 64, 1000]) {
      const stream = new Sha256Stream();
      for (let i = 0; i < text.length; i += splitEvery) {
        stream.updateString(text.slice(i, i + splitEvery));
      }
      expect(stream.digest()).toBe(oneShot);
    }
  });

  it('matches sha256Hex for CJK text (multibyte UTF-8)', () => {
    const text = '第一章　天朗气清，惠风和畅。第二章　山雨欲来风满楼。';
    const oneShot = sha256Hex(text);
    // Split inside multibyte sequences — utf8Encode per chunk still yields the
    // same bytes because each chunk is a complete UTF-16 string slice.
    for (const splitEvery of [1, 3, 5, 13]) {
      const stream = new Sha256Stream();
      for (let i = 0; i < text.length; i += splitEvery) {
        stream.updateString(text.slice(i, i + splitEvery));
      }
      expect(stream.digest()).toBe(oneShot);
    }
  });

  it('matches sha256Hex across the 64-byte block boundary', () => {
    // 200 chars → UTF-8 spans multiple 64-byte blocks; split at 63/64/65 to
    // exercise block-boundary handling in update().
    const text = 'x'.repeat(200);
    const oneShot = sha256Hex(text);
    for (const splitEvery of [63, 64, 65, 128]) {
      const stream = new Sha256Stream();
      for (let i = 0; i < text.length; i += splitEvery) {
        stream.updateString(text.slice(i, i + splitEvery));
      }
      expect(stream.digest()).toBe(oneShot);
    }
  });

  it('matches sha256Hex for a surrogate-pair (emoji) string', () => {
    // '😀' is a surrogate pair (2 UTF-16 code units) → 4 UTF-8 bytes. Slicing
    // between the two surrogates would be illegal, but slice() on a complete
    // emoji keeps the pair intact, so each chunk is still valid UTF-16.
    const text = 'A😀B😀C';
    const oneShot = sha256Hex(text);
    const stream = new Sha256Stream();
    stream.updateString('A');
    stream.updateString('😀');
    stream.updateString('B😀C');
    expect(stream.digest()).toBe(oneShot);
  });

  it('matches sha256Hex when fed raw bytes (update) instead of strings', () => {
    const text = '混合 mixed 文本 123';
    const bytes = utf8Encode(text);
    const oneShot = sha256Hex(text);
    // Split the byte array at arbitrary offsets, including inside multibyte
    // sequences — the hasher is byte-oriented, so this must still match.
    for (const splitAt of [1, 4, 7, bytes.length - 1]) {
      const stream = new Sha256Stream();
      stream.update(bytes.subarray(0, splitAt));
      stream.update(bytes.subarray(splitAt));
      expect(stream.digest()).toBe(oneShot);
    }
  });

  it('produces the known SHA-256 of "abc"', () => {
    // RFC 6234 test vector: SHA-256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    const stream = new Sha256Stream();
    stream.updateString('abc');
    expect(stream.digest()).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('handles a large input (>64KB) in small chunks with O(1) memory footprint', () => {
    // 100k chars of CJK — would be a single huge blob one-shot; stream it 1k
    // at a time. Equivalence must still hold.
    const text = '测试'.repeat(50000);
    const oneShot = sha256Hex(text);
    const stream = new Sha256Stream();
    for (let i = 0; i < text.length; i += 1000) {
      stream.updateString(text.slice(i, i + 1000));
    }
    expect(stream.digest()).toBe(oneShot);
  });
});
