/**
 * Chapter parser tests (Spec §11.1, §11.3, §18.1).
 *
 * The parser takes normalized text and produces chapter metadata with
 * UTF-16 offsets into the normalized text. It must:
 *   - detect Chinese numeric + arabic chapter markers (第N章/节/回)
 *   - detect English Chapter/CHAPTER markers
 *   - detect volume markers (卷一/第一卷/卷一) and attach as volume_title
 *   - avoid false positives like "第一章内容如下" in body text
 *   - fall back gracefully for title-less text (one whole chapter)
 */
import {
  PARSER_VERSION,
  parseSourceChapters,
} from '../src/services/continuation/continuationParser';

describe('continuation chapter parser (Spec §11.1)', () => {
  it('detects Chinese numeric chapter markers (第一章, 第十二回)', () => {
    const text = '第一章 起点\n正文一\n第二章 风起\n正文二\n第十二回 终章\n正文三';
    const result = parseSourceChapters(text);
    expect(result.chapters).toHaveLength(3);
    expect(result.chapters[0].title).toBe('第一章 起点');
    expect(result.chapters[1].title).toBe('第二章 风起');
    expect(result.chapters[2].title).toBe('第十二回 终章');
  });

  it('detects arabic and zero-padded chapter numbers (第1章, 第001章)', () => {
    const text = '第1章 开端\nA\n第001章 延续\nB';
    const result = parseSourceChapters(text);
    expect(result.chapters).toHaveLength(2);
    expect(result.chapters[0].title).toBe('第1章 开端');
    expect(result.chapters[1].title).toBe('第001章 延续');
  });

  it('detects English Chapter / CHAPTER markers', () => {
    const text = 'Chapter 1 The Beginning\nbody one\nCHAPTER 2 The End\nbody two';
    const result = parseSourceChapters(text);
    expect(result.chapters).toHaveLength(2);
    expect(result.chapters[0].title).toBe('Chapter 1 The Beginning');
    expect(result.chapters[1].title).toBe('CHAPTER 2 The End');
  });

  it('tolerates the "正文 第一章" prefixed form (Spec §11.1)', () => {
    const text = '正文 第一章 序章\nbody';
    const result = parseSourceChapters(text);
    expect(result.chapters).toHaveLength(1);
    expect(result.chapters[0].title).toBe('正文 第一章 序章');
  });

  it('detects volume markers and attaches them as volumeTitle', () => {
    const text = '第一卷 春\n第一章 初见\n正文\n第二章 再见\n正文';
    const result = parseSourceChapters(text);
    // Volume should not create a bodyless phantom chapter; it attaches to the
    // following chapters as volume_title.
    expect(result.chapters.length).toBeGreaterThanOrEqual(2);
    expect(result.chapters[0].title).toBe('第一章 初见');
    expect(result.chapters[0].volumeTitle).toBe('第一卷 春');
  });

  it('does NOT misidentify "第一章内容如下" in body text as a title', () => {
    // The marker must sit at the start of a line to count as a heading.
    const text = '第一章 标题\n这一段提到第一章内容如下，不应被识别为新章节。\n正文继续';
    const result = parseSourceChapters(text);
    expect(result.chapters).toHaveLength(1);
    expect(result.chapters[0].title).toBe('第一章 标题');
  });

  it('falls back to a single whole-text chapter when no titles are found', () => {
    const text = '这是一段没有章节标题的纯文本，只有正文。';
    const result = parseSourceChapters(text);
    expect(result.chapters).toHaveLength(1);
    expect(result.chapters[0].title).toMatch(/整篇|全文|无标题/);
    expect(result.fallbackUsed).toBe(true);
  });

  it('computes source/content/end offsets as UTF-16 code units into the text', () => {
    // Use a single emoji to verify surrogate-pair offset accounting.
    const text = '第一章 😀标题\n正文';
    const result = parseSourceChapters(text);
    expect(result.chapters).toHaveLength(1);
    const ch = result.chapters[0];
    expect(ch.sourceStartOffset).toBe(0);
    expect(ch.sourceEndOffset).toBe(text.length);
    // content_start_offset is past the title line (index of '\n' + 1).
    expect(ch.contentStartOffset).toBeGreaterThan(ch.sourceStartOffset);
    expect(ch.contentStartOffset).toBeLessThanOrEqual(ch.sourceEndOffset);
  });

  it('reports paragraph and char counts per chapter', () => {
    const text = '第一章 测试\n段一\n\n段二\n\n段三';
    const result = parseSourceChapters(text);
    const ch = result.chapters[0];
    expect(ch.paragraphCount).toBe(3); // three non-empty body paragraphs
    expect(ch.charCount).toBeGreaterThan(0);
  });

  it('reports the parser version', () => {
    expect(PARSER_VERSION).toMatch(/^v\d+$/);
    const result = parseSourceChapters('第一章 X\n正文');
    expect(result.parserVersion).toBe(PARSER_VERSION);
  });

  it('handles a 30-chapter Chinese fixture without errors', () => {
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) {
      lines.push(`第${numToChinese(i)}章 第${i}回`);
      lines.push(`这是第${i}章的正文，包含若干段落。`);
      lines.push('');
      lines.push(`第二段正文。`);
      lines.push('');
    }
    const result = parseSourceChapters(lines.join('\n'));
    expect(result.chapters).toHaveLength(30);
    expect(result.chapters[29].title).toContain('三十');
  });
});

function numToChinese(n: number): string {
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (n < 10) return digits[n];
  if (n < 20) return n === 10 ? '十' : '十' + digits[n - 10];
  if (n < 100) {
    const tens = Math.floor(n / 10);
    const ones = n % 10;
    return digits[tens] + '十' + (ones ? digits[ones] : '');
  }
  return String(n);
}
