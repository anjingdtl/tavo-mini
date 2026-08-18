/* eslint-env jest */
/**
 * TXT 小说导入为项目：切章规则、宽松标题兜底、整篇回退、LLM 智能分章、
 * 预览构建、项目写入与失败回滚。
 */
import RNFS from 'react-native-fs';

jest.mock('../src/services/database', () => ({
  createProject: jest.fn(async () => 77),
  createChaptersBulk: jest.fn(async () => 3),
  deleteProject: jest.fn(async () => undefined),
}));

jest.mock('../src/services/fileImport', () => ({
  pickSourceFile: jest.fn(),
}));

jest.mock('../src/services/textFileReader', () => ({
  readTextFileWithAutoEncodingResult: jest.fn(),
}));

jest.mock('../src/services/llm', () => ({
  callLLM: jest.fn(),
}));

import {
  splitTxtChapters,
  buildTxtPreview,
  smartSplitTxtChaptersWithLLM,
  pickAndPreviewTxtProject,
  importTxtProject,
  MAX_TXT_IMPORT_BYTES,
  type TxtImportPackage,
} from '../src/services/projectTxtImport';
import { callLLM } from '../src/services/llm';
import { readTextFileWithAutoEncodingResult } from '../src/services/textFileReader';
import { pickSourceFile } from '../src/services/fileImport';
import * as db from '../src/services/database';

const mockCallLLM = callLLM as jest.Mock;
const mockReader = readTextFileWithAutoEncodingResult as jest.Mock;
const mockPick = pickSourceFile as jest.Mock;
const mockCreateProject = db.createProject as jest.Mock;
const mockCreateChaptersBulk = db.createChaptersBulk as jest.Mock;
const mockDeleteProject = db.deleteProject as jest.Mock;

describe('splitTxtChapters', () => {
  it('标准标题切章：中文数字/阿拉伯数字/Chapter N，标题前正文收进开篇', () => {
    const text = [
      '这是书籍简介。',          // preamble → 开篇
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

    const result = splitTxtChapters(text);
    expect(result.splitMode).toBe('standard');
    expect(result.chapters.map(c => c.title)).toEqual([
      '开篇',
      '第一章 初入江湖',
      '第 2 章 风波再起',
      'Chapter 3 Storm',
    ]);
    expect(result.chapters[0].content).toBe('这是书籍简介。');
    expect(result.chapters[1].content).toBe('少年出门远行。');
    expect(result.chapters[3].content).toBe('The storm comes.');
  });

  it('标准切章不产生开篇空章：首个标题位于文首', () => {
    const text = '第一章 开始\n正文甲。';
    const result = splitTxtChapters(text);
    expect(result.chapters.map(c => c.title)).toEqual(['第一章 开始']);
  });

  it('宽松标题兜底：序章/楔子/番外/中文编号短行切分', () => {
    const text = [
      '楔子',
      '夜色深沉。',
      '一、初入江湖',
      '少年出门。',
      '二、风波再起',
      '风波骤起。',
    ].join('\n');

    const result = splitTxtChapters(text);
    expect(result.splitMode).toBe('loose');
    expect(result.chapters.map(c => c.title)).toEqual([
      '楔子',
      '一、初入江湖',
      '二、风波再起',
    ]);
    expect(result.chapters[1].content).toBe('少年出门。');
  });

  it('无任何标题：整篇单章回退，预览标记需要智能分章', () => {
    const text = '第一段内容。\n\n第二段内容。\n\n第三段内容。';
    const result = splitTxtChapters(text);
    expect(result.splitMode).toBe('fallback');
    expect(result.chapters).toHaveLength(1);
    expect(result.chapters[0].title).toBe('整篇导入');

    const pkg: TxtImportPackage = {
      name: 'x',
      encoding: 'utf-8',
      splitMode: result.splitMode,
      chapters: result.chapters,
      warnings: result.warnings,
    };
    const preview = buildTxtPreview(pkg);
    expect(preview.needsSmartSplit).toBe(true);
    expect(preview.chapterCount).toBe(1);
  });

  it('空内容直接抛错', () => {
    expect(() => splitTxtChapters('   \n  ')).toThrow('TXT 文件内容为空');
  });
});

describe('smartSplitTxtChaptersWithLLM', () => {
  it('按 LLM 返回的行偏移切章，标题前正文收进开篇', async () => {
    const lines = ['起点', '这是开篇内容。', '标题甲', '内容甲。', '标题乙', '内容乙。'];
    const text = lines.join('\n');
    const offsetOf = (i: number) =>
      i === 0 ? 0 : lines.slice(0, i).join('\n').length + 1;

    mockCallLLM.mockResolvedValueOnce(
      JSON.stringify({ starts: [offsetOf(2), offsetOf(4)] }),
    );

    const chapters = await smartSplitTxtChaptersWithLLM(text);
    expect(chapters.map(c => c.title)).toEqual(['开篇', '标题甲', '标题乙']);
    expect(chapters[0].content).toBe('起点\n这是开篇内容。');
    expect(chapters[2].content).toBe('内容乙。');
    // 候选行以 {i,t} 形式发给 LLM
    const userPayload = JSON.parse(mockCallLLM.mock.calls[0][0][1].content);
    expect(userPayload.some((c: any) => c.t === '标题甲')).toBe(true);
  });

  it('LLM 返回非法 JSON 时抛错', async () => {
    mockCallLLM.mockResolvedValueOnce('前言不搭后语');
    await expect(smartSplitTxtChaptersWithLLM('甲\n乙\n丙')).rejects.toThrow(
      '无法解析',
    );
  });

  it('LLM 未配置/无结果时抛错', async () => {
    mockCallLLM.mockResolvedValueOnce(null);
    await expect(smartSplitTxtChaptersWithLLM('甲\n乙\n丙')).rejects.toThrow(
      'LLM 未返回结果',
    );
  });
});

describe('pickAndPreviewTxtProject', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (RNFS.stat as jest.Mock).mockReset();
  });

  it('完整流程：选文件 → 读取 → 预览', async () => {
    mockPick.mockResolvedValueOnce({ localPath: '/tmp/novel.txt', name: 'novel.txt' });
    (RNFS.stat as jest.Mock).mockResolvedValueOnce({ size: 5000 });
    mockReader.mockResolvedValueOnce({ text: '第一章 甲\n内容甲。', encoding: 'GB18030' });

    const result = await pickAndPreviewTxtProject();
    expect(result).not.toBeNull();
    expect(result!.preview.name).toBe('novel');
    expect(result!.preview.encoding).toBe('GB18030');
    expect(result!.preview.chapterCount).toBe(1);
    expect(result!.preview.needsSmartSplit).toBe(false);
    expect(result!.pkg.chapters[0].title).toBe('第一章 甲');
  });

  it('非 .txt 扩展名抛错', async () => {
    mockPick.mockResolvedValueOnce({ localPath: '/tmp/a.json', name: 'a.json' });
    await expect(pickAndPreviewTxtProject()).rejects.toThrow('.txt');
  });

  it('超过 20MB 上限抛错', async () => {
    mockPick.mockResolvedValueOnce({ localPath: '/tmp/big.txt', name: 'big.txt' });
    (RNFS.stat as jest.Mock).mockResolvedValueOnce({ size: MAX_TXT_IMPORT_BYTES + 1 });
    await expect(pickAndPreviewTxtProject()).rejects.toThrow('20MB');
  });

  it('用户取消选择返回 null', async () => {
    mockPick.mockResolvedValueOnce(null);
    await expect(pickAndPreviewTxtProject()).resolves.toBeNull();
  });
});

describe('importTxtProject', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateProject.mockResolvedValue(77);
    mockCreateChaptersBulk.mockResolvedValue(2);
  });

  it('创建 outline 项目并批量写入章节', async () => {
    const pkg: TxtImportPackage = {
      name: 'novel',
      encoding: 'utf-8',
      splitMode: 'standard',
      chapters: [
        { title: '第一章 甲', content: '内容甲。' },
        { title: '第二章 乙', content: '内容乙。' },
      ],
      warnings: [],
    };

    const projectId = await importTxtProject(pkg);
    expect(projectId).toBe(77);
    expect(mockCreateProject).toHaveBeenCalledWith('novel', 'outline');
    expect(mockCreateChaptersBulk).toHaveBeenCalledWith(
      77,
      [
        { position: 0, title: '第一章 甲', content: '内容甲。', status: 'draft' },
        { position: 1, title: '第二章 乙', content: '内容乙。', status: 'draft' },
      ],
    );
    expect(mockDeleteProject).not.toHaveBeenCalled();
  });

  it('写入失败时回滚删除半成品项目', async () => {
    mockCreateChaptersBulk.mockRejectedValueOnce(new Error('disk full'));
    const pkg: TxtImportPackage = {
      name: 'novel',
      encoding: 'utf-8',
      splitMode: 'fallback',
      chapters: [{ title: '整篇导入', content: 'x' }],
      warnings: [],
    };
    await expect(importTxtProject(pkg)).rejects.toThrow('disk full');
    expect(mockDeleteProject).toHaveBeenCalledWith(77);
  });
});
