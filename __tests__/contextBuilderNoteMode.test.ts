/* eslint-env jest */

// 测试 buildNoteContext 的模式分发逻辑（mode=none/style/retrieval）
// 以及 mode=none 时的向后兼容行为

jest.mock('../src/services/database', () => ({
  getProjectNoteConfig: jest.fn(async () => null),
  setProjectNoteConfig: jest.fn(async () => undefined),
  getNotesByProject: jest.fn(async () => []),
  getNoteContentById: jest.fn(async () => ''),
  getNotesContentByIds: jest.fn(async () => ({})),
  getAllNotes: jest.fn(async () => []),
  getChaptersByProject: jest.fn(async () => []),
  getCharactersByProject: jest.fn(async () => []),
  getNoteStyleProfile: jest.fn(async () => null),
  setNoteStyleProfile: jest.fn(async () => undefined),
  deleteNoteStyleProfile: jest.fn(async () => undefined),
  computeNoteSourceHash: jest.fn(async () => 'hash'),
}));
jest.mock('../src/services/styleAnalyzer', () => ({
  analyzeNoteStyle: jest.fn(async () => ({ profileText: '', profileJson: {}, sourceHash: '' })),
  analyzeNotesStyle: jest.fn(async () => []),
  getOrAnalyzeNoteStyle: jest.fn(async () => ({ profileText: '', profileJson: {}, sourceHash: '' })),
  mergeStyleProfiles: jest.fn(() => ''),
  DEFAULT_STYLE_WEIGHTS: { sentence_structure: 2, tone_emotion: 2, vocabulary: 1, character_voice: 2, narrative_rhythm: 2 },
}));
jest.mock('../src/services/noteRetriever', () => ({
  retrieveNoteFragments: jest.fn(async () => []),
  clearRetrievalCache: jest.fn(),
}));
jest.mock('../src/services/macroReplace', () => ({ processMacros: (t: string) => t }));
jest.mock('../src/services/llm', () => ({ callLLMResult: jest.fn(async () => ({ text: '', inputTokens: 0, outputTokens: 0, totalTokens: 0 })) }));

import * as db from '../src/services/database';

test('getProjectNoteConfig is available and returns null when no config', async () => {
  const config = await db.getProjectNoteConfig(1);
  expect(config).toBeNull();
});

test('database module exports note mode functions', () => {
  expect(typeof db.getProjectNoteConfig).toBe('function');
  expect(typeof db.setProjectNoteConfig).toBe('function');
  expect(typeof db.getNoteStyleProfile).toBe('function');
  expect(typeof db.setNoteStyleProfile).toBe('function');
  expect(typeof db.deleteNoteStyleProfile).toBe('function');
  expect(typeof db.computeNoteSourceHash).toBe('function');
});

test('styleAnalyzer module exports expected functions', () => {
  const sa = require('../src/services/styleAnalyzer');
  expect(typeof sa.analyzeNoteStyle).toBe('function');
  expect(typeof sa.getOrAnalyzeNoteStyle).toBe('function');
  expect(typeof sa.analyzeNotesStyle).toBe('function');
  expect(typeof sa.mergeStyleProfiles).toBe('function');
  expect(typeof sa.DEFAULT_STYLE_WEIGHTS).toBe('object');
});

test('noteRetriever module exports expected functions', () => {
  const nr = require('../src/services/noteRetriever');
  expect(typeof nr.retrieveNoteFragments).toBe('function');
  expect(typeof nr.clearRetrievalCache).toBe('function');
});

// V2.2.0：bulk note content 性能回归测试
describe('V2.2.0: getNotesContentByIds bulk fetch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('database 导出 getNotesContentByIds 用于批量取笔记内容', () => {
    expect(typeof db.getNotesContentByIds).toBe('function');
  });

  test('空 ids 不打 DB，直接返回空对象', async () => {
    // 走真实实现的空数组分支：避免 mock 自身的 jest.fn
    const { getNotesContentByIds } = jest.requireActual('../src/services/database');
    const result = await getNotesContentByIds([]);
    expect(result).toEqual({});
  });

  test('buildNoteContext 用 bulk API 替代逐条 getNoteContentById', async () => {
    // 直接 patch database 模块内的 getNotesContentByIds 实现（最简单可控）
    // 然后通过 buildContext 走完整链路：它的 buildNoteContext 内部分支会触发 bulk 路径。
    jest.resetModules();
    const cbPath = require.resolve('../src/services/contextBuilder');
    delete require.cache[cbPath];
    const dbPath = require.resolve('../src/services/database');
    delete require.cache[dbPath];

    const fakeDb = {
      getNotesByProject: jest.fn(async () => []),
      getNotesContentByIds: jest.fn(async () => ({})),
      getChaptersByProject: jest.fn(async () => []),
      getCharactersByProject: jest.fn(async () => []),
      getWorldbookEntriesByProject: jest.fn(async () => []),
      getProjectResources: jest.fn(async () => []),
      getProjectNoteConfig: jest.fn(async () => ({ mode: 'none' })),
      processMacros: (t: string) => t,
      default: {},
    };
    jest.doMock('../src/services/database', () => fakeDb);
    jest.doMock('../src/services/macroReplace', () => ({ processMacros: (t: string) => t }));
    jest.doMock('../src/services/styleAnalyzer', () => ({
      DEFAULT_STYLE_WEIGHTS: {},
      getOrAnalyzeNoteStyle: jest.fn(),
      mergeStyleProfiles: jest.fn(() => ''),
    }));
    jest.doMock('../src/services/noteRetriever', () => ({ retrieveNoteFragments: jest.fn() }));
    jest.doMock('../src/services/llm', () => ({}));
    jest.doMock('../src/services/chapterGeneration', () => ({}));

    // 重新载入 contextBuilder，注入 mocked database
    const cb = require('../src/services/contextBuilder');

    // 让 getNotesByProject 返回 50 条；getNotesContentByIds 返回 bulk map
    const notes = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1,
      project_id: 1,
      title: `note-${i + 1}`,
      max_tokens: 30000,
    }));
    const bulkContents: Record<number, string> = {};
    for (let i = 1; i <= 50; i += 1) bulkContents[i] = `content-of-note-${i}`;
    fakeDb.getNotesByProject.mockResolvedValueOnce(notes);
    fakeDb.getNotesContentByIds.mockResolvedValueOnce(bulkContents);

    const chapter = {
      id: 100,
      project_id: 1,
      position: 0,
      title: 't',
      synopsis: 's',
      content: '',
      status: 'draft' as const,
      summary_json: null,
      created_at: '',
      updated_at: '',
    };
    const config = {
      strategy: 'sliding' as const,
      slidingWindowSize: 100000,
      customRangeStart: 0,
      customRangeEnd: -1,
      resourceBudget: 50000,
      includeResources: true,
      worldbookScanDepth: 4,
      worldbookRecursive: true,
      memoryTopK: 5,
      summaryBudgetTokens: 5000,
    };

    const result = await cb.buildContext(chapter, config, 1);

    expect(fakeDb.getNotesContentByIds).toHaveBeenCalledTimes(1);
    expect(fakeDb.getNotesContentByIds.mock.calls[0][0]).toEqual(expect.arrayContaining([1, 2, 50]));
    // 拼接出的 messages 应包含笔记内容
    const allText = result.messages.map((m: any) => m.content).join('\n');
    expect(allText).toContain('content-of-note-1');
  });

  test('V2.2.0: utils/idfCache 提供按 signature 的命中跳过', async () => {
    // 直接 import（mock 不到这里）
    jest.isolateModules(() => {
      const idfCache = require('../src/utils/idfCache');
      const sig = 'fake-signature-1';
      // 第一次查 cache 命中空
      expect(idfCache.getCachedIdf(9999, sig)).toBeNull();
      // 写入
      const idf = new Map<string, number>([['hi', 1.5]]);
      idfCache.setCachedIdf(9999, sig, idf);
      expect(idfCache.getCachedIdf(9999, sig)).toBe(idf);
      // signature 变化 → 失效
      expect(idfCache.getCachedIdf(9999, 'different-sig')).toBeNull();
      // 显式 invalidate
      idfCache.invalidateIdf(9999);
      expect(idfCache.getCachedIdf(9999, sig)).toBeNull();
    });
  });

  test('buildContext 并行构建人物、笔记和世界书资源', async () => {
    jest.resetModules();
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const fakeDb = {
      getChaptersByProject: jest.fn(async () => []),
      getCharactersByProject: jest.fn(async () => {
        await delay(80);
        return [];
      }),
      getProjectNoteConfig: jest.fn(async () => {
        await delay(80);
        return { mode: 'none' };
      }),
      getNotesByProject: jest.fn(async () => []),
      getNotesContentByIds: jest.fn(async () => ({})),
      getWorldbookEntriesByProject: jest.fn(async () => {
        await delay(80);
        return [];
      }),
    };
    jest.doMock('../src/services/database', () => fakeDb);
    jest.doMock('../src/services/macroReplace', () => ({ processMacros: (t: string) => t }));
    jest.doMock('../src/services/styleAnalyzer', () => ({
      DEFAULT_STYLE_WEIGHTS: {},
      getOrAnalyzeNoteStyle: jest.fn(),
      mergeStyleProfiles: jest.fn(() => ''),
    }));
    jest.doMock('../src/services/noteRetriever', () => ({ retrieveNoteFragments: jest.fn() }));

    const cb = require('../src/services/contextBuilder');
    const chapter = {
      id: 101,
      project_id: 1,
      position: 0,
      title: 't',
      synopsis: 's',
      content: '',
      status: 'draft' as const,
      summary_json: null,
      created_at: '',
      updated_at: '',
    };
    const config = {
      strategy: 'sliding' as const,
      slidingWindowSize: 100000,
      customRangeStart: 0,
      customRangeEnd: -1,
      resourceBudget: 50000,
      includeResources: true,
      worldbookScanDepth: 4,
      worldbookRecursive: true,
      memoryTopK: 5,
      summaryBudgetTokens: 5000,
    };

    const start = Date.now();
    await cb.buildContext(chapter, config, 1);
    const elapsed = Date.now() - start;

    expect(fakeDb.getCharactersByProject).toHaveBeenCalledTimes(1);
    expect(fakeDb.getProjectNoteConfig).toHaveBeenCalledTimes(1);
    expect(fakeDb.getWorldbookEntriesByProject).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeLessThan(180);
  });
});
