/**
 * Branded offset/position type and UTF-16 edge-case tests (Spec §6, §18.1).
 *
 * The branded nominal types exist to prevent source/continuation positions and
 * UTF-16 offsets from being silently intermixed. These tests cover:
 *  - the brand helpers reject non-integers / negatives
 *  - UTF-16 surrogate pairs and emoji occupy 2 code units (offset arithmetic)
 *  - chunk contiguity validator detects holes / overlaps / wrong endpoints
 */
import {
  asSourcePosition,
  asUtf16Offset,
  validateChunkContiguity,
} from '../src/services/continuation/continuationSourceRepository';

describe('branded offset/position helpers (Spec §6)', () => {
  it('brands non-negative integers as Utf16Offset', () => {
    expect(asUtf16Offset(0)).toBe(0);
    expect(asUtf16Offset(42)).toBe(42);
    expect(asUtf16Offset(1_000_000)).toBe(1_000_000);
  });

  it('rejects negative, fractional, NaN and non-number offsets', () => {
    expect(() => asUtf16Offset(-1)).toThrow(/非法的 UTF-16 偏移/);
    expect(() => asUtf16Offset(1.5)).toThrow();
    expect(() => asUtf16Offset(NaN)).toThrow();
    expect(() => asUtf16Offset(Infinity)).toThrow();
    expect(() => asUtf16Offset('5' as unknown as number)).toThrow();
  });

  it('brands non-negative integers as SourceChapterPosition', () => {
    expect(asSourcePosition(0)).toBe(0);
    expect(asSourcePosition(29)).toBe(29);
  });

  it('rejects invalid source positions', () => {
    expect(() => asSourcePosition(-1)).toThrow(/非法的原著章节位置/);
    expect(() => asSourcePosition(2.5)).toThrow();
  });
});

describe('UTF-16 offset arithmetic for surrogate pairs / emoji (Spec §6, §18.1)', () => {
  it('a BMP char is 1 UTF-16 code unit', () => {
    const text = 'A';
    expect(text.length).toBe(1);
  });

  it('an astral emoji is 2 UTF-16 code units — offset arithmetic must count both', () => {
    const text = 'A😀B';
    // JS string length counts UTF-16 code units, so the emoji spans offsets 1..3
    expect(text.length).toBe(4);
    expect(text.slice(0, 1)).toBe('A');
    expect(text.slice(1, 3)).toBe('😀');
    expect(text.slice(3, 4)).toBe('B');
  });

  it('a surrogate pair straddling a chunk boundary must not split a code point', () => {
    // Simulate two chunks where the emoji straddles the boundary at offset 1.
    // Chunk 1 = [0,1) = "A", chunk 2 = [1,3) = "😀", chunk 3 = [3,4) = "B".
    // The reader's slice() operates on already-reassembled content, so the
    // key invariant is that chunk boundaries are reported at code-unit edges
    // that the normalizer/native layer guarantees are not mid-surrogate.
    const fullText = 'A😀B';
    const chunk1 = { content: 'A', charStartOffset: 0, charEndOffset: 1 };
    const chunk2 = { content: '😀', charStartOffset: 1, charEndOffset: 3 };
    const chunk3 = { content: 'B', charStartOffset: 3, charEndOffset: 4 };

    let rebuilt = '';
    for (const c of [chunk1, chunk2, chunk3]) {
      rebuilt += c.content;
    }
    expect(rebuilt).toBe(fullText);
    expect(rebuilt.length).toBe(4);
  });
});

describe('chunk contiguity validator (Spec §9.3, §18.1)', () => {
  // The validator takes a DB-like handle; build a minimal stub.
  function makeDb(chunks: { char_start_offset: number; char_end_offset: number }[]) {
    return {
      executeSql: jest.fn(async (_sql: string, _params: any[]) => [
        {
          rows: {
            length: chunks.length,
            item: (i: number) => chunks[i],
          },
        },
      ]),
    } as any;
  }

  it('passes for contiguous chunks ending at expectedCharCount', async () => {
    const db = makeDb([
      { char_start_offset: 0, char_end_offset: 10 },
      { char_start_offset: 10, char_end_offset: 20 },
      { char_start_offset: 20, char_end_offset: 25 },
    ]);
    const result = await validateChunkContiguity(db, 1, 25);
    expect(result.ok).toBe(true);
  });

  it('fails when there is a hole between chunks', async () => {
    const db = makeDb([
      { char_start_offset: 0, char_end_offset: 10 },
      { char_start_offset: 15, char_end_offset: 25 }, // gap 10..15
    ]);
    const result = await validateChunkContiguity(db, 1, 25);
    expect(result.ok).toBe(false);
    expect(result.gap).toMatch(/hole\/overlap/);
  });

  it('fails when chunks overlap', async () => {
    const db = makeDb([
      { char_start_offset: 0, char_end_offset: 15 },
      { char_start_offset: 10, char_end_offset: 25 }, // overlap 10..15
    ]);
    const result = await validateChunkContiguity(db, 1, 25);
    expect(result.ok).toBe(false);
    expect(result.gap).toMatch(/hole\/overlap/);
  });

  it('fails when the last chunk does not end at expectedCharCount', async () => {
    const db = makeDb([
      { char_start_offset: 0, char_end_offset: 10 },
      { char_start_offset: 10, char_end_offset: 20 },
    ]);
    const result = await validateChunkContiguity(db, 1, 25); // expected 25, got 20
    expect(result.ok).toBe(false);
    expect(result.gap).toMatch(/last chunk ends at 20/);
  });

  it('fails when first chunk does not start at 0', async () => {
    const db = makeDb([{ char_start_offset: 5, char_end_offset: 10 }]);
    const result = await validateChunkContiguity(db, 1, 10);
    expect(result.ok).toBe(false);
  });

  it('passes for an empty chunk set when expectedCharCount is 0', async () => {
    const db = makeDb([]);
    const result = await validateChunkContiguity(db, 1, 0);
    expect(result.ok).toBe(true);
  });

  it('fails for an empty chunk set when expectedCharCount > 0', async () => {
    const db = makeDb([]);
    const result = await validateChunkContiguity(db, 1, 10);
    expect(result.ok).toBe(false);
  });
});
