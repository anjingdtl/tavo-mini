import type { Chapter } from '../src/types/novel';

const chapter: Chapter = {
  id: 1,
  project_id: 7,
  position: 0,
  title: '雨夜钟楼',
  synopsis: '林岚发现密道',
  content: '林岚在雨夜推开钟楼暗门。',
  status: 'final',
  summary_json: null,
  memory_summary: '',
  memory_summary_tokens: 0,
  finalized_at: null,
  created_at: '2026-07-18T00:00:00.000Z',
  updated_at: '2026-07-18T00:00:00.000Z',
};

describe('structured story memory baseline protection', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('keeps the legacy memory summary as an independent chapter event summary', async () => {
    const callLLM = jest.fn(async () => '林岚发现钟楼暗门。');
    const updateChapter = jest.fn(async () => undefined);
    jest.doMock('../src/services/database', () => ({
      getChapterById: jest.fn(async () => chapter),
      updateChapter,
    }));
    jest.doMock('../src/services/llm', () => ({ callLLM }));

    const { generateMemorySummary } = require('../src/services/summaryGenerator');
    await expect(generateMemorySummary(chapter.id, 200)).resolves.toBe(
      '林岚发现钟楼暗门。',
    );

    expect(callLLM).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          content: expect.stringContaining('核心剧情、人物变化和关键事件'),
        }),
      ]),
      500,
      { scenario: 'memory_summary' },
    );
    expect(updateChapter).toHaveBeenCalledWith(
      chapter.id,
      expect.objectContaining({ memory_summary: '林岚发现钟楼暗门。' }),
    );
  });

  it('keeps system, resources, episodic memory, recent content, and instruction order', async () => {
    jest.doMock('../src/services/database', () => ({
      getChaptersByProject: jest.fn(async () => [
        { ...chapter, memory_summary: '钟楼暗门事件' },
        { ...chapter, id: 2, position: 1, title: '第二章', content: '' },
      ]),
      getProjectStoryMemory: jest.fn(async () => null),
      getCharactersByProject: jest.fn(async () => [
        {
          id: 10,
          name: '林岚',
          max_tokens: 100,
          data_json: JSON.stringify({ data: { description: '钟楼守夜人' } }),
        },
      ]),
      getWorldbookEntriesByProject: jest.fn(async () => []),
      getNotesByProject: jest.fn(async () => []),
    }));
    jest.doMock('../src/services/macroReplace', () => ({
      processMacros: jest.fn(async (text: string) => text),
    }));

    const { buildContext } = require('../src/services/contextBuilder');
    const result = await buildContext(
      { ...chapter, id: 2, position: 1, title: '第二章', content: '' },
      {
        includeResources: true,
        resourceBudget: 1000,
        strategy: 'sliding',
        slidingWindowSize: 1000,
        customRangeStart: 0,
        customRangeEnd: -1,
        summaryBudgetTokens: 1000,
      },
      7,
    );

    const contents = result.messages.map(
      (message: { content: string }) => message.content,
    );
    // Checkpoint architecture: system → resources → (optional episodic) →
    // pending bridge/seam → instruction. Raw bridge chapters are excluded
    // from episodic Top-K to avoid duplicate injection.
    expect(contents[0]).toEqual(expect.stringContaining('经验丰富'));
    const resourceIndex = contents.findIndex((text: string) =>
      text.includes('设定资料'),
    );
    const bridgeIndex = contents.findIndex(
      (text: string) =>
        text.includes('近期正文') ||
        text.includes('最近前文') ||
        text.includes('桥接'),
    );
    const instructionIndex = contents.findIndex((text: string) =>
      text.includes('当前章节'),
    );
    expect(resourceIndex).toBeGreaterThan(0);
    expect(bridgeIndex).toBeGreaterThan(resourceIndex);
    expect(instructionIndex).toBeGreaterThan(bridgeIndex);
    expect(contents[bridgeIndex]).toContain('林岚在雨夜推开钟楼暗门');
  });

  it('invalidates an IDF signature when a summary changes without changing length', () => {
    const { computeMemorySummarySignature } = require('../src/utils/idfCache');
    const before = [{ ...chapter, memory_summary: '甲乙丙丁' }];
    const after = [{ ...chapter, memory_summary: '甲乙丙戊' }];
    expect(computeMemorySummarySignature(before)).not.toBe(
      computeMemorySummarySignature(after),
    );
  });
});
