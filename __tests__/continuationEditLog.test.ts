/**
 * Preview edit-log tests (Spec §11.2, §18.1).
 *
 * The edit log captures user edits on the parsed-chapter preview (rename,
 * merge, split, exclude) as a small, replayable log so the source/chunks are
 * never rewritten during preview. Edits only touch chapter metadata.
 */
import {
  applyParsingEdits,
  renameChapter,
  mergeWithPrevious,
  splitChapter,
  toggleExclusion,
  resetToDetected,
  type ParsingEdit,
} from '../src/services/continuation/continuationEditLog';
import type { ParsedChapter } from '../src/services/continuation/continuationParser';
import type { Utf16Offset } from '../src/types/novel';

function mkChapter(
  pos: number,
  title: string,
  start: number,
  end: number,
): ParsedChapter {
  return {
    position: pos as any,
    volumeTitle: null,
    detectedTitle: title,
    title,
    sourceStartOffset: start as Utf16Offset,
    contentStartOffset: (start + title.length + 1) as Utf16Offset,
    sourceEndOffset: end as Utf16Offset,
    charCount: end - start,
    paragraphCount: 1,
    contentSha256: 'x',
  };
}

function threeChapters(): ParsedChapter[] {
  return [
    mkChapter(0, '第一章', 0, 30),
    mkChapter(1, '第二章', 30, 60),
    mkChapter(2, '第三章', 60, 100),
  ];
}

describe('continuation preview edit log (Spec §11.2)', () => {
  it('rename only changes title; detectedTitle is preserved', () => {
    const edits: ParsingEdit[] = [renameChapter(1, '新标题')];
    const result = applyParsingEdits(threeChapters(), edits);
    expect(result[1].title).toBe('新标题');
    expect(result[1].detectedTitle).toBe('第二章');
    // Offsets unchanged.
    expect(result[1].sourceStartOffset).toBe(30);
  });

  it('mergeWithPrevious joins chapter N into N-1 and renumbers positions', () => {
    const edits: ParsingEdit[] = [mergeWithPrevious(2)]; // 第三章 into 第二章
    const result = applyParsingEdits(threeChapters(), edits);
    expect(result).toHaveLength(2);
    expect(result[1].sourceEndOffset).toBe(100); // extends to old ch3 end
    expect(result[1].sourceStartOffset).toBe(30);
    expect(result.map(c => c.position)).toEqual([0, 1]);
  });

  it('mergeWithPrevious at position 0 is a no-op', () => {
    const edits: ParsingEdit[] = [mergeWithPrevious(0)];
    const result = applyParsingEdits(threeChapters(), edits);
    expect(result).toHaveLength(3);
  });

  it('splitChapter divides a chapter at a UTF-16 offset into two', () => {
    // Split 第二章 (30..60) at offset 45.
    const edits: ParsingEdit[] = [splitChapter(1, 45 as Utf16Offset, '上半', '下半')];
    const result = applyParsingEdits(threeChapters(), edits);
    expect(result).toHaveLength(4);
    expect(result[1].sourceStartOffset).toBe(30);
    expect(result[1].sourceEndOffset).toBe(45);
    expect(result[2].sourceStartOffset).toBe(45);
    expect(result[2].sourceEndOffset).toBe(60);
    expect(result.map(c => c.position)).toEqual([0, 1, 2, 3]);
  });

  it('toggleExclusion flips is_excluded with a reason', () => {
    const edits: ParsingEdit[] = [toggleExclusion(1, true, '重复内容')];
    const result = applyParsingEdits(threeChapters(), edits);
    expect(result[1].isExcluded).toBe(true);
    expect(result[1].exclusionReason).toBe('重复内容');
  });

  it('resetToDetected restores titles from detectedTitle and clears exclusions', () => {
    const edits: ParsingEdit[] = [
      renameChapter(1, 'X'),
      toggleExclusion(2, true, 'r'),
      resetToDetected(),
    ];
    const result = applyParsingEdits(threeChapters(), edits);
    expect(result[1].title).toBe('第二章');
    expect(result[2].isExcluded).toBe(false);
    expect(result[2].exclusionReason).toBeNull();
  });

  it('a sequence of edits replays in order', () => {
    const edits: ParsingEdit[] = [
      renameChapter(0, '序章'),
      mergeWithPrevious(2),
      toggleExclusion(1, true, '测试'),
    ];
    const result = applyParsingEdits(threeChapters(), edits);
    expect(result).toHaveLength(2);
    expect(result[0].title).toBe('序章');
    expect(result[1].isExcluded).toBe(true);
  });

  it('splitChapter rejects an offset outside the chapter range', () => {
    const edits: ParsingEdit[] = [splitChapter(1, 999 as Utf16Offset, 'a', 'b')];
    expect(() => applyParsingEdits(threeChapters(), edits)).toThrow(/超出章节范围/);
  });
});
