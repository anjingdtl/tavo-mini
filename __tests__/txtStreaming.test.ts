/* eslint-env jest */
/**
 * Red Test：共享流式 TXT 解码管线（src/services/txtStreaming.ts）。
 *
 * B0 要求项目 TXT 与续写 TXT 共用同一套 Streaming Decode / Normalize /
 * Parse 能力，而不是两套独立的大文件解析逻辑。本测试锁定新共享模块：
 *
 *  1. 与一次性 normalizeSourceText 的等价性（跨块 CRLF、BOM、控制字符、
 *     任意分块）——normalizedCharCount / normalizedByteCount / normalizedSha256；
 *  2. 行级回调契约：每个完整行恰好一次 onLine（含行首偏移），超长行走
 *     onLongLineParts，不拼接巨型字符串；
 *  3. 多文件：文件边界不吞行、跨文件行偏移持续累加；
 *  4. 零进展保护：decodeChunk 不前进时必须抛错；
 *  5. 进度回调单调且总额守恒。
 */
import { requireContinuationTextImport } from '../src/native/ContinuationTextImportModule';
import { normalizeSourceText } from '../src/services/continuation/continuationNormalizer';
import { utf8ByteLength } from '../src/services/continuation/hashUtils';
import { streamDecodedText, TXT_STREAM_MAX_JOINED_LINE_CHARS } from '../src/services/txtStreaming';

interface FakeFile {
  path: string;
  text: string;
  charsPerChunk: number;
}

/**
 * 仿真原生 decodeChunk 契约：按「字符数」切片返回 text，字节游标按 UTF-8
 * 字节数前进（等价于原生解码器在块边界不撕裂多字节字符时的行为）。
 * 按 localPath 区分文件。
 */
function installCharChunkDecoder(files: FakeFile[]) {
  const mod = requireContinuationTextImport();
  const mocked = mod.decodeChunk as jest.Mock;
  mocked.mockReset();
  mocked.mockImplementation(async (path: string, _enc: string, byteOffset: number) => {
    const file = files.find(f => f.path === path);
    if (!file) {
      throw new Error(`test decoder: unknown path ${path}`);
    }
    let charIdx = 0;
    let byteAt = 0;
    while (byteAt < byteOffset && charIdx < file.text.length) {
      byteAt += utf8ByteLength(file.text[charIdx]);
      charIdx += 1;
    }
    const slice = file.text.slice(charIdx, charIdx + file.charsPerChunk);
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
      atEof: byteOffset + bytesLen >= utf8ByteLength(file.text),
    };
  });
  return mocked;
}

function makeFileInput(path: string, text: string) {
  return {
    localPath: path,
    encoding: 'utf-8',
    fileSizeBytes: utf8ByteLength(text),
    originalFileName: 'novel.txt',
  };
}

describe('txtStreaming：与一次性归一化等价', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const cases: Array<{ name: string; text: string; chunkChars: number }> = [
    {
      name: '普通多章文本',
      text: '这是书籍简介。\r\n\r\n第一章 初入江湖\r\n少年出门远行。\r\n第二章 风波再起\r\n风波骤起。',
      chunkChars: 7,
    },
    {
      name: 'CRLF 恰好被块边界拆开（\\r 在块尾 \\n 在块首）',
      text: '\uFEFF序章\r\n夜色深沉。\r\n正文甲。\r\n正文乙。',
      chunkChars: 5,
    },
    {
      name: 'BOM + 控制字符',
      text: '\uFEFF\u0000\u0001\x00abc\x7fdef\r\nghi\rjkl',
      chunkChars: 2,
    },
    {
      name: '无换行的整篇',
      text: '一整篇没有换行没有章标题的文本内容。',
      chunkChars: 3,
    },
  ];

  for (const c of cases) {
    it(`${c.name}（chunk=${c.chunkChars}）`, async () => {
      const path = `/tmp/case-${c.chunkChars}.txt`;
      installCharChunkDecoder([{ path, text: c.text, charsPerChunk: c.chunkChars }]);
      const oneShot = normalizeSourceText(c.text);

      const result = await streamDecodedText({
        files: [makeFileInput(path, c.text)],
        callbacks: {},
      });

      expect(result.normalizedCharCount).toBe(oneShot.normalizedCharCount);
      expect(result.normalizedByteCount).toBe(oneShot.normalizedByteCount);
      expect(result.normalizedSha256).toBe(oneShot.normalizedSha256);
      expect(result.removedBom).toBe(oneShot.removedBom);
    });
  }

  it('行回调与一次性解析的行偏移完全一致（含跨块）', async () => {
    const text = '第一章 甲\n正文甲。\n\n第二章 乙\n正文乙。';
    const path = '/tmp/lines.txt';
    installCharChunkDecoder([{ path, text, charsPerChunk: 4 }]);

    const normalized = normalizeSourceText(text).text;
    const expectedOffsets: number[] = [];
    {
      let offset = 0;
      for (const line of normalized.split('\n')) {
        expectedOffsets.push(offset);
        offset += line.length + 1;
      }
    }

    const lines: Array<{ line: string; start: number; len: number }> = [];
    await streamDecodedText({
      files: [makeFileInput(path, text)],
      callbacks: {
        onLine: ({ line, lineStartOffset, lineLength }) => {
          lines.push({ line, start: lineStartOffset, len: lineLength });
        },
      },
    });

    expect(lines).toHaveLength(expectedOffsets.length);
    lines.forEach((l, i) => {
      expect(l.line).toBe(normalized.split('\n')[i]);
      expect(l.start).toBe(expectedOffsets[i]);
      expect(l.len).toBe(l.line.length);
    });
  });

  it('超长行走 onLongLineParts 且不产生 onLine、长度精确', async () => {
    const long = 'x'.repeat(TXT_STREAM_MAX_JOINED_LINE_CHARS + 1024);
    const text = `第一章 甲\n${long}\n第二章 乙\n正文乙。`;
    const path = '/tmp/long.txt';
    installCharChunkDecoder([{ path, text, charsPerChunk: 512 }]);

    const longParts: Array<{ parts: readonly string[]; start: number; len: number }> = [];
    const normalLines: string[] = [];
    await streamDecodedText({
      files: [makeFileInput(path, text)],
      callbacks: {
        onLine: ({ line }) => {
          normalLines.push(line);
        },
        onLongLineParts: ({ parts, lineStartOffset, lineLength }) => {
          longParts.push({ parts, start: lineStartOffset, len: lineLength });
        },
      },
    });

    expect(longParts).toHaveLength(1);
    expect(longParts[0].len).toBe(TXT_STREAM_MAX_JOINED_LINE_CHARS + 1024);
    expect(longParts[0].parts.reduce((s, p) => s + p.length, 0)).toBe(
      TXT_STREAM_MAX_JOINED_LINE_CHARS + 1024,
    );
    expect(normalLines).toEqual(['第一章 甲', '第二章 乙', '正文乙。']);
  });

  it('多文件：文件间不吞行，行首偏移跨文件持续累加', async () => {
    const file1 = '甲\n乙'; // 无结尾换行：乙在文件末尾冲刷为完整行
    const file2 = '丙\n丁\n';
    const path1 = '/tmp/f1.txt';
    const path2 = '/tmp/f2.txt';
    installCharChunkDecoder([
      { path: path1, text: file1, charsPerChunk: 2 },
      { path: path2, text: file2, charsPerChunk: 2 },
    ]);

    const lines: Array<{ line: string; start: number }> = [];
    await streamDecodedText({
      files: [makeFileInput(path1, file1), makeFileInput(path2, file2)],
      callbacks: {
        onLine: ({ line, lineStartOffset }) => {
          lines.push({ line, start: lineStartOffset });
        },
      },
    });

    // 归一化拼接 "甲\n乙" + "丙\n丁\n" = "甲\n乙丙\n丁\n"：甲@0 乙@2 丙@3 丁@5
    expect(lines.map(l => l.line)).toEqual(['甲', '乙', '丙', '丁']);
    expect(lines.map(l => l.start)).toEqual([0, 2, 3, 5]);
  });

  it('零进展（bytesConsumed=0 且非 EOF）抛错', async () => {
    const mod = requireContinuationTextImport();
    (mod.decodeChunk as jest.Mock).mockReset();
    (mod.decodeChunk as jest.Mock).mockResolvedValue({
      text: '',
      nextByteOffset: 0,
      decodedChars: 0,
      bytesConsumed: 0,
      atEof: false,
    });
    await expect(
      streamDecodedText({
        files: [makeFileInput('/tmp/zero.txt', '内容')],
        callbacks: {},
      }),
    ).rejects.toThrow(/无进展/);
  });

  it('onNormalizedChunk 拼接等于一次归一化结果', async () => {
    const text = '第一章 甲\n正文甲。\n第二章 乙\n正文乙。';
    const path = '/tmp/blocks.txt';
    installCharChunkDecoder([{ path, text, charsPerChunk: 5 }]);

    const blocks: string[] = [];
    const result = await streamDecodedText({
      files: [makeFileInput(path, text)],
      callbacks: {
        onNormalizedChunk: ({ block }) => {
          blocks.push(block);
        },
      },
    });

    expect(blocks.join('')).toBe(normalizeSourceText(text).text);
    expect(result.normalizedCharCount).toBe(blocks.join('').length);
  });

  it('进度回调单调且最后到达总字节数', async () => {
    const text = '第一章 甲\n正文甲。\n第二章 乙\n正文乙。';
    const path = '/tmp/progress.txt';
    installCharChunkDecoder([{ path, text, charsPerChunk: 3 }]);

    const progress: number[] = [];
    await streamDecodedText({
      files: [makeFileInput(path, text)],
      callbacks: {
        onProgress: ({ globalProcessedBytes, totalBytes }) => {
          progress.push(globalProcessedBytes);
          expect(globalProcessedBytes).toBeLessThanOrEqual(totalBytes);
        },
      },
    });
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toBe(utf8ByteLength(text));
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1]);
    }
  });
});