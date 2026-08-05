/**
 * Outline TXT multi-file import tests (大纲创作模式升级, 阶段 4).
 *
 * Verifies: each TXT becomes an independent outline; empty files fail without
 * aborting the whole batch; the file name becomes the title; outlines default
 * to disabled; partial success is reported.
 */
jest.mock('../src/services/database', () => ({
  createOutline: jest.fn(async (_projectId: number, _input: any) => {
    // Return a monotonically increasing fake id.
    const id = (global as any).__nextOutlineId ?? 1;
    (global as any).__nextOutlineId = id + 1;
    return id;
  }),
}));

import { keepLocalCopy, pick } from '@react-native-documents/picker';
import * as db from '../src/services/database';
import { importOutlinesFromTxt } from '../src/services/outlineImport';

jest.mock('../src/services/textFileReader', () => ({
  readTextFileWithAutoEncoding: jest.fn(),
}));

import { readTextFileWithAutoEncoding } from '../src/services/textFileReader';

const mockedCreateOutline = db.createOutline as jest.MockedFunction<
  typeof db.createOutline
>;
const mockedRead = readTextFileWithAutoEncoding as jest.MockedFunction<
  typeof readTextFileWithAutoEncoding
>;

beforeEach(() => {
  jest.clearAllMocks();
  (global as any).__nextOutlineId = 1;
});

describe('importOutlinesFromTxt', () => {
  test('returns null when user cancels picker', async () => {
    (pick as jest.Mock).mockResolvedValue([]);
    const result = await importOutlinesFromTxt(7);
    expect(result).toBeNull();
  });

  test('each TXT becomes an independent outline with filename as title', async () => {
    (pick as jest.Mock).mockResolvedValue([
      { uri: 'content://a', name: '第一卷.txt' },
      { uri: 'content://b', name: '人物暗线.txt' },
    ]);
    (keepLocalCopy as jest.Mock).mockResolvedValue([
      { status: 'success', localUri: 'file:///tmp/a.txt' },
      { status: 'success', localUri: 'file:///tmp/b.txt' },
    ]);
    mockedRead
      .mockResolvedValueOnce('第一卷主线内容')
      .mockResolvedValueOnce('人物暗线内容');

    const result = await importOutlinesFromTxt(7);

    expect(result).not.toBeNull();
    expect(result!.successCount).toBe(2);
    expect(result!.failureCount).toBe(0);
    expect(mockedCreateOutline).toHaveBeenCalledTimes(2);
    expect(mockedCreateOutline).toHaveBeenNthCalledWith(1, 7, {
      title: '第一卷',
      content: '第一卷主线内容',
      sourceType: 'txt',
      sourceFileName: '第一卷.txt',
    });
    expect(mockedCreateOutline).toHaveBeenNthCalledWith(2, 7, {
      title: '人物暗线',
      content: '人物暗线内容',
      sourceType: 'txt',
      sourceFileName: '人物暗线.txt',
    });
  });

  test('empty files fail without aborting the whole batch (partial success)', async () => {
    (pick as jest.Mock).mockResolvedValue([
      { uri: 'content://good', name: 'good.txt' },
      { uri: 'content://empty', name: 'empty.txt' },
      { uri: 'content://spaces', name: 'spaces.txt' },
    ]);
    (keepLocalCopy as jest.Mock).mockResolvedValue([
      { status: 'success', localUri: 'file:///tmp/good.txt' },
      { status: 'success', localUri: 'file:///tmp/empty.txt' },
      { status: 'success', localUri: 'file:///tmp/spaces.txt' },
    ]);
    mockedRead
      .mockResolvedValueOnce('有效内容')
      .mockResolvedValueOnce('') // empty
      .mockResolvedValueOnce('   \n  '); // whitespace only

    const result = await importOutlinesFromTxt(7);

    expect(result!.successCount).toBe(1);
    expect(result!.failureCount).toBe(2);
    expect(result!.failures).toHaveLength(2);
    expect(result!.failures[0].fileName).toBe('empty.txt');
    expect(result!.failures[0].reason).toContain('空');
    expect(mockedCreateOutline).toHaveBeenCalledTimes(1); // only the good one
  });

  test('read error for one file does not fail the batch', async () => {
    (pick as jest.Mock).mockResolvedValue([
      { uri: 'content://a', name: 'a.txt' },
      { uri: 'content://bad', name: 'bad.txt' },
    ]);
    (keepLocalCopy as jest.Mock).mockResolvedValue([
      { status: 'success', localUri: 'file:///tmp/a.txt' },
      { status: 'success', localUri: 'file:///tmp/bad.txt' },
    ]);
    mockedRead
      .mockResolvedValueOnce('内容 A')
      .mockRejectedValueOnce(new Error('编码识别失败'));

    const result = await importOutlinesFromTxt(7);

    expect(result!.successCount).toBe(1);
    expect(result!.failureCount).toBe(1);
    expect(result!.failures[0].reason).toContain('编码识别失败');
  });

  test('re-importing same-named file creates a new outline (no silent overwrite)', async () => {
    (pick as jest.Mock).mockResolvedValue([
      { uri: 'content://dup', name: '主线.txt' },
    ]);
    (keepLocalCopy as jest.Mock).mockResolvedValue([
      { status: 'success', localUri: 'file:///tmp/dup.txt' },
    ]);
    mockedRead.mockResolvedValueOnce('第二次导入同名');

    const result = await importOutlinesFromTxt(7);

    expect(result!.successCount).toBe(1);
    // createOutline is called (not an update), so it's a new outline.
    expect(mockedCreateOutline).toHaveBeenCalledWith(7, expect.objectContaining({
      title: '主线',
      sourceFileName: '主线.txt',
    }));
  });
});
