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

  test('selects previous chapters according to sliding full and custom strategies', () => {
    const { selectPreviousChapters } = require('../src/services/contextBuilder');
    const chapters = [
      { id: 1, project_id: 7, position: 0, title: 'Chapter 1', synopsis: '', content: 'one', status: 'final', summary_json: null },
      { id: 2, project_id: 7, position: 1, title: 'Chapter 2', synopsis: '', content: 'two', status: 'final', summary_json: null },
      { id: 3, project_id: 7, position: 2, title: 'Chapter 3', synopsis: '', content: 'three', status: 'draft', summary_json: null },
      { id: 4, project_id: 7, position: 3, title: 'Chapter 4', synopsis: '', content: '', status: 'planned', summary_json: null },
    ];
    const current = chapters[3];

    expect(selectPreviousChapters(current, { strategy: 'sliding', recentChapterCount: 2 }, chapters).map((chapter: any) => chapter.title)).toEqual(['Chapter 2', 'Chapter 3']);
    expect(selectPreviousChapters(current, { strategy: 'full' }, chapters).map((chapter: any) => chapter.title)).toEqual(['Chapter 1', 'Chapter 2', 'Chapter 3']);
    expect(selectPreviousChapters(current, { strategy: 'custom', customRangeStart: 1, customRangeEnd: 2 }, chapters).map((chapter: any) => chapter.title)).toEqual(['Chapter 2', 'Chapter 3']);
  });

  test('clips previous content from the end to preserve the latest chapter ending', () => {
    const { buildPreviousContentText } = require('../src/services/contextBuilder');
    const current = { id: 3, project_id: 7, position: 2, title: 'Chapter 3', synopsis: '', content: '', status: 'planned', summary_json: null };
    const chapters = [
      { id: 1, project_id: 7, position: 0, title: 'Chapter 1', synopsis: '', content: 'older opening should disappear', status: 'final', summary_json: null },
      { id: 2, project_id: 7, position: 1, title: 'Chapter 2', synopsis: '', content: '雨夜钟楼最后响起', status: 'final', summary_json: null },
    ];

    const text = buildPreviousContentText(current, { strategy: 'full', slidingWindowSize: 8 }, chapters);

    expect(text).toContain('钟楼最后响起');
    expect(text).not.toContain('older opening');
  });

  test('activates worldbook entries by keywords constants secondary keys and one recursion pass', async () => {
    jest.doMock('../src/services/database', () => ({
      getWorldbookEntriesByProject: jest.fn(async () => [
        {
          id: 1,
          collection_id: 1,
          collection_enabled: 1,
          collection_max_tokens: 200,
          enabled: 1,
          max_tokens: 80,
          keyword_primary: '钟楼',
          keyword_secondary: '',
          content: '钟楼下藏着银钥匙。',
          position: 10,
          constant: 0,
        },
        {
          id: 2,
          collection_id: 1,
          collection_enabled: 1,
          collection_max_tokens: 200,
          enabled: 1,
          max_tokens: 80,
          keyword_primary: '银钥匙',
          keyword_secondary: '',
          content: '银钥匙能打开地下档案室。',
          position: 20,
          constant: 0,
        },
        {
          id: 3,
          collection_id: 1,
          collection_enabled: 1,
          collection_max_tokens: 200,
          enabled: 1,
          max_tokens: 80,
          keyword_primary: '雨夜',
          keyword_secondary: '档案员',
          content: '只有档案员知道雨夜的钟声含义。',
          position: 30,
          constant: 0,
        },
        {
          id: 4,
          collection_id: 1,
          collection_enabled: 1,
          collection_max_tokens: 200,
          enabled: 1,
          max_tokens: 80,
          keyword_primary: '',
          keyword_secondary: '',
          content: '常驻规则：保持悬疑叙事。',
          position: 0,
          constant: 1,
        },
        {
          id: 5,
          collection_id: 1,
          collection_enabled: 1,
          collection_max_tokens: 200,
          enabled: 1,
          max_tokens: 80,
          keyword_primary: '未出现',
          keyword_secondary: '',
          content: '不应注入。',
          position: 40,
          constant: 0,
        },
      ]),
    }));

    const { buildWorldbookContext } = require('../src/services/contextBuilder');
    const text = await buildWorldbookContext(7, 500, '主角回到钟楼。', true);

    expect(text).toContain('常驻规则');
    expect(text).toContain('钟楼下藏着银钥匙');
    expect(text).toContain('银钥匙能打开地下档案室');
    expect(text).not.toContain('只有档案员知道');
    expect(text).not.toContain('不应注入');
  });

  test('builds character context with common SillyTavern card fields', async () => {
    jest.doMock('../src/services/database', () => ({
      getCharactersByProject: jest.fn(async () => [
        {
          name: '林岚',
          max_tokens: 500,
          data_json: JSON.stringify({
            data: {
              description: '钟楼守夜人。',
              personality: '冷静克制。',
              scenario: '她正在调查旧城档案。',
              first_mes: '钟声又响了。',
              mes_example: '<START>\n林岚：别回头。',
              system_prompt: '以第三人称描写林岚。',
              post_history_instructions: '保持悬疑感。',
            },
          }),
        },
      ]),
    }));

    const { buildCharacterContext } = require('../src/services/contextBuilder');
    const text = await buildCharacterContext(7, 2000);

    expect(text).toContain('钟楼守夜人');
    expect(text).toContain('她正在调查旧城档案');
    expect(text).toContain('钟声又响了');
    expect(text).toContain('保持悬疑感');
  });

  test('revision generation replaces current chapter text instead of appending', () => {
    const { createChapterGenerationRequest, mergeChapterGenerationResult } = require('../src/services/chapterGeneration');
    const chapter = {
      id: 1,
      project_id: 7,
      position: 0,
      title: '雨夜',
      synopsis: '修顺节奏',
      content: '旧正文。',
      status: 'revision',
      summary_json: null,
    };

    const request = createChapterGenerationRequest(chapter);
    const merged = mergeChapterGenerationResult(chapter, '新修订正文。');

    expect(request.scenario).toBe('chapter_revision');
    expect(request.userPrompt).toContain('完整修订稿');
    expect(merged).toEqual({ content: '新修订正文。', status: 'revision' });
  });

  test('reserves resource budget for triggered worldbook when character cards are large', async () => {
    jest.doMock('../src/services/database', () => ({
      getCharactersByProject: jest.fn(async () => [
        {
          name: 'Huge Character',
          max_tokens: 5000,
          data_json: JSON.stringify({
            data: {
              description: '\u949f'.repeat(500),
            },
          }),
        },
      ]),
      getWorldbookEntriesByProject: jest.fn(async () => [
        {
          id: 1,
          collection_id: 1,
          collection_enabled: 1,
          collection_max_tokens: 500,
          enabled: 1,
          max_tokens: 100,
          keyword_primary: 'clocktower',
          keyword_secondary: '',
          content: 'WB_KEEP_THIS lore.',
          position: 0,
          constant: 0,
        },
      ]),
      getNotesByProject: jest.fn(async () => []),
      getChaptersByProject: jest.fn(async () => []),
    }));
    jest.doMock('../src/services/macroReplace', () => ({ processMacros: jest.fn(async (text: string) => text) }));

    const { buildContext } = require('../src/services/contextBuilder');
    const messages = await buildContext(
      { id: 1, project_id: 7, position: 0, title: 'Chapter', synopsis: 'return to clocktower', content: '', status: 'planned' },
      {
        includeResources: true,
        resourceBudget: 120,
        strategy: 'sliding',
        slidingWindowSize: 4000,
        customRangeStart: 0,
        customRangeEnd: -1,
      },
      7,
    );
    const text = messages.map((message: any) => message.content).join('\n');

    expect(text).toContain('WB_KEEP_THIS');
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
      { id: 1, project_id: 7, position: 0, title: 'Chapter', synopsis: 'return to 钟楼', content: '', status: 'planned' },
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
