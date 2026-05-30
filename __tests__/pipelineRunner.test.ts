import type { Chapter } from '../src/types/novel';

const mockStore = {
  setTaskStatus: jest.fn(),
  updateTaskStage: jest.fn(),
  completeTask: jest.fn(),
  failTask: jest.fn(),
  cancelTask: jest.fn(),
};

const mockGetPipelineConfig = jest.fn();
const mockCallLLMResult = jest.fn();

jest.mock('../src/services/database', () => ({
  getPipelineConfig: (...args: any[]) => mockGetPipelineConfig(...args),
  getContextConfig: jest.fn(async () => ({
    strategy: 'sliding',
    slidingWindowSize: 1000,
    customRangeStart: 0,
    customRangeEnd: -1,
    resourceBudget: 0,
    includeResources: false,
  })),
  getPresetsByProject: jest.fn(async () => [
    {
      id: 1,
      system_prompt: 'draft system',
      writing_style: '',
      extra_instructions: '',
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 1000,
    },
  ]),
}));

jest.mock('../src/services/llm', () => ({
  callLLMResult: (...args: any[]) => mockCallLLMResult(...args),
}));

jest.mock('../src/services/contextBuilder', () => ({
  buildContext: jest.fn(async () => [{ role: 'system', content: 'story context' }]),
}));

jest.mock('../src/services/chapterGeneration', () => ({
  createChapterGenerationRequest: jest.fn(() => ({
    mode: 'continue',
    scenario: 'chapter_continue',
    userPrompt: 'continue chapter',
  })),
}));

jest.mock('../src/store/pipelineTaskStore', () => ({
  usePipelineTaskStore: {
    getState: () => mockStore,
  },
}));

const chapter: Chapter = {
  id: 1,
  project_id: 10,
  position: 0,
  title: '第一章',
  synopsis: '开端',
  content: '',
  status: 'draft',
  summary_json: null,
  created_at: '',
  updated_at: '',
};

function baseConfig(overrides: Record<string, any> = {}) {
  return {
    pipelineMode: 'twoStage',
    draftPresetId: null,
    reviewPresetId: null,
    factCheckPresetId: null,
    proofPresetId: null,
    draftMaxTokens: 4000,
    reviewMaxTokens: 1500,
    factCheckMaxTokens: 1500,
    proofMaxTokens: 4000,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetPipelineConfig.mockResolvedValue(baseConfig());
  mockCallLLMResult.mockReset();
});

test('two-stage pipeline skips review and fact-check calls', async () => {
  mockCallLLMResult
    .mockResolvedValueOnce({ text: 'draft', inputTokens: 10, outputTokens: 20, totalTokens: 30 })
    .mockResolvedValueOnce({ text: 'polished', inputTokens: 15, outputTokens: 20, totalTokens: 35 });

  const { runChapterPipeline } = require('../src/services/pipelineRunner');
  await runChapterPipeline('task-two-stage', chapter);

  expect(mockCallLLMResult).toHaveBeenCalledTimes(2);
  expect(mockCallLLMResult.mock.calls[1][0][0].content).toContain('轻量终审');
  expect(mockCallLLMResult.mock.calls[1][2]).toMatchObject({ scenario: 'pipeline_light_proof' });
  expect(mockStore.updateTaskStage).toHaveBeenCalledWith(
    'task-two-stage',
    expect.objectContaining({ stage: 'review', status: 'skipped' }),
  );
  expect(mockStore.updateTaskStage).toHaveBeenCalledWith(
    'task-two-stage',
    expect.objectContaining({ stage: 'factCheck', status: 'skipped' }),
  );
  expect(mockStore.completeTask).toHaveBeenCalledWith('task-two-stage', 'polished');
});

test('conditional pipeline completes with draft when assessment says proof is unnecessary', async () => {
  mockGetPipelineConfig.mockResolvedValue(baseConfig({ pipelineMode: 'conditional' }));
  mockCallLLMResult
    .mockResolvedValueOnce({ text: 'draft', inputTokens: 10, outputTokens: 20, totalTokens: 30 })
    .mockResolvedValueOnce({ text: '{"needsProof":false,"reasons":[]}', inputTokens: 6, outputTokens: 4, totalTokens: 10 });

  const { runChapterPipeline } = require('../src/services/pipelineRunner');
  await runChapterPipeline('task-conditional-clean', chapter);

  expect(mockCallLLMResult).toHaveBeenCalledTimes(2);
  expect(mockCallLLMResult.mock.calls[1][0][0].content).toContain('严格 JSON');
  expect(mockCallLLMResult.mock.calls[1][2]).toMatchObject({ scenario: 'pipeline_assessment' });
  expect(mockStore.updateTaskStage).toHaveBeenCalledWith(
    'task-conditional-clean',
    expect.objectContaining({ stage: 'proof', status: 'skipped' }),
  );
  expect(mockStore.completeTask).toHaveBeenCalledWith('task-conditional-clean', 'draft');
});

test('conditional pipeline runs proof when assessment JSON is invalid', async () => {
  mockGetPipelineConfig.mockResolvedValue(baseConfig({ pipelineMode: 'conditional' }));
  mockCallLLMResult
    .mockResolvedValueOnce({ text: 'draft', inputTokens: 10, outputTokens: 20, totalTokens: 30 })
    .mockResolvedValueOnce({ text: '需要再润色一下', inputTokens: 6, outputTokens: 4, totalTokens: 10 })
    .mockResolvedValueOnce({ text: 'final after invalid assessment', inputTokens: 12, outputTokens: 20, totalTokens: 32 });

  const { runChapterPipeline } = require('../src/services/pipelineRunner');
  await runChapterPipeline('task-conditional-invalid', chapter);

  expect(mockCallLLMResult).toHaveBeenCalledTimes(3);
  expect(mockStore.completeTask).toHaveBeenCalledWith('task-conditional-invalid', 'final after invalid assessment');
});

test('full pipeline keeps review and fact-check before proofing', async () => {
  mockGetPipelineConfig.mockResolvedValue(baseConfig({ pipelineMode: 'full' }));
  mockCallLLMResult
    .mockResolvedValueOnce({ text: 'draft', inputTokens: 10, outputTokens: 20, totalTokens: 30 })
    .mockResolvedValueOnce({ text: '{"issues":[]}', inputTokens: 5, outputTokens: 4, totalTokens: 9 })
    .mockResolvedValueOnce({ text: '{"errors":[]}', inputTokens: 6, outputTokens: 4, totalTokens: 10 })
    .mockResolvedValueOnce({ text: 'final', inputTokens: 12, outputTokens: 20, totalTokens: 32 });

  const { runChapterPipeline } = require('../src/services/pipelineRunner');
  await runChapterPipeline('task-full', chapter);

  expect(mockCallLLMResult).toHaveBeenCalledTimes(4);
  expect(mockStore.updateTaskStage).toHaveBeenCalledWith(
    'task-full',
    expect.objectContaining({ stage: 'review', status: 'success' }),
  );
  expect(mockStore.updateTaskStage).toHaveBeenCalledWith(
    'task-full',
    expect.objectContaining({ stage: 'factCheck', status: 'success' }),
  );
  expect(mockStore.completeTask).toHaveBeenCalledWith('task-full', 'final');
});
