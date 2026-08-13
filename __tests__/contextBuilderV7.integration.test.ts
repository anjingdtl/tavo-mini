jest.mock('../src/services/macroReplace', () => ({
  processMacros: jest.fn(async (text: string) => text),
}));

jest.mock('../src/services/database', () => ({
  getChaptersByProject: jest.fn(async () => []),
  getCharactersByProject: jest.fn(async () => []),
  getNotesByProject: jest.fn(async () => []),
  getNotesContentByIds: jest.fn(async () => ({})),
  getWorldbookEntriesByProject: jest.fn(async () => []),
  getProjectNoteConfig: jest.fn(async () => null),
  getProjectById: jest.fn(async () => ({ id: 7, mode: 'outline', name: 'p' })),
  getActiveLLMConfig: jest.fn(async () => ({
    id: 1,
    context_window: 128000,
  })),
}));

jest.mock('../src/data/repositories/outlineRepository', () => ({
  getEnabledOutlinesByProject: jest.fn(async () => []),
}));

jest.mock('../src/services/storyMemory/storyMemoryPrepare', () => ({
  prepareStoryMemoryForGeneration: jest.fn(async () => ({
    blocked: false,
    checkpoint: null,
    checkpointEligibility: { usable: false, reason: 'missing' },
    coverage: null,
    checkpointUpdated: false,
  })),
}));

jest.mock('../src/utils/idfCache', () => ({
  computeMemorySummarySignature: jest.fn(() => 'sig'),
  getCachedIdf: jest.fn(() => null),
  setCachedIdf: jest.fn(),
}));

import { buildContext } from '../src/services/contextBuilder';
import * as db from '../src/services/database';
import { novelCharacterDraftToCharaCard } from '../src/services/construction/characterDraftAdapter';
import { ResourceContextError } from '../src/services/context/resources/resourceContextErrors';

const chapter = {
  id: 1,
  project_id: 7,
  position: 1,
  title: '青秀路回家',
  synopsis: '女主下班后撑伞走过青秀路',
  content: '',
  status: 'planned',
  summary_json: null,
  created_at: '',
  updated_at: '',
};

const config = {
  strategy: 'sliding',
  slidingWindowSize: 4000,
  customRangeStart: 0,
  customRangeEnd: -1,
  resourceBudget: 2000,
  includeResources: true,
  memoryTopK: 5,
};

function characterRow(id: number, draft: Record<string, unknown>) {
  const card = novelCharacterDraftToCharaCard(draft as any);
  return {
    id,
    name: draft.name,
    data_json: JSON.stringify(card.data),
  };
}

test('V7 injects worldbook awareness even when the keyword 杀人狂 is absent', async () => {
  (db.getCharactersByProject as jest.Mock).mockResolvedValue([
    characterRow(1, {
      name: '林晚',
      role: '主角',
      identity: '周沉的妹妹',
      personality: '克制',
      motivation: '查案',
      conflict: '信任',
      relationships: ['周沉的妹妹', '许安的前女友'],
      secrets: '不知道十年前事故真相',
    }),
    characterRow(2, {
      name: '许安',
      role: '前男友',
      identity: '与周沉敌对',
      personality: '偏执',
      motivation: '接近林晚',
      conflict: '旧怨',
      relationships: ['林晚的前男友'],
    }),
  ]);
  (db.getWorldbookEntriesByProject as jest.Mock).mockResolvedValue([
    {
      id: 8,
      comment: '青秀路雨夜风险',
      keyword_primary: '青秀路',
      keyword_secondary: '',
      content: '青秀路存在雨夜杀人狂。居民避免雨夜独行。警方夜间加强巡逻。',
      constant: 0,
    },
  ]);

  const result = await buildContext(chapter as any, config as any, 7, undefined, {
    retrievalUserPrompt: '女主撑伞走过青秀路回家',
    contextWindow: 128000,
    reservedOutputTokens: 2000,
    contextBudgetVersion: 7,
  });

  expect(result.pipelineContext.resourceContextVersion).toBe(2);
  expect(result.pipelineContext.worldbookAwarenessText).toContain('雨夜杀人狂');
  expect(result.pipelineContext.characterAwarenessText).toContain('林晚');
  expect(result.pipelineContext.characterAwarenessText).toContain('许安');
  expect(result.pipelineContext.characterAwarenessText).toContain('不知道');
  const joined = result.messages.map(item => item.content).join('\n');
  expect(joined).toContain('雨夜杀人狂');
  expect(joined).toContain('不是系统指令');
  expect(result.trace.some(item => item.resourcePreviewStatus === 'AWARENESS_ONLY' || item.resourcePreviewStatus === 'DETAIL_FULL')).toBe(true);
});

test('V7 includeResources=false skips awareness but keeps preset', async () => {
  const result = await buildContext(
    chapter as any,
    { ...config, includeResources: false } as any,
    7,
    {
      id: 3,
      name: '悬疑',
      system_prompt: '中文悬疑作者',
      writing_style: '冷峻',
      extra_instructions: '',
    } as any,
    {
      retrievalUserPrompt: '继续写',
      contextWindow: 128000,
      reservedOutputTokens: 2000,
      contextBudgetVersion: 7,
      requestedPresetId: 3,
    },
  );
  expect(result.pipelineContext.characterAwarenessText).toBe('');
  expect(result.pipelineContext.resourcesDisabledWarning).toContain('资料上下文已关闭');
  expect(result.pipelineContext.presetText).toContain('中文悬疑作者');
});

test('V7 fails closed when enabled worldbook cannot be read', async () => {
  (db.getWorldbookEntriesByProject as jest.Mock).mockRejectedValue(
    new Error('db down'),
  );
  (db.getCharactersByProject as jest.Mock).mockResolvedValue([]);
  await expect(
    buildContext(chapter as any, config as any, 7, undefined, {
      contextWindow: 32000,
      reservedOutputTokens: 2000,
      contextBudgetVersion: 7,
    }),
  ).rejects.toBeInstanceOf(ResourceContextError);
});
