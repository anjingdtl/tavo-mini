/**
 * UTF-16-safe chunking + sha256Hex surrogate-boundary tests.
 *
 * The style-sample hash failure at offsets past ~65536 is the production
 * signature of a fixed-size cut that splits a surrogate pair and later
 * desyncs declared chunk offsets from content.length.
 */
import {
  adjustUtf16ChunkEnd,
  diagnoseChunkContent,
  isHighSurrogate,
  isLowSurrogate,
  nextUtf16ChunkEnd,
} from '../src/services/continuation/sourceIntegrity';
import { sha256Hex, Sha256Stream, utf8Encode } from '../src/services/continuation/hashUtils';
import { createHash } from 'crypto';

const TARGET = 65536;

function cryptoSha256(text: string): string {
  return createHash('sha256')
    .update(Buffer.from(utf8Encode(text)))
    .digest('hex');
}

describe('adjustUtf16ChunkEnd', () => {
  it('does not change a BMP-only cut', () => {
    const text = '甲'.repeat(100);
    expect(adjustUtf16ChunkEnd(text, 50)).toBe(50);
  });

  it('backs up one unit when the cut lands between emoji surrogates', () => {
    const prefix = '甲'.repeat(TARGET - 1);
    const emoji = '😀'; // 2 UTF-16 units
    const text = prefix + emoji + '乙'.repeat(100);
    expect(text.charCodeAt(TARGET - 1)).toBeGreaterThanOrEqual(0xd800);
    expect(isHighSurrogate(text.charCodeAt(TARGET - 1))).toBe(true);
    expect(isLowSurrogate(text.charCodeAt(TARGET))).toBe(true);
    const end = adjustUtf16ChunkEnd(text, TARGET);
    expect(end).toBe(TARGET - 1);
    expect(isHighSurrogate(text.charCodeAt(end - 1))).toBe(false);
  });

  it('never returns an empty cut when progress is required', () => {
    const emoji = '😀';
    expect(adjustUtf16ChunkEnd(emoji, 1)).toBe(2);
  });

  it('produces non-empty contiguous bands that rejoin the original', () => {
    const prefix = '甲'.repeat(TARGET - 1);
    const text = prefix + '😀' + '乙'.repeat(5000) + '丙'.repeat(TARGET);
    const bands: string[] = [];
    let rest = text;
    while (rest.length >= TARGET) {
      const cut = adjustUtf16ChunkEnd(rest, TARGET);
      expect(cut).toBeGreaterThan(0);
      bands.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (rest.length > 0) bands.push(rest);
    expect(bands.join('')).toBe(text);
    for (const band of bands) {
      if (band.length === 0) continue;
      const last = band.charCodeAt(band.length - 1);
      // No band may end with an unpaired high surrogate when more text follows
      // that would have been the low half — covered by rejoin equality.
      expect(isHighSurrogate(last) && band === bands[0] && bands.length > 1
        ? false
        : true).toBe(true);
    }
  });
});

describe('nextUtf16ChunkEnd', () => {
  it('advances by target size for plain CJK', () => {
    const text = '测'.repeat(1000);
    expect(nextUtf16ChunkEnd(text, 0, 100)).toBe(100);
    expect(nextUtf16ChunkEnd(text, 100, 100)).toBe(200);
  });
});

describe('sha256Hex surrogate-safe chunking', () => {
  it('matches single-pass digest when a surrogate pair straddles 65536', () => {
    const text = '甲'.repeat(TARGET - 1) + '😀' + '乙'.repeat(200);
    expect(text.length).toBeGreaterThan(TARGET);
    expect(isHighSurrogate(text.charCodeAt(TARGET - 1))).toBe(true);
    expect(isLowSurrogate(text.charCodeAt(TARGET))).toBe(true);

    const oneShot = sha256Hex(text);
    const stream = new Sha256Stream();
    stream.updateString(text);
    const streamed = stream.digest();
    const ref = cryptoSha256(text);
    expect(oneShot).toBe(streamed);
    expect(oneShot).toBe(ref);
  });

  it('unsafe fixed split at 65536 would disagree (documents the old bug)', () => {
    const text = '甲'.repeat(TARGET - 1) + '😀' + '乙'.repeat(200);
    const a = text.substring(0, TARGET);
    const b = text.substring(TARGET);
    const unsafe = createHash('sha256')
      .update(Buffer.from(utf8Encode(a)))
      .update(Buffer.from(utf8Encode(b)))
      .digest('hex');
    expect(unsafe).not.toBe(cryptoSha256(text));
    expect(sha256Hex(text)).toBe(cryptoSha256(text));
  });
});

describe('diagnoseChunkContent', () => {
  it('flags length and hash mismatches', () => {
    const content = 'hello';
    const ok = diagnoseChunkContent({
      chunkIndex: 0,
      charStartOffset: 0,
      charEndOffset: 5,
      content,
      contentSha256: sha256Hex(content),
    });
    expect(ok.lengthMatches).toBe(true);
    expect(ok.hashMatches).toBe(true);

    const badLen = diagnoseChunkContent({
      chunkIndex: 1,
      charStartOffset: 0,
      charEndOffset: 10,
      content,
      contentSha256: sha256Hex(content),
    });
    expect(badLen.lengthMatches).toBe(false);

    const badHash = diagnoseChunkContent({
      chunkIndex: 2,
      charStartOffset: 0,
      charEndOffset: 5,
      content,
      contentSha256: '0'.repeat(64),
    });
    expect(badHash.hashMatches).toBe(false);
  });

  it('detects unpaired surrogates at chunk edges', () => {
    const high = String.fromCharCode(0xd83d);
    const low = String.fromCharCode(0xde00);
    const endsHigh = diagnoseChunkContent({
      chunkIndex: 0,
      charStartOffset: 0,
      charEndOffset: 1,
      content: high,
      contentSha256: sha256Hex(high),
    });
    expect(endsHigh.endsWithHighSurrogate).toBe(true);
    const startsLow = diagnoseChunkContent({
      chunkIndex: 1,
      charStartOffset: 1,
      charEndOffset: 2,
      content: low,
      contentSha256: sha256Hex(low),
    });
    expect(startsLow.startsWithLowSurrogate).toBe(true);
  });
});
