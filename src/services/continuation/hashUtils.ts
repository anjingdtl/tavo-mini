/**
 * Synchronous SHA-256 + UTF-8 helpers for the continuation pipeline (Spec §6).
 *
 * Both the raw-byte hash (original file) and the normalized-text hash must be
 * SHA-256 lowercase hex. The normalized hash is taken over the UTF-8 bytes of
 * the *normalized* string (Spec §6). This is a standalone copy of the
 * algorithm used in backupService so the continuation code has no async
 * dependency; backupService keeps its cooperative variant for very large
 * backups.
 */
/* eslint-disable no-bitwise */

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b,
  0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7,
  0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152,
  0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
  0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
  0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** UTF-8 encode a JS string to bytes without TextEncoder (RN hermes-safe). */
export function utf8Encode(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    let codePoint = value.charCodeAt(i);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff && i + 1 < value.length) {
      // Combine a surrogate pair into a code point.
      const low = value.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint =
          0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
        i += 1;
        bytes.push(
          0xf0 | (codePoint >> 18),
          0x80 | ((codePoint >> 12) & 0x3f),
          0x80 | ((codePoint >> 6) & 0x3f),
          0x80 | (codePoint & 0x3f),
        );
        continue;
      }
    }
    if (codePoint < 0x80) {
      bytes.push(codePoint);
    } else if (codePoint < 0x800) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes);
}

/** Count UTF-8 bytes a JS string would encode to (surrogate-aware). */
export function utf8ByteLength(value: string): number {
  return utf8Encode(value).length;
}

/**
 * Compress a single 64-byte block into the running hash state (SHA-256 core).
 *
 * Shared by the one-shot {@link sha256Hex} and the streaming {@link Sha256Stream}
 * so both paths produce identical digests. `block` must be exactly 64 bytes;
 * the caller schedules message-schedule words and updates h0..h7 in place.
 */
function compressBlock(
  block: Uint8Array,
  state: { h0: number; h1: number; h2: number; h3: number; h4: number; h5: number; h6: number; h7: number },
): void {
  const words = new Uint32Array(64);
  for (let index = 0; index < 16; index += 1) {
    const offset = index * 4;
    words[index] = (
      (block[offset] << 24)
      | (block[offset + 1] << 16)
      | (block[offset + 2] << 8)
      | block[offset + 3]
    ) >>> 0;
  }
  for (let index = 16; index < 64; index += 1) {
    const s0 = rotateRight(words[index - 15], 7)
      ^ rotateRight(words[index - 15], 18)
      ^ (words[index - 15] >>> 3);
    const s1 = rotateRight(words[index - 2], 17)
      ^ rotateRight(words[index - 2], 19)
      ^ (words[index - 2] >>> 10);
    words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
  }

  let a = state.h0;
  let b = state.h1;
  let c = state.h2;
  let d = state.h3;
  let e = state.h4;
  let f = state.h5;
  let g = state.h6;
  let h = state.h7;

  for (let index = 0; index < 64; index += 1) {
    const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
    const choose = (e & f) ^ (~e & g);
    const temp1 = (h + s1 + choose + SHA256_K[index] + words[index]) >>> 0;
    const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
    const majority = (a & b) ^ (a & c) ^ (b & c);
    const temp2 = (s0 + majority) >>> 0;
    h = g;
    g = f;
    f = e;
    e = (d + temp1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (temp1 + temp2) >>> 0;
  }

  state.h0 = (state.h0 + a) >>> 0;
  state.h1 = (state.h1 + b) >>> 0;
  state.h2 = (state.h2 + c) >>> 0;
  state.h3 = (state.h3 + d) >>> 0;
  state.h4 = (state.h4 + e) >>> 0;
  state.h5 = (state.h5 + f) >>> 0;
  state.h6 = (state.h6 + g) >>> 0;
  state.h7 = (state.h7 + h) >>> 0;
}

const INITIAL_STATE = {
  h0: 0x6a09e667,
  h1: 0xbb67ae85,
  h2: 0x3c6ef372,
  h3: 0xa54ff53a,
  h4: 0x510e527f,
  h5: 0x9b05688c,
  h6: 0x1f83d9ab,
  h7: 0x5be0cd19,
};

function stateToHex(state: typeof INITIAL_STATE): string {
  return [state.h0, state.h1, state.h2, state.h3, state.h4, state.h5, state.h6, state.h7]
    .map(word => word.toString(16).padStart(8, '0'))
    .join('');
}

/**
 * Synchronous SHA-256 lowercase hex of a string's UTF-8 bytes (Spec §6).
 *
 * 实现委托给 {@link Sha256Stream} 分块处理（每块 64K 字符），避免一次性
 * `utf8Encode` 整个字符串导致的 OOM。签名保持同步不变，所有调用点
 *（generation / import / canon）自动受益。digest 与原 one-shot 实现等价
 *（已由 __tests__/continuationHashStream.test.ts 覆盖等价性）。
 */
export function sha256Hex(value: string): string {
  const stream = new Sha256Stream();
  // Chunk large strings to avoid one-shot utf8Encode OOM. Must NOT cut inside
  // a UTF-16 surrogate pair: utf8Encode encodes an unpaired high/low surrogate
  // as a 3-byte sequence, while a complete emoji is 4 bytes — a mid-pair cut
  // at exactly 65536 would make streaming digests diverge from a single pass.
  const CHUNK_SIZE = 65536;
  let pos = 0;
  while (pos < value.length) {
    let end = pos + CHUNK_SIZE < value.length ? pos + CHUNK_SIZE : value.length;
    if (end > pos && end < value.length) {
      const left = value.charCodeAt(end - 1);
      // High surrogate U+D800..U+DBFF followed by low surrogate → back up one.
      if (left >= 0xd800 && left <= 0xdbff) {
        end -= 1;
      }
    }
    if (end <= pos) {
      // Pathological single high-surrogate unit: still advance to avoid hang.
      end = pos + 1;
    }
    stream.updateString(value.substring(pos, end));
    pos = end;
  }
  return stream.digest();
}

/**
 * Incremental SHA-256 over UTF-8 bytes (Spec §6, streaming variant).
 *
 * The one-shot {@link sha256Hex} forces the entire input into JS memory, which
 * OOMs the continuation import pipeline on multi-MB novels. Sha256Stream keeps
 * only a <64-byte pending buffer plus the 8-word hash state, so memory is O(1)
 * regardless of input size. `updateString` chunks may be fed in any sizes; the
 * digest equals `sha256Hex` of the concatenated string.
 *
 * Usage:
 *   const s = new Sha256Stream();
 *   for (const chunk of chunks) s.updateString(chunk);
 *   const hex = s.digest();
 */
export class Sha256Stream {
  private state = { ...INITIAL_STATE };
  private pending: Uint8Array = new Uint8Array(0);
  private totalBytes = 0;

  /** Feed raw bytes into the hash. */
  update(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this.totalBytes += bytes.length;
    // Combine with any leftover tail, then compress every full 64-byte block.
    const combined =
      this.pending.length === 0
        ? bytes
        : _concatBytes(this.pending, bytes);
    const fullBlocks = Math.floor(combined.length / 64);
    for (let i = 0; i < fullBlocks; i += 1) {
      compressBlock(combined.subarray(i * 64, i * 64 + 64), this.state);
    }
    const consumed = fullBlocks * 64;
    this.pending = combined.subarray(consumed);
  }

  /** Feed a JS string's UTF-8 bytes into the hash (surrogate-aware). */
  updateString(text: string): void {
    this.update(utf8Encode(text));
  }

  /** Finalize and return the lowercase hex digest. The stream is exhausted. */
  digest(): string {
    const bitLength = this.totalBytes * 8;
    // Append 0x80, then pad with zeros, leaving room for the 8-byte length.
    const tailLen = this.pending.length;
    // If tail fits 0x80 + 8 length bytes in one block, use one padding block;
    // otherwise two. tailLen <= 63 always (pending holds <64 bytes).
    const paddedLength = tailLen + 1 + 8 <= 64 ? 64 : 128;
    const padded = new Uint8Array(paddedLength);
    padded.set(this.pending);
    padded[tailLen] = 0x80;
    for (let offset = 0; offset < 8; offset += 1) {
      padded[paddedLength - 1 - offset] = (bitLength / 2 ** (offset * 8)) & 0xff;
    }
    for (let block = 0; block < paddedLength; block += 64) {
      compressBlock(padded.subarray(block, block + 64), this.state);
    }
    // Reset so a stray digest() call cannot return a half-baked state.
    const hex = stateToHex(this.state);
    this.pending = new Uint8Array(0);
    this.totalBytes = 0;
    return hex;
  }
}

function _concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/* eslint-enable no-bitwise */
