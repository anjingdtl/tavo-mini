/**
 * 统一写作核心：buildContext 只保留一条分层弹性预算路径。
 * 有窗口信息（contextWindow + reservedOutputTokens）→ hierarchical 分配器，
 * 无窗口信息 → 配置直通兜底。旧 V2 单层 elastic 分支与 legacy 固定比例分支已移除。
 */
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

const baseChapter = {
  id: 1,
  project_id: 7,
  position: 0,
  title: '第一章',
  synopsis: '开篇',
  content: '',
  status: 'planned',
  summary_json: null,
  created_at: '',
  updated_at: '',
};

const baseConfig = {
  strategy: 'sliding',
  slidingWindowSize: 4000,
  customRangeStart: 0,
  customRangeEnd: -1,
  resourceBudget: 2000,
  includeResources: true,
  storyStateBudgetTokens: 8000,
  episodicMemoryBudgetTokens: 20000,
  summaryBudgetTokens: 8000,
  memoryTopK: 5,
};

const WINDOW = 16_000;
const RESERVED = 2_000;

describe('buildContext unified hierarchical budget (统一写作核心)', () => {
  it('routes every window-carrying call through the hierarchical allocator', async () => {
    const result = await buildContext(
      baseChapter as any,
      baseConfig as any,
      7,
      undefined,
      {
        retrievalUserPrompt: '继续推进调查',
        contextWindow: WINDOW,
        reservedOutputTokens: RESERVED,
        // 弹性标志已不再选择引擎：有窗口信息即分层弹性。
        elasticBudget: true,
      },
    );
    expect(result.hierarchicalBudgetTrace).toBeDefined();
    const boards = result.hierarchicalBudgetTrace!.boardAllocations;
    expect(Object.keys(boards).sort()).toEqual(
      ['episodic', 'resources', 'slidingWindow', 'storyState'].sort(),
    );
    expect(result.elasticBudgetTrace).toBeUndefined();
    expect(result.pipelineContext.outlineText).toBe('');
  });

  it('no-window callers keep the legacy config passthrough (no traces)', async () => {
    const result = await buildContext(
      baseChapter as any,
      baseConfig as any,
      7,
      undefined,
      {
        retrievalUserPrompt: '继续推进调查',
      },
    );
    expect(result.hierarchicalBudgetTrace).toBeUndefined();
    expect(result.elasticBudgetTrace).toBeUndefined();
  });
});
