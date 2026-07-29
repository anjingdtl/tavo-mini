/* eslint-env jest */

import { requireContinuationTextImport } from '../src/native/ContinuationTextImportModule';
import { readTextFileWithAutoEncoding } from '../src/services/textFileReader';

describe('readTextFileWithAutoEncoding', () => {
  const decoder = requireContinuationTextImport();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('uses detected GB18030 encoding and joins decoded chunks', async () => {
    (decoder.detectEncoding as jest.Mock).mockResolvedValue({
      encoding: 'gb18030',
      confidence: 0.6,
      hasBom: false,
      fileSizeBytes: 8,
    });
    (decoder.decodeChunk as jest.Mock)
      .mockResolvedValueOnce({
        text: '第一章\n',
        nextByteOffset: 4,
        decodedChars: 4,
        bytesConsumed: 4,
        atEof: false,
      })
      .mockResolvedValueOnce({
        text: '正文',
        nextByteOffset: 8,
        decodedChars: 2,
        bytesConsumed: 4,
        atEof: true,
      });

    await expect(readTextFileWithAutoEncoding('/tmp/gbk-note.txt')).resolves.toBe(
      '第一章\n正文',
    );
    expect(decoder.decodeChunk).toHaveBeenNthCalledWith(
      1,
      '/tmp/gbk-note.txt',
      'gb18030',
      0,
      192 * 1024,
      null,
    );
    expect(decoder.decodeChunk).toHaveBeenNthCalledWith(
      2,
      '/tmp/gbk-note.txt',
      'gb18030',
      4,
      192 * 1024,
      null,
    );
  });

  test('strips a UTF BOM before saving note content', async () => {
    (decoder.detectEncoding as jest.Mock).mockResolvedValue({
      encoding: 'utf-16le',
      confidence: 1,
      hasBom: true,
      fileSizeBytes: 6,
    });
    (decoder.decodeChunk as jest.Mock).mockResolvedValue({
      text: '\uFEFF你好',
      nextByteOffset: 6,
      decodedChars: 3,
      bytesConsumed: 6,
      atEof: true,
    });

    await expect(readTextFileWithAutoEncoding('/tmp/utf16-note.txt')).resolves.toBe(
      '你好',
    );
  });

  test('rejects a decoder that stops making progress', async () => {
    (decoder.detectEncoding as jest.Mock).mockResolvedValue({
      encoding: 'utf-8',
      confidence: 0.85,
      hasBom: false,
      fileSizeBytes: 10,
    });
    (decoder.decodeChunk as jest.Mock).mockResolvedValue({
      text: '',
      nextByteOffset: 0,
      decodedChars: 0,
      bytesConsumed: 0,
      atEof: false,
    });

    await expect(readTextFileWithAutoEncoding('/tmp/broken.txt')).rejects.toThrow(
      'TXT 解码无进展',
    );
  });
});
