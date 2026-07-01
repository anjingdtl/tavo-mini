import type { Chapter } from '../src/types/novel';

// 测试用 draftPreviews：mock 的 setDraftPreview/clearDraftPreview 通过 closure 维护此 map，
// 让 store.getState().draftPreviews[taskId] 拿到正确的草稿预览文本。
const mockDraftPreviews: Record<string, string> = {};

const mockStore: {
  setTaskStatus: jest.Mock;
  updateTaskStage: jest.Mock;
  completeTask: jest.Mock;
  failTask: jest.Mock;
  cancelTask: jest.Mock;
  setDraftPreview: jest.Mock;
  clearDraftPreview: jest.Mock;
  draftPreviews: Record<string, string>;
  getState: () => typeof mockStore;
} = {
  setTaskStatus: jest.fn(),
  updateTaskStage: jest.fn(),
  completeTask: jest.fn(),
  failTask: jest.fn(),
  cancelTask: jest.fn(),
  setDraftPreview: jest.fn((taskId: string, text: string) => {
    mockDraftPreviews[taskId] = text;
  }) as any,
  clearDraftPreview: jest.fn((taskId: string) => {
    delete mockDraftPreviews[taskId];
  }) as any,
  draftPreviews: mockDraftPreviews,
  getState() {
    return mockStore;
  },
};

const mockGetPipelineConfig = jest.fn();
const mockCallLLMResult = jest.fn();
const mockCallLLMStream = jest.fn();
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
  callLLMStream: (...args: any[]) => mockCallLLMStream(...args),
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
  mockCallLLMStream.mockReset();
  mockSaveDraft.mockResolvedValue(1);
  // 默认 callLLMStream 调用即成功（覆盖老路径测试，正常没人调它）
  mockCallLLMStream.mockImplementation(async (_messages: any, _max: any, _cfg: any, handlers: any) => {
    handlers.onChunk('draft-stream-output');
    handlers.onDone({ text: 'draft-stream-output', inputTokens: 1, outputTokens: 1, totalTokens: 2 });
    return { text: 'draft-stream-output', inputTokens: 1, outputTokens: 1, totalTokens: 2 };
  });
});

/**
 * 工具：让 mockCallLLMStream 按指定时序触发一次流式生成，并把最终文本作为 draftText。
 */
function mockStreamOnce(text: string, tokens: { input: number; output: number; total: number }) {
  mockCallLLMStream.mockImplementationOnce(async (_m: any, _max: any, _cfg: any, handlers: any) => {
    // 模拟 provider 把整段一次性吐出，但分多个 chunk
    const chunkSize = 50;
    for (let i = 0; i < text.length; i += chunkSize) {
      handlers.onChunk(text.slice(i, i + chunkSize));
    }
    handlers.onDone({
      text,
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      totalTokens: tokens.total,
    });
    return { text, ...tokens };
  });
}

test('two-stage pipeline runs review-only mode before proof', async () => {
  mockCallLLMResult
    .mockResolvedValueOnce({ text: 'draft', inputTokens: 10, outputTokens: 20, totalTokens: 30 })
    .mockResolvedValueOnce({ text: '{"issues":["tighten ending"]}', inputTokens: 8, outputTokens: 6, totalTokens: 14 })
    .mockResolvedValueOnce({ text: 'polished', inputTokens: 15, outputTokens: 20, totalTokens: 35 });

  const { runChapterPipeline } = require('../src/services/pipelineRunner');
  await runChapterPipeline('task-two-stage', chapter, undefined, { useDraftStream: false });

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
  const run = runChapterPipeline('task-await-save', chapter, undefined, { useDraftStream: false }).then(() => {
    resolved = true;
  });

  for (let i = 0; i < 10 && mockSaveDraft.mock.calls.length === 0; i += 1) {
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
  await runChapterPipeline('task-config-fail', chapter, undefined, { useDraftStream: false });

  expect(mockStore.failTask).toHaveBeenCalledWith('task-config-fail', '配置读取失败');
  expect(mockCallLLMResult).not.toHaveBeenCalled();
});

test('conditional pipeline runs fact-check-only mode before proof', async () => {
  mockGetPipelineConfig.mockResolvedValue(baseConfig({ pipelineMode: 'conditional' }));
  mockCallLLMResult
    .mockResolvedValueOnce({ text: 'draft', inputTokens: 10, outputTokens: 20, totalTokens: 30 })
    .mockResolvedValueOnce({ text: '{"errors":["timeline mismatch"]}', inputTokens: 9, outputTokens: 6, totalTokens: 15 })
    .mockResolvedValueOnce({ text: 'final after fact check', inputTokens: 14, outputTokens: 20, totalTokens: 34 });

  const { runChapterPipeline } = require('../src/services/pipelineRunner');
  await runChapterPipeline('task-conditional', chapter, undefined, { useDraftStream: false });

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
  await runChapterPipeline('task-two-stage-proof-fail', chapter, undefined, { useDraftStream: false });

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
  await runChapterPipeline('task-full', chapter, undefined, { useDraftStream: false });

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

// ───────────────────────── V2.2.0 流式草稿新增 ─────────────────────────

test('V2.2.0: 默认 useDraftStream=true 时草稿走 callLLMStream 且触发 setDraftPreview', async () => {
  // twoStage 默认配置：draft → review → proof。draft 走流式，review+proof 走非流式
  mockStreamOnce('草稿流式输出', { input: 11, output: 22, total: 33 });
  mockCallLLMResult
    .mockResolvedValueOnce({ text: 'review-out', inputTokens: 1, outputTokens: 1, totalTokens: 2 })
    .mockResolvedValueOnce({ text: 'polished', inputTokens: 15, outputTokens: 25, totalTokens: 40 });

  const { runChapterPipeline } = require('../src/services/pipelineRunner');
  await runChapterPipeline('task-stream-default', chapter); // 默认 useDraftStream=true

  expect(mockCallLLMStream).toHaveBeenCalledTimes(1);
  expect(mockCallLLMResult).toHaveBeenCalledTimes(2); // review + proof
  expect(mockStore.setDraftPreview).toHaveBeenCalled();
  // updateTaskStage 写入的 draft 文本应当等于流式输出的最后完整文本
  const draftStageCall = mockStore.updateTaskStage.mock.calls.find(
    (c: any[]) => c[1]?.stage === 'draft',
  );
  expect(draftStageCall?.[1]?.text).toBe('草稿流式输出');
  expect(draftStageCall?.[1]?.tokens).toEqual({ input: 11, output: 22, total: 33 });
  expect(mockStore.completeTask).toHaveBeenCalledWith('task-stream-default', 'polished');
});

test('V2.2.0: useDraftStream=false 等价 V2.1.5 行为，全走 callLLMResult', async () => {
  mockCallLLMResult
    .mockResolvedValueOnce({ text: 'draft-old', inputTokens: 1, outputTokens: 1, totalTokens: 2 }) // draft
    .mockResolvedValueOnce({ text: 'review-out', inputTokens: 1, outputTokens: 1, totalTokens: 2 }) // review
    .mockResolvedValueOnce({ text: 'final-old', inputTokens: 1, outputTokens: 1, totalTokens: 2 }); // proof

  const { runChapterPipeline } = require('../src/services/pipelineRunner');
  await runChapterPipeline('task-stream-off', chapter, undefined, { useDraftStream: false });

  expect(mockCallLLMStream).not.toHaveBeenCalled();
  expect(mockCallLLMResult).toHaveBeenCalledTimes(3); // draft + review + proof
  expect(mockStore.setDraftPreview).not.toHaveBeenCalled();
});

test('V2.2.0: 流式抛 stream_not_supported 自动回退到非流式，仍完成任务', async () => {
  // 第一次 callLLMStream 抛 stream_not_supported → 回退 callLLMResult
  mockCallLLMStream.mockImplementationOnce(async (_m: any, _max: any, _cfg: any, handlers: any) => {
    const err: any = new Error('Provider 不支持 SSE');
    err.code = 'stream_not_supported';
    handlers.onError(err);
    throw err;
  });
  mockCallLLMResult
    .mockResolvedValueOnce({ text: 'fallback-draft', inputTokens: 1, outputTokens: 2, totalTokens: 3 }) // draft (回退)
    .mockResolvedValueOnce({ text: 'review-out', inputTokens: 1, outputTokens: 1, totalTokens: 2 }) // review
    .mockResolvedValueOnce({ text: 'fallback-final', inputTokens: 1, outputTokens: 2, totalTokens: 3 }); // proof

  const { runChapterPipeline } = require('../src/services/pipelineRunner');
  await runChapterPipeline('task-stream-fallback', chapter); // 默认 useDraftStream=true

  expect(mockCallLLMStream).toHaveBeenCalledTimes(1);
  expect(mockCallLLMResult).toHaveBeenCalledTimes(3); // draft(回退) + review + proof
  expect(mockStore.completeTask).toHaveBeenCalledWith('task-stream-fallback', 'fallback-final');
});

test('V2.2.0: 流式用户取消触发 cancelTask 而非 failTask', async () => {
  mockCallLLMStream.mockImplementationOnce(async (_m: any, _max: any, _cfg: any, handlers: any) => {
    const err: any = new Error('已取消');
    err.code = 'cancelled';
    handlers.onError(err);
    throw err;
  });

  const { runChapterPipeline, cancelPipeline } = require('../src/services/pipelineRunner');
  const runPromise = runChapterPipeline('task-cancel-stream', chapter);
  // 立刻取消
  cancelPipeline('task-cancel-stream');
  await runPromise;

  expect(mockStore.cancelTask).toHaveBeenCalledWith('task-cancel-stream');
  expect(mockStore.failTask).not.toHaveBeenCalled();
  expect(mockStore.clearDraftPreview).toHaveBeenCalledWith('task-cancel-stream');
});
