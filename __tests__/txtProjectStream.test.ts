/* eslint-env jest */
/**
 * Red Test：项目 TXT 流式导入解析（projectTxtImport.parseTxtProjectStreaming）。
 *
 * B0：项目 TXT 导入必须以共享 Streaming 能力为主路径；流式解析的成品与
 * 一次性 splitTxtChapters 完全一致（标准/宽松/整篇回退三档、开篇、标题、
 * 正文），并额外产出字数统计、智能分章候选、fallback 保留的归一化文本。
 */
import { requireContinuationTextImport } from '../src/native/ContinuationTextImportModule';
import { normalizeSourceText } from '../src/services/continuation/continuationNormalizer';
import { utf8ByteLength } from '../src/services/continuation/hashUtils';

jest.mock('../src/services/llm', () => ({
  callLLM: jest.fn(),
}));

import {
  splitTxtChapters,
  smartSplitTxtChaptersFromNormalized,
  parseTxtProjectStreaming,
  SMART_SPLIT_MAX_CANDIDATES,
} from '../src/services/projectTxtImport';
import { callLLM } from '../src/services/llm';

const mockCallLLM = callLLM as jest.Mock;

function installCharChunkDecoder(path: string, text: string, charsPerChunk: number) {
  const mod = requireContinuationTextImport();
  const mocked = mod.decodeChunk as jest.Mock;
  mocked.mockReset();
  mocked.mockImplementation(async (_p: string, _enc: string, byteOffset: number) => {
    let charIdx = 0;
    let byteAt = 0;
    while (byteAt < byteOffset && charIdx < text.length) {
      byteAt += utf8ByteLength(text[charIdx]);
      charIdx += 1;
    }
    const slice = text.slice(charIdx, charIdx + charsPerChunk);
    if (slice.length === 0) {
      return {
        text: '',
        nextByteOffset: byteOffset,
        decodedChars: 0,
        bytesConsumed: 0,
        atEof: true,
      };
    }
    const bytesLen = utf8ByteLength(slice);
    return {
      text: slice,
      nextByteOffset: byteOffset + bytesLen,
      decodedChars: slice.length,
      bytesConsumed: bytesLen,
      atEof: byteOffset + bytesLen >= utf8ByteLength(text),
    };
  });
  return mocked;
}

async function streamParse(text: string, chunkChars = 3) {
  const path = `/tmp/stream-${Math.random()}.txt`;
  installCharChunkDecoder(path, text, chunkChars);
  return parseTxtProjectStreaming({
    localPath: path,
    encoding: 'utf-8',
    fileSizeBytes: utf8ByteLength(text),
    originalFileName: 'stream.txt',
  });
}

describe('parseTxtProjectStreaming：与一次性 splitTxtChapters 分档一致', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('标准标题切章：正文与一次性解析完全一致（含开篇）', async () => {
    const text = [
      '这是书籍简介。',
      '',
      '第一章 初入江湖',
      '少年出门远行。',
      '',
      '第 2 章 风波再起',
      '风波骤起。',
      '',
      'Chapter 3 Storm',
      'The storm comes.',
    ].join('\n');

    const oneShot = splitTxtChapters(text.replace(/\r/g, '\n'));
    const streamed = await streamParse(text);

    expect(streamed.splitMode).toBe(oneShot.splitMode);
    expect(streamed.warnings).toEqual(oneShot.warnings);
    expect(streamed.chapters).toEqual(oneShot.chapters);
    // fallback 才保留整篇文本
    expect(streamed.normalizedText).toBeNull();
  });

  it('宽松标题兜底：序章/楔子/番外/中文编号短行与一次性一致', async () => {
    const text = ['楔子', '夜色深沉。', '一、初入江湖', '少年出门。', '二、风波再起', '风波骤起。'].join('\n');

    const oneShot = splitTxtChapters(text);
    const streamed = await streamParse(text, 2);

    expect(streamed.splitMode).toBe('loose');
    expect(streamed.splitMode).toBe(oneShot.splitMode);
    expect(streamed.chapters).toEqual(oneShot.chapters);
    // 宽松路径同样不保留整篇文本
    expect(streamed.normalizedText).toBeNull();
  });

  it('无任何标题：整篇单章回退，保留归一化文本与智能分章候选', async () => {
    const text = '第一段内容\n\n第二段内容\n\n第三段内容';

    const oneShot = splitTxtChapters(text);
    const streamed = await streamParse(text);

    expect(streamed.splitMode).toBe('fallback');
    expect(streamed.chapters).toEqual(oneShot.chapters);
    expect(streamed.chapters[0].title).toBe('整篇导入');
    expect(streamed.chapters[0].content).toBe(normalizeSourceText(text).text.trim());
    expect(streamed.normalizedText).toBe(normalizeSourceText(text).text);
    // 无章标题也不允许漏产生候选（供 LLM 分章）
    expect(streamed.smartSplitCandidates.length).toBeGreaterThan(0);
  });

  it('首标题位于文首时不产生空开篇', async () => {
    const text = '第一章 开始\n正文甲。';
    const streamed = await streamParse(text);
    expect(streamed.chapters.map(c => c.title)).toEqual(['第一章 开始']);
  });

  it('字数统计：normalizedCharCount 与一次归一化一致，去空白字数正确', async () => {
    const text = '第一章 甲\n正文甲。  \n\n正文乙。';
    const streamed = await streamParse(text);
    const normalized = normalizeSourceText(text).text;
    expect(streamed.normalizedCharCount).toBe(normalized.length);
    const nonWs = (normalized.match(/\S/g) || []).length;
    expect(streamed.nonWhitespaceCharCount).toBe(nonWs);
  });

  it('空内容抛错（与一次性一致）', async () => {
    await expect(streamParse('   \n  ')).rejects.toThrow('TXT 文件内容为空');
  });

  it('候选行上限 1200：超长文本的候选被截断但仍有值', async () => {
    const lines: string[] = [];
    for (let i = 0; i < SMART_SPLIT_MAX_CANDIDATES + 50; i++) {
      lines.push(`短行${i}是候选`);
    }
    const text = lines.join('\n');
    const streamed = await streamParse(text, 20);
    expect(streamed.smartSplitCandidates.length).toBeLessThanOrEqual(
      SMART_SPLIT_MAX_CANDIDATES,
    );
  });
});

describe('smartSplitTxtChaptersFromNormalized：LLM 智能分章', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('按 LLM 返回的行偏移切章，标题前正文收进开篇（与一次性一致）', async () => {
    const lines = ['起点', '这是开篇内容。', '标题甲', '内容甲。', '标题乙', '内容乙。'];
    const text = lines.join('\n');
    const offsetOf = (i: number) =>
      i === 0 ? 0 : lines.slice(0, i).join('\n').length + 1;

    mockCallLLM.mockResolvedValueOnce(
      JSON.stringify({ starts: [offsetOf(2), offsetOf(4)] }),
    );

    const chapters = await smartSplitTxtChaptersFromNormalized(text);
    expect(chapters.map(c => c.title)).toEqual(['开篇', '标题甲', '标题乙']);
    expect(chapters[0].content).toBe('起点\n这是开篇内容。');
    expect(chapters[2].content).toBe('内容乙。');
    const userPayload = JSON.parse(mockCallLLM.mock.calls[0][0][1].content);
    expect(userPayload.some((c: any) => c.t === '标题甲')).toBe(true);
  });

  it('LLM 返回非法 JSON 时抛错', async () => {
    mockCallLLM.mockResolvedValueOnce('前言不搭后语');
    await expect(smartSplitTxtChaptersFromNormalized('甲\n乙\n丙')).rejects.toThrow(
      '无法解析',
    );
  });

  it('LLM 未返回结果时抛错', async () => {
    mockCallLLM.mockResolvedValueOnce(null);
    await expect(smartSplitTxtChaptersFromNormalized('甲\n乙\n丙')).rejects.toThrow(
      'LLM 未返回结果',
    );
  });

  it('fallback 流式结果 + 智能分章走完整用户链路', async () => {
    const text = ['起点', '开篇内容。', '标题甲', '内容甲。', '标题乙', '内容乙。'].join('\n');
    const streamed = await streamParse(text);
    expect(streamed.splitMode).toBe('fallback');
    expect(streamed.normalizedText).not.toBeNull();

    mockCallLLM.mockResolvedValueOnce(JSON.stringify({ starts: [3, 12] }));
    // starts 不一定命中候选偏移；此处用真实候选偏移
    const starts = [streamed.smartSplitCandidates[1].offset, streamed.smartSplitCandidates[2].offset];
    mockCallLLM.mockReset();
    mockCallLLM.mockResolvedValueOnce(JSON.stringify({ starts }));
    const chapters = await smartSplitTxtChaptersFromNormalized(streamed.normalizedText!);
    expect(chapters.map(c => c.title)).toEqual(['开篇', '标题甲', '标题乙']);
  });
});