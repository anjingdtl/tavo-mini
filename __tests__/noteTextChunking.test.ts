import { splitNoteTextIntoChunks } from '../src/services/database';
import { getNoteChapters } from '../src/utils/noteChapters';

describe('getNoteChapters', () => {
  test('returns display titles and offsets for all recognized chapter headings', () => {
    const content = `导语\n第1章 初遇\n内容\n# 第二章\n内容\nChapter 3 Finale\n内容`;

    expect(getNoteChapters(content)).toEqual([
      { title: '第1章 初遇', offset: 3 },
      { title: '# 第二章', offset: 13 },
      { title: 'Chapter 3 Finale', offset: 22 },
    ]);
  });
});

describe('splitNoteTextIntoChunks', () => {
  test('prefers complete chapters before the size limit', () => {
    const first = `第1章 初遇\n${'甲'.repeat(40)}\n`;
    const second = `第2章 同行\n${'乙'.repeat(40)}\n`;
    const third = `第3章 终局\n${'丙'.repeat(40)}`;

    expect(splitNoteTextIntoChunks(`${first}${second}${third}`, 100)).toEqual([
      `${first}${second}`,
      third,
    ]);
  });

  test('recognizes Markdown and English chapter headings', () => {
    const markdown = `# 第一章\n${'甲'.repeat(60)}\n`;
    const english = `Chapter 2 Next\n${'乙'.repeat(60)}`;

    expect(splitNoteTextIntoChunks(`${markdown}${english}`, 100)).toEqual([markdown, english]);
  });

  test('splits an oversized individual chapter at a natural line boundary', () => {
    const content = `第1章 很长的一章\n${'甲'.repeat(70)}\n${'乙'.repeat(70)}`;
    const chunks = splitNoteTextIntoChunks(content, 100);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(`第1章 很长的一章\n${'甲'.repeat(70)}\n`);
    expect(chunks.join('')).toBe(content);
    expect(chunks.every(chunk => chunk.length <= 100)).toBe(true);
  });

  test('keeps the existing size-based fallback when no chapter heading exists', () => {
    const content = `${'甲'.repeat(70)}\n${'乙'.repeat(70)}`;
    const chunks = splitNoteTextIntoChunks(content, 100);

    expect(chunks).toEqual([`${'甲'.repeat(70)}\n`, '乙'.repeat(70)]);
  });
});
