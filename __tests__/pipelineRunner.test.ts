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
  getChaptersByProject: jest.fn(async () => []),
}));

jest.mock('../src/services/llm', () => ({
  callLLMResult: (...args: any[]) => mockCallLLMResult(...args),
}));

jest.mock('../src/services/contextBuilder', () => ({
  buildContext: jest.fn(async () => ({ messages: [{ role: 'system', content: 'story context' }], chapters: [], trace: [], estimatedInputTokens: 0 })),
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
  title: 'Chapter 1',
  synopsis: 'Opening',
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

test('two-stage pipeline runs review-only mode before proof', async () => {
  mockCallLLMResult
    .mockResolvedValueOnce({ text: 'draft', inputTokens: 10, outputTokens: 20, totalTokens: 30 })
    .mockResolvedValueOnce({ text: '{"issues":["tighten ending"]}', inputTokens: 8, outputTokens: 6, totalTokens: 14 })
    .mockResolvedValueOnce({ text: 'polished', inputTokens: 15, outputTokens: 20, totalTokens: 35 });

  const { runChapterPipeline } = require('../src/services/pipelineRunner');
  await runChapterPipeline('task-two-stage', chapter);

  expect(mockCallLLMResult).toHaveBeenCalledTimes(3);
  expect(mockCallLLMResult.mock.calls[1][2]).toMatchObject({ scenario: 'pipeline_review' });
  expect(mockCallLLMResult.mock.calls[2][0][1].content).toContain('tighten ending');
  expect(mockStore.updateTaskStage).toHaveBeenCalledWith(
    'task-two-stage',
    expect.objectContaining({ stage: 'review', status: 'success' }),
  );
  expect(mockStore.updateTaskStage).toHaveBeenCalledWith(
    'task-two-stage',
    expect.objectContaining({ stage: 'factCheck', status: 'skipped' }),
  );
  expect(mockStore.completeTask).toHaveBeenCalledWith('task-two-stage', 'polished');
});

test('conditional pipeline runs fact-check-only mode before proof', async () => {
  mockGetPipelineConfig.mockResolvedValue(baseConfig({ pipelineMode: 'conditional' }));
  mockCallLLMResult
    .mockResolvedValueOnce({ text: 'draft', inputTokens: 10, outputTokens: 20, totalTokens: 30 })
    .mockResolvedValueOnce({ text: '{"errors":["timeline mismatch"]}', inputTokens: 9, outputTokens: 6, totalTokens: 15 })
    .mockResolvedValueOnce({ text: 'final after fact check', inputTokens: 14, outputTokens: 20, totalTokens: 34 });

  const { runChapterPipeline } = require('../src/services/pipelineRunner');
  await runChapterPipeline('task-conditional', chapter);

  expect(mockCallLLMResult).toHaveBeenCalledTimes(3);
  expect(mockCallLLMResult.mock.calls[1][2]).toMatchObject({ scenario: 'pipeline_factcheck' });
  expect(mockCallLLMResult.mock.calls[2][0][1].content).toContain('timeline mismatch');
  expect(mockStore.updateTaskStage).toHaveBeenCalledWith(
    'task-conditional',
    expect.objectContaining({ stage: 'review', status: 'skipped' }),
  );
  expect(mockStore.updateTaskStage).toHaveBeenCalledWith(
    'task-conditional',
    expect.objectContaining({ stage: 'factCheck', status: 'success' }),
  );
  expect(mockStore.completeTask).toHaveBeenCalledWith('task-conditional', 'final after fact check');
});

test('two-stage pipeline falls back to draft when review-only proof fails', async () => {
  mockCallLLMResult
    .mockResolvedValueOnce({ text: 'draft', inputTokens: 10, outputTokens: 20, totalTokens: 30 })
    .mockResolvedValueOnce({ text: '{"issues":[]}', inputTokens: 8, outputTokens: 6, totalTokens: 14 })
    .mockRejectedValueOnce(new Error('proof LLM error'));

  const { runChapterPipeline } = require('../src/services/pipelineRunner');
  await runChapterPipeline('task-two-stage-proof-fail', chapter);

  expect(mockCallLLMResult).toHaveBeenCalledTimes(3);
  expect(mockStore.updateTaskStage).toHaveBeenCalledWith(
    'task-two-stage-proof-fail',
    expect.objectContaining({ stage: 'proof', status: 'failed' }),
  );
  expect(mockStore.completeTask).toHaveBeenCalledWith('task-two-stage-proof-fail', 'draft');
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
