/* eslint-env jest */

describe('writing context enhancements', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('estimates and clips text by token budget', () => {
    const { estimateTokens, clipTextToTokenBudget, estimateMessagesTokens } = require('../src/utils/tokenEstimator');

    expect(estimateTokens('hello world')).toBeGreaterThanOrEqual(2);
    expect(estimateTokens('雨夜钟楼')).toBeGreaterThanOrEqual(4);
    expect(clipTextToTokenBudget('雨夜钟楼反复响起', 4)).toBe('雨夜钟楼');
    expect(
      estimateMessagesTokens([
        { role: 'system', content: 'system' },
        { role: 'user', content: '雨夜钟楼' },
      ]),
    ).toBeGreaterThan(estimateTokens('雨夜钟楼'));
  });

  test('imports one worldbook file as one collection with child entries', async () => {
    const createWorldbookCollection = jest.fn(async () => 42);
    const createWorldbookEntry = jest.fn(async () => 100);
    jest.doMock('../src/services/database', () => ({
      createWorldbookCollection,
      createWorldbookEntry,
      updateWorldbookCollectionTokenEstimate: jest.fn(async () => undefined),
    }));

    const { importWorldBookFromJSON } = require('../src/services/fileImport');
    const result = await importWorldBookFromJSON(
      7,
      JSON.stringify({
        spec: 'lorebook_v3',
        data: {
          name: 'City Lore',
          entries: [{ keys: ['Clock Tower', 'bell'], content: 'The tower rings only in rain.', enabled: true }],
        },
      }),
    );

    expect(result.name).toBe('City Lore');
    expect(createWorldbookCollection).toHaveBeenCalledWith(7, 'City Lore', expect.objectContaining({ enabled: 1 }));
    expect(createWorldbookEntry).toHaveBeenCalledWith(
      7,
      'Clock Tower',
      'The tower rings only in rain.',
      1,
      expect.objectContaining({ collection_id: 42, keyword_secondary: 'bell' }),
    );
  });

  test('formats provider error codes and limits request concurrency', async () => {
    const { formatLLMError, createConcurrencyLimiter } = require('../src/services/llm');

    expect(
      formatLLMError(
        429,
        JSON.stringify({ error: { code: 'rate_limit_exceeded', type: 'rate_limit', message: 'Too many requests' } }),
      ).message,
    ).toContain('429');
    expect(
      formatLLMError(
        429,
        JSON.stringify({ error: { code: 'rate_limit_exceeded', type: 'rate_limit', message: 'Too many requests' } }),
      ).message,
    ).toContain('rate_limit_exceeded');

    const limiter = createConcurrencyLimiter(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        limiter(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          active--;
          return true;
        }),
      ),
    );

    expect(peak).toBeLessThanOrEqual(2);
  });

  test('builds outline context from three recent chapters and relevant memory summaries', async () => {
    jest.doMock('../src/services/database', () => ({
      getCharactersByProject: jest.fn(async () => []),
      getWorldbookEntriesByProject: jest.fn(async () => []),
      getNotesByProject: jest.fn(async () => []),
      getChaptersByProject: jest.fn(async () => [
        {
          id: 1,
          project_id: 7,
          position: 0,
          title: 'Chapter 1',
          synopsis: '',
          content: 'first chapter full text should not be in recent content',
          status: 'final',
          summary_json: null,
          memory_summary: 'Clock Tower secret was discovered in the rain.',
        },
        { id: 2, project_id: 7, position: 1, title: 'Chapter 2', synopsis: '', content: 'recent one', status: 'final', summary_json: null, memory_summary: 'market scene' },
        { id: 3, project_id: 7, position: 2, title: 'Chapter 3', synopsis: '', content: 'recent two', status: 'final', summary_json: null, memory_summary: 'river scene' },
        { id: 4, project_id: 7, position: 3, title: 'Chapter 4', synopsis: '', content: 'recent three', status: 'final', summary_json: null, memory_summary: 'forest scene' },
        { id: 5, project_id: 7, position: 4, title: 'Chapter 5', synopsis: 'return to Clock Tower', content: '', status: 'planned', summary_json: null },
      ]),
    }));
    jest.doMock('../src/services/macroReplace', () => ({ processMacros: jest.fn(async (text: string) => text) }));

    const { buildContext } = require('../src/services/contextBuilder');
    const messages = await buildContext(
      { id: 5, project_id: 7, position: 4, title: 'Chapter 5', synopsis: 'return to Clock Tower', content: '', status: 'planned' },
      {
        includeResources: true,
        resourceBudget: 2000,
        strategy: 'sliding',
        slidingWindowSize: 4000,
        customRangeStart: 0,
        customRangeEnd: -1,
        summaryBudgetTokens: 20000,
        memoryTopK: 2,
        recentChapterCount: 3,
      },
      7,
    );
    const text = messages.map((message: any) => message.content).join('\n');

    expect(text).toContain('recent one');
    expect(text).toContain('recent two');
    expect(text).toContain('recent three');
    expect(text).not.toContain('first chapter full text should not be in recent content');
    expect(text).toContain('Clock Tower secret was discovered');
  });

  test('clips character and worldbook collection context by per-resource token budgets', async () => {
    jest.doMock('../src/services/database', () => ({
      getCharactersByProject: jest.fn(async () => [
        {
          name: 'Budgeted Character',
          max_tokens: 4,
          data_json: JSON.stringify({ data: { description: '雨夜钟楼秘密过长内容', personality: '冷静' } }),
        },
      ]),
      getWorldbookEntriesByProject: jest.fn(async () => [
        {
          collection_id: 9,
          collection_enabled: 1,
          collection_max_tokens: 4,
          enabled: 1,
          max_tokens: 20,
          keyword_primary: '钟楼',
          content: '雨夜钟楼秘密过长内容',
        },
      ]),
      getNotesByProject: jest.fn(async () => []),
      getChaptersByProject: jest.fn(async () => []),
    }));
    jest.doMock('../src/services/macroReplace', () => ({ processMacros: jest.fn(async (text: string) => text) }));

    const { buildContext } = require('../src/services/contextBuilder');
    const messages = await buildContext(
      { id: 1, project_id: 7, position: 0, title: 'Chapter', synopsis: '', content: '', status: 'planned' },
      {
        includeResources: true,
        resourceBudget: 2000,
        strategy: 'sliding',
        slidingWindowSize: 4000,
        customRangeStart: 0,
        customRangeEnd: -1,
      },
      7,
    );
    const text = messages.map((message: any) => message.content).join('\n');

    expect(text).toContain('雨夜');
    expect(text).not.toContain('过长内容');
  });
});
