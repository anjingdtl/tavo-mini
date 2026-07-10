import type { Chapter } from '../src/types/novel';

const mockStore: {
  setTaskStatus: jest.Mock;
  updateTaskStage: jest.Mock;
  completeTask: jest.Mock;
  failTask: jest.Mock;
  cancelTask: jest.Mock;
  getState: () => typeof mockStore;
} = {
  setTaskStatus: jest.fn(),
  updateTaskStage: jest.fn(),
  completeTask: jest.fn(),
  failTask: jest.fn(),
  cancelTask: jest.fn(),
  getState() {
    return mockStore;
  },
};

const mockGetPipelineConfig = jest.fn();
const mockCallLLMResult = jest.fn();
const mockResolveLLMRequestConfig = jest.fn();
const mockSaveDraft = jest.fn();

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
  resolveLLMRequestConfig: (...args: any[]) => mockResolveLLMRequestConfig(...args),
}));

jest.mock('../src/services/draftService', () => ({
  saveDraft: (...args: any[]) => mockSaveDraft(...args),
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

jest.mock('../src/native/PipelineForegroundModule', () => ({
  PipelineForeground: {
    setEnabled: jest.fn(),
    isEnabled: jest.fn(() => false),
    start: jest.fn(() => Promise.resolve()),
    updateProgress: jest.fn(() => Promise.resolve()),
    notifyComplete: jest.fn(() => Promise.resolve()),
    notifyFailed: jest.fn(() => Promise.resolve()),
    stop: jest.fn(() => Promise.resolve()),
    isAvailable: jest.fn(() => Promise.resolve(false)),
    consumeDeepLinkTaskId: jest.fn(() => Promise.resolve(null)),
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
  mockResolveLLMRequestConfig.mockReset();
  mockResolveLLMRequestConfig.mockResolvedValue({ id: 1, name: 'active', url: 'https://api.example/v1/chat/completions', api_key: 'sk-test', model_name: 'model-a' });
  mockSaveDraft.mockResolvedValue(1);
});

test('two-stage pipeline runs review and proof in parallel (V2.2.0)', async () => {
  // V2.2.0：twoStage 模式下 review 和 proof 并行启动，节省一个阶段的延迟。
  // proof 启动时 review 还没完成，所以 proof 的入参里 reviewText='审阅编辑未能完成审阅，请自行判断…'
  mockCallLLMResult
    .mockResolvedValueOnce({ text: 'draft', inputTokens: 10, outputTokens: 20, totalTokens: 30 })
    .mockResolvedValueOnce({ text: '{"issues":["tighten ending"]}', inputTokens: 8, outputTokens: 6, totalTokens: 14 })
    .mockResolvedValueOnce({ text: 'polished', inputTokens: 15, outputTokens: 20, totalTokens: 35 });

  const { runChapterPipeline } = require('../src/services/pipelineRunner');
  await runChapterPipeline('task-two-stage', chapter);

  expect(mockCallLLMResult).toHaveBeenCalledTimes(3);
  const calls = mockCallLLMResult.mock.calls;
  const reviewCallArgs = calls.find((c: any[]) => c[2]?.scenario === 'pipeline_review');
  const proofCallArgs = calls.find((c: any[]) => c[2]?.scenario === 'pipeline_proof');
  expect(reviewCallArgs).toBeDefined();
  expect(proofCallArgs).toBeDefined();
  // proof 启动时 review 还没完成，所以 proof 的 prompt 里 reviewText 是占位文本
  expect(proofCallArgs![0][1].content).toContain('审阅编辑未能完成审阅');
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

test('pipeline does not resolve until the completed draft is saved and task is completed', async () => {
  let releaseSave!: () => void;
  mockSaveDraft.mockReturnValueOnce(new Promise<number>((resolve) => {
    releaseSave = () => resolve(1);
  }));
  mockCallLLMResult
    .mockResolvedValueOnce({ text: 'draft', inputTokens: 10, outputTokens: 20, totalTokens: 30 })
    .mockResolvedValueOnce({ text: '{"issues":[]}', inputTokens: 8, outputTokens: 6, totalTokens: 14 })
    .mockResolvedValueOnce({ text: 'polished', inputTokens: 15, outputTokens: 20, totalTokens: 35 });

  const { runChapterPipeline } = require('../src/services/pipelineRunner');
  let resolved = false;
  const run = runChapterPipeline('task-await-save', chapter).then(() => {
    resolved = true;
  });

  for (let i = 0; i < 50 && mockSaveDraft.mock.calls.length === 0; i += 1) {
    await Promise.resolve();
  }
  await Promise.resolve();

  expect(mockSaveDraft).toHaveBeenCalledWith(expect.objectContaining({
    content: 'polished',
    pipelineTaskId: 'task-await-save',
    source: 'pipeline',
  }));
  expect(resolved).toBe(false);
  expect(mockStore.completeTask).not.toHaveBeenCalledWith('task-await-save', 'polished');

  releaseSave();
  await run;

  expect(resolved).toBe(true);
  expect(mockStore.completeTask).toHaveBeenCalledWith('task-await-save', 'polished');
});

test('pipeline marks setup errors as failed tasks instead of leaving them unclear', async () => {
  mockGetPipelineConfig.mockRejectedValueOnce(new Error('配置读取失败'));

  const { runChapterPipeline } = require('../src/services/pipelineRunner');
  await runChapterPipeline('task-config-fail', chapter);

  expect(mockStore.failTask).toHaveBeenCalledWith('task-config-fail', '配置读取失败');
  expect(mockCallLLMResult).not.toHaveBeenCalled();
});

test('explicit cancellation immediately persists the cancelled task and stops foreground work', async () => {
  const { cancelPipeline } = require('../src/services/pipelineRunner');
  const { PipelineForeground } = require('../src/native/PipelineForegroundModule');

  cancelPipeline('task-stop-now');

  expect(mockStore.cancelTask).toHaveBeenCalledWith('task-stop-now');
  expect(PipelineForeground.stop).toHaveBeenCalledWith('task-stop-now');
});

test('conditional pipeline runs fact-check and proof in parallel (V2.2.0)', async () => {
  mockGetPipelineConfig.mockResolvedValue(baseConfig({ pipelineMode: 'conditional' }));
  mockCallLLMResult
    .mockResolvedValueOnce({ text: 'draft', inputTokens: 10, outputTokens: 20, totalTokens: 30 })
    .mockResolvedValueOnce({ text: '{"errors":["timeline mismatch"]}', inputTokens: 9, outputTokens: 6, totalTokens: 15 })
    .mockResolvedValueOnce({ text: 'final after fact check', inputTokens: 14, outputTokens: 20, totalTokens: 34 });

  const { runChapterPipeline } = require('../src/services/pipelineRunner');
  await runChapterPipeline('task-conditional', chapter);

  expect(mockCallLLMResult).toHaveBeenCalledTimes(3);
  const calls = mockCallLLMResult.mock.calls;
  const factCheckCallArgs = calls.find((c: any[]) => c[2]?.scenario === 'pipeline_factcheck');
  const proofCallArgs = calls.find((c: any[]) => c[2]?.scenario === 'pipeline_proof');
  expect(factCheckCallArgs).toBeDefined();
  expect(proofCallArgs).toBeDefined();
  // proof 启动时 factCheck 还没完成，所以 factCheckText 是占位文本
  expect(proofCallArgs![0][1].content).toContain('事实核查员未能完成核查');
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

test('pipeline defaults to non-streaming draft generation and reuses one LLM request config', async () => {
  const llmRequestConfig = { id: 7, name: 'shared', url: 'https://api.example/v1/chat/completions', api_key: 'sk-shared', model_name: 'shared-model' };
  mockResolveLLMRequestConfig.mockResolvedValueOnce(llmRequestConfig);
  mockCallLLMResult
    .mockResolvedValueOnce({ text: 'draft-non-stream', inputTokens: 11, outputTokens: 22, totalTokens: 33 })
    .mockResolvedValueOnce({ text: 'review-out', inputTokens: 1, outputTokens: 1, totalTokens: 2 })
    .mockResolvedValueOnce({ text: 'polished', inputTokens: 15, outputTokens: 25, totalTokens: 40 });

  const { runChapterPipeline } = require('../src/services/pipelineRunner');
  await runChapterPipeline('task-non-stream-default', chapter);

  expect(mockResolveLLMRequestConfig).toHaveBeenCalledTimes(1);
  expect(mockCallLLMResult).toHaveBeenCalledTimes(3);
  const draftStageCall = mockStore.updateTaskStage.mock.calls.find(
    (c: any[]) => c[1]?.stage === 'draft',
  );
  expect(draftStageCall?.[1]?.text).toBe('draft-non-stream');
  expect(draftStageCall?.[1]?.tokens).toEqual({ input: 11, output: 22, total: 33 });
  for (const call of mockCallLLMResult.mock.calls) {
    expect(call[2]?.requestConfig).toBe(llmRequestConfig);
  }
  expect(mockStore.completeTask).toHaveBeenCalledWith('task-non-stream-default', 'polished');
});

test('V2.2.0: twoStage review 和 proof 真实并行启动（不是顺序）', async () => {
  // 用延迟模拟 LLM 耗时：review 200ms、proof 200ms。
  // 串行下总耗时 ≥ 400ms；并行下应 < 350ms。
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  mockCallLLMResult
    .mockImplementationOnce(async () => {
      await delay(200);
      return { text: 'draft', inputTokens: 1, outputTokens: 1, totalTokens: 2 };
    })
    .mockImplementationOnce(async () => {
      await delay(200);
      return { text: 'review-out', inputTokens: 1, outputTokens: 1, totalTokens: 2 };
    })
    .mockImplementationOnce(async () => {
      await delay(200);
      return { text: 'proof-out', inputTokens: 1, outputTokens: 1, totalTokens: 2 };
    });

  const { runChapterPipeline } = require('../src/services/pipelineRunner');
  const start = Date.now();
  await runChapterPipeline('task-parallel-timing', chapter);
  const elapsed = Date.now() - start;
  // 顺序下 draft(200) + review(200) + proof(200) = 600ms；
  // 并行下 draft(200) + max(review, proof)=200 → 400ms 左右。给 80ms 余量（CI 容差）
  expect(elapsed).toBeLessThan(500);
});
