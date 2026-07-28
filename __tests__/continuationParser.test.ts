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
  createStreamingChapterParser,
} from '../src/services/continuation/continuationParser';
import { sha256Hex } from '../src/services/continuation/hashUtils';

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

/**
 * Feed a normalized text into the streaming parser one line at a time and
 * compare every chapter field against the one-shot result. Returns the
 * streaming result so individual tests can assert on it.
 */
function streamParseAndCompare(text: string) {
  const oneShot = parseSourceChapters(text);
  const sp = createStreamingChapterParser();
  const streamedChapters: any[] = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    streamedChapters.push(...sp.pushLine(line, offset));
    offset += line.length + 1; // +1 for the '\n'
  }
  const totalCharCount = text.length;
  // For the fallback case the streaming parser needs the whole-text hash and
  // paragraph count; compute them the same way the one-shot fallback does.
  const fallbackSha256 = sha256Hex(text);
  const fallbackParagraphCount = text
    .split(/\n+/)
    .map(p => p.trim())
    .filter(p => p.length > 0).length;
  const finalResult = sp.finalize({
    fallbackSha256,
    fallbackParagraphCount,
    totalCharCount,
  });
  return { oneShot, streamedChapters, finalResult };
}

describe('streaming chapter parser equivalence (Spec §11 streaming)', () => {
  const expectChaptersEqual = (
    streamed: any[],
    finalResult: any,
    oneShot: any,
  ) => {
    // finalResult.chapters holds the chapters closed during finalize (the last
    // chapter, or the fallback). Combine with the incrementally-streamed ones.
    const all = [...streamed, ...finalResult.chapters];
    expect(all.length).toBe(oneShot.chapters.length);
    for (let i = 0; i < all.length; i += 1) {
      const s = all[i];
      const o = oneShot.chapters[i];
      expect(s.position).toBe(o.position);
      expect(s.volumeTitle).toBe(o.volumeTitle);
      expect(s.detectedTitle).toBe(o.detectedTitle);
      expect(s.title).toBe(o.title);
      expect(s.sourceStartOffset).toBe(o.sourceStartOffset);
      expect(s.contentStartOffset).toBe(o.contentStartOffset);
      expect(s.sourceEndOffset).toBe(o.sourceEndOffset);
      expect(s.charCount).toBe(o.charCount);
      expect(s.paragraphCount).toBe(o.paragraphCount);
      expect(s.contentSha256).toBe(o.contentSha256);
    }
    expect(finalResult.fallbackUsed).toBe(oneShot.fallbackUsed);
  };

  it('matches one-shot for multi-chapter CJK text', () => {
    const text = '序言\n这是开篇。\n第一章 起点\n正文一\n第二章 风起\n正文二\n第二段。';
    const { oneShot, streamedChapters, finalResult } = streamParseAndCompare(text);
    expectChaptersEqual(streamedChapters, finalResult, oneShot);
  });

  it('matches one-shot for text with volume markers', () => {
    const text = '第一卷 春\n第一章 开端\n正文\n第二章 发展\n正文\n第二卷 秋\n第三章 转折\n正文';
    const { oneShot, streamedChapters, finalResult } = streamParseAndCompare(text);
    expectChaptersEqual(streamedChapters, finalResult, oneShot);
    // Volume title should propagate to chapters under it.
    const all = [...streamedChapters, ...finalResult.chapters];
    expect(all[0].volumeTitle).toBe('第一卷 春');
    expect(all[2].volumeTitle).toBe('第二卷 秋');
  });

  it('matches one-shot for English Chapter markers', () => {
    const text = 'Chapter 1 Begin\nBody one\nChapter 2 End\nBody two';
    const { oneShot, streamedChapters, finalResult } = streamParseAndCompare(text);
    expectChaptersEqual(streamedChapters, finalResult, oneShot);
  });

  it('matches one-shot fallback when no headings exist', () => {
    const text = '这是一段没有章节标题的纯正文。\n第二段。\n\n第三段。';
    const { oneShot, streamedChapters, finalResult } = streamParseAndCompare(text);
    expectChaptersEqual(streamedChapters, finalResult, oneShot);
    expect(finalResult.fallbackUsed).toBe(true);
  });

  it('matches one-shot for empty/blank chapters (heading with no body)', () => {
    const text = '第一章\n第二章\n实际内容';
    const { oneShot, streamedChapters, finalResult } = streamParseAndCompare(text);
    expectChaptersEqual(streamedChapters, finalResult, oneShot);
  });

  it('matches one-shot for a 30-chapter fixture', () => {
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) {
      lines.push(`第${numToChinese(i)}章 第${i}回`);
      lines.push(`这是第${i}章的正文，包含若干段落。`);
      lines.push('');
      lines.push(`第二段正文。`);
      lines.push('');
    }
    const text = lines.join('\n');
    const { oneShot, streamedChapters, finalResult } = streamParseAndCompare(text);
    expectChaptersEqual(streamedChapters, finalResult, oneShot);
    expect(oneShot.chapters).toHaveLength(30);
    const all = [...streamedChapters, ...finalResult.chapters];
    expect(all).toHaveLength(30);
    expect(all[29].title).toContain('三十');
  });

  it('emits chapters incrementally as headings arrive', () => {
    // Verify pushLine returns finished chapters immediately (streaming benefit).
    const sp = createStreamingChapterParser();
    expect(sp.pushLine('第一章 起点', 0)).toEqual([]); // opens chapter, emits nothing
    expect(sp.pushLine('正文', 7)).toEqual([]); // body, emits nothing
    const closed = sp.pushLine('第二章 终', 11); // closes ch1, opens ch2
    expect(closed).toHaveLength(1);
    expect(closed[0].title).toBe('第一章 起点');
    const finalChapters = sp.finalize({
      fallbackSha256: 'unused',
      fallbackParagraphCount: 0,
      totalCharCount: 20,
    });
    expect(finalChapters.chapters).toHaveLength(1); // ch2 closed at EOF
    expect(finalChapters.chapters[0].title).toBe('第二章 终');
  });
});
