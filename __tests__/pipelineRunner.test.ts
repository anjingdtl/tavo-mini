/**
 * Pipeline runner tests — corrected dependency flow (SPEC §20).
 *
 * The old V2.2.0 tests asserted review/proof ran in parallel and proof saw an
 * empty reviewText. SPEC §2-§5 declares that behavior incorrect: review and
 * proof MUST be sequential, and proof MUST receive the real review text. The
 * tests below assert the corrected state machine.
 */
import type { Chapter } from '../src/types/novel';

const mockStore: {
  setTaskStatus: jest.Mock;
  updateTaskStage: jest.Mock;
  persistTaskStage: jest.Mock;
  persistTaskStatus: jest.Mock;
  completeTask: jest.Mock;
  persistCompleteTask: jest.Mock;
  setTaskFinalText: jest.Mock;
  persistTaskFinalText: jest.Mock;
  failTask: jest.Mock;
  persistFailTask: jest.Mock;
  cancelTask: jest.Mock;
  setTaskInputFingerprint: jest.Mock;
  setTaskPipelineContext: jest.Mock;
  persistTaskPipelineContext: jest.Mock;
  tasks: any[];
  getState: () => typeof mockStore;
} = {
  setTaskStatus: jest.fn((taskId: string, status: string) => {
    const task = mockStore.tasks.find((t: any) => t.id === taskId);
    if (task) task.status = status;
  }),
  updateTaskStage: jest.fn((taskId: string, result: any) => {
    const task = mockStore.tasks.find((t: any) => t.id === taskId);
    if (task) {
      task.stageResults = [
        ...(task.stageResults || []).filter(
          (s: any) => s.stage !== result.stage,
        ),
        result,
      ];
    }
  }),
  persistTaskStage: jest.fn(async (taskId: string, result: any) => {
    mockStore.updateTaskStage(taskId, result);
  }),
  persistTaskStatus: jest.fn(async (taskId: string, status: string) => {
    mockStore.setTaskStatus(taskId, status);
  }),
  completeTask: jest.fn((taskId: string, finalText: string) => {
    const task = mockStore.tasks.find((t: any) => t.id === taskId);
    if (task) {
      task.status = 'completed';
      task.finalText = finalText;
    }
  }),
  persistCompleteTask: jest.fn(async (taskId: string, finalText: string) => {
    mockStore.completeTask(taskId, finalText);
  }),
  setTaskFinalText: jest.fn((taskId: string, finalText: string) => {
    const task = mockStore.tasks.find((t: any) => t.id === taskId);
    if (task) task.finalText = finalText;
  }),
  persistTaskFinalText: jest.fn(async (taskId: string, finalText: string) => {
    mockStore.setTaskFinalText(taskId, finalText);
  }),
  failTask: jest.fn((taskId: string, error: string) => {
    const task = mockStore.tasks.find((t: any) => t.id === taskId);
    if (task) {
      task.status = 'failed';
      task.error = error;
    }
  }),
  persistFailTask: jest.fn(async (taskId: string, error: string) => {
    mockStore.failTask(taskId, error);
  }),
  cancelTask: jest.fn(),
  setTaskInputFingerprint: jest.fn(),
  setTaskPipelineContext: jest.fn(),
  persistTaskPipelineContext: jest.fn(async (taskId: string, snapshot: any) => {
    const task = mockStore.tasks.find((t: any) => t.id === taskId);
    if (task) {
      task.pipelineContextJson = snapshot.pipelineContextJson;
      task.pipelineContextVersion = snapshot.pipelineContextVersion;
      task.pipelineContextHash = snapshot.pipelineContextHash;
    }
  }),
  tasks: [],
  getState() {
    return mockStore;
  },
};

const mockGetPipelineConfig = jest.fn();
const mockGetContextConfig = jest.fn();
const mockCallLLMResult = jest.fn();
const mockResolveLLMRequestConfig = jest.fn();
const mockSaveDraft = jest.fn();
const mockBuildContext = jest.fn();

jest.mock('../src/services/database', () => ({
  getPipelineConfig: (...args: any[]) => mockGetPipelineConfig(...args),
  getContextConfig: (...args: any[]) => mockGetContextConfig(...args),
  getActiveLLMConfig: jest.fn(async () => ({
    id: 1,
    context_window: 128000,
    max_output_tokens: 8000,
  })),
  getProjectById: jest.fn(async () => ({ id: 10, mode: 'outline' })),
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
  ensurePendingCheckpoints: jest.fn(async () => undefined),
  getStageCheckpoints: jest.fn(async () => []),
  getStageCheckpoint: jest.fn(async () => null),
  claimStageCheckpoint: jest.fn(async () => true),
  upsertStageCheckpoint: jest.fn(async () => undefined),
  interruptAllRunningStages: jest.fn(async () => 0),
}));

jest.mock('../src/services/llm', () => ({
  callLLMResult: (...args: any[]) => mockCallLLMResult(...args),
  resolveLLMRequestConfig: (...args: any[]) =>
    mockResolveLLMRequestConfig(...args),
  resolveLLMRequestConfigById: (...args: any[]) =>
    mockResolveLLMRequestConfig(...args),
}));

jest.mock('../src/services/draftService', () => ({
  saveDraft: (...args: any[]) => mockSaveDraft(...args),
}));

jest.mock('../src/services/contextBuilder', () => ({
  buildContext: (...args: any[]) => mockBuildContext(...args),
}));

jest.mock('../src/services/draftPipelineCompiler', () => ({
  compileDraftPipelineRequest: jest.fn(async () => ({
    messages: [{ role: 'system', content: 'story context' }],
    baseContext: [{ role: 'system', content: 'story context' }],
    pipelineContext: {
      presetText: 'preset-text',
      storyMemoryText: 'story-memory',
      characterText: 'character-text',
      noteText: 'note-text',
      worldbookText: 'worldbook-text',
      episodicMemoryText: 'episodic-text',
      recentBridgeText: 'recent-bridge',
      currentInstructionText: 'instruction',
      retrievalUserPrompt: 'user-prompt',
      outlineText: '',
      outlineFingerprint: '',
      outlineIds: [],
      outlineComplete: true,
      outlineEstimatedTokens: 0,
      projectId: 10,
      chapterId: 1,
    },
    estimatedInputTokens: 10,
    reservedOutputTokens: 4000,
    safetyMargin: 512,
    contextWindow: 128000,
    fits: true,
    blockingReason: null,
    chapterTitle: 'Chapter 1',
    prevEnding: '',
    userPrompt: 'continue chapter',
    draftPreset: null,
    requestConfig: {
      id: 1,
      context_window: 128000,
      provider_type: 'openai_compatible',
      api_key: 'sk',
      model_name: 'm',
      url: 'https://example.com/v1/chat/completions',
    },
    trace: [],
  })),
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

// Phase 3: attempt repository is exercised via real SQLite tests
// (pipelineStageAttemptRepository.test.ts); unit runs mock it to keep the
// pipeline state machine tests focused on orchestration.
jest.mock('../src/data/repositories/pipelineStageAttemptRepository', () => ({
  createStageAttempt: jest.fn(async () => undefined),
  updateStageAttempt: jest.fn(async () => undefined),
  getStageAttempts: jest.fn(async () => []),
  getLatestStageAttempt: jest.fn(async () => null),
  getStageAttempt: jest.fn(async () => null),
  getRetryDueAttempts: jest.fn(async () => []),
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

/** Snapshot mock with all fields the new flow needs. */
function snapshotMock(overrides: Record<string, any> = {}) {
  return {
    presetText: 'preset-text',
    storyMemoryText: 'story-memory',
    characterText: 'character-text',
    noteText: 'note-text',
    worldbookText: 'worldbook-text',
    episodicMemoryText: 'episodic-text',
    recentBridgeText: 'recent-bridge',
    currentInstructionText: 'instruction',
    retrievalUserPrompt: 'user-prompt',
    outlineText: '',
    outlineFingerprint: '',
    outlineIds: [],
    outlineComplete: true,
    outlineEstimatedTokens: 0,
    ...overrides,
  };
}

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

function defaultContextConfig() {
  return {
    strategy: 'sliding',
    slidingWindowSize: 1000,
    customRangeStart: 0,
    customRangeEnd: -1,
    resourceBudget: 0,
    includeResources: false,
  };
}

/** Valid literary review JSON (all required fields present). */
function validReview(partial?: {
  strengths?: string[];
  issues?: string[];
  suggestions?: string[];
}): string {
  return JSON.stringify({
    strengths: partial?.strengths ?? ['节奏顺畅'],
    issues: partial?.issues ?? [],
    suggestions: partial?.suggestions ?? [],
  });
}

function validBrief(): string {
  return JSON.stringify({
    strategy: '保持连续性',
    actions: [],
    preserve: [],
    ending: '',
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStore.tasks = [];
  mockGetPipelineConfig.mockResolvedValue(baseConfig());
  mockGetContextConfig.mockResolvedValue(defaultContextConfig());
  mockCallLLMResult.mockReset();
  mockResolveLLMRequestConfig.mockReset();
  mockResolveLLMRequestConfig.mockResolvedValue({
    id: 1,
    name: 'active',
    url: 'https://api.example/v1/chat/completions',
    api_key: 'sk-test',
    model_name: 'model-a',
    provider_type: 'openai_compatible',
    context_window: 128000,
    max_output_tokens: 8000,
  });
  mockSaveDraft.mockResolvedValue(1);
  mockBuildContext.mockReset();
  mockBuildContext.mockResolvedValue({
    messages: [{ role: 'system', content: 'story context' }],
    chapters: [],
    trace: [],
    estimatedInputTokens: 0,
    pipelineContext: snapshotMock(),
  });
  // reconcile reads task from store; seed a blank task for each id on demand
  const originalGetState = mockStore.getState.bind(mockStore);
  mockStore.getState = () => {
    const state = originalGetState();
    // Ensure persist methods stay bound
    return state;
  };
});

/** Ensure a task row exists in the mock store before reconcile. */
function seedTask(taskId: string) {
  if (!mockStore.tasks.find((t: any) => t.id === taskId)) {
    mockStore.tasks.push({
      id: taskId,
      targetType: 'chapter',
      targetId: chapter.id,
      status: 'idle',
      stageResults: [],
      finalText: null,
      error: null,
      outlineWorkflowVersion: 4,
      contextBudgetVersion: 5,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      resolvedAt: null,
    });
  }
}

async function runPipeline(taskId: string, ch: Chapter = chapter) {
  seedTask(taskId);
  const { runChapterPipeline } = require('../src/services/pipelineRunner');
  await runChapterPipeline(taskId, ch);
}

/** Find the mock LLM call for a given scenario tag. */
function callForScenario(calls: any[][], scenario: string): any[] | undefined {
  return calls.find(c => c[2]?.scenario === scenario);
}

/* ============================ noReview ============================ */

test('resume refuses an incomplete legacy task before changing its status or calling the model', async () => {
  mockStore.tasks.push({
    id: 'legacy-resume',
    targetType: 'chapter',
    targetId: chapter.id,
    status: 'interrupted',
    stageResults: [],
    finalText: null,
    error: '旧任务',
    outlineWorkflowVersion: 3,
    contextBudgetVersion: 4,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    resolvedAt: null,
  });
  const { resumePipeline } = require('../src/services/pipelineRunner');

  await expect(resumePipeline('legacy-resume', chapter)).rejects.toMatchObject({
    code: 'LEGACY_PIPELINE_RESUME_BLOCKED',
  });
  expect(mockStore.persistTaskStatus).not.toHaveBeenCalled();
  expect(mockCallLLMResult).not.toHaveBeenCalled();
});

test('resume refuses current-workflow tasks with legacy budget before touching saved chapter text', async () => {
  const protectedChapter: Chapter = {
    ...chapter,
    content: '用户已保存的章节正文',
  };
  mockStore.tasks.push({
    id: 'legacy-budget-resume',
    targetType: 'chapter',
    targetId: protectedChapter.id,
    status: 'interrupted',
    stageResults: [],
    finalText: null,
    error: '旧预算任务',
    outlineWorkflowVersion: 4,
    contextBudgetVersion: 4,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    resolvedAt: null,
  });
  const { resumePipeline } = require('../src/services/pipelineRunner');

  await expect(
    resumePipeline('legacy-budget-resume', protectedChapter),
  ).rejects.toMatchObject({
    code: 'LEGACY_PIPELINE_RESUME_BLOCKED',
  });
  expect(mockStore.persistTaskStatus).not.toHaveBeenCalled();
  expect(mockCallLLMResult).not.toHaveBeenCalled();
  expect(mockSaveDraft).not.toHaveBeenCalled();
  expect(protectedChapter.content).toBe('用户已保存的章节正文');
});

test('outline draft that only returns reasoning is failed instead of saved as an empty success', async () => {
  mockGetPipelineConfig.mockResolvedValue(
    baseConfig({ pipelineMode: 'noReview' }),
  );
  mockCallLLMResult.mockResolvedValueOnce({
    text: null,
    reasoningText: '内部推理',
    emptyReason: 'reasoning_only',
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
  });
  mockCallLLMResult.mockResolvedValueOnce({
    text: null,
    reasoningText: '仍是推理',
    emptyReason: 'reasoning_only',
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
  });

  await runPipeline('task-draft-reasoning-only');

  expect(mockStore.persistTaskStage).toHaveBeenCalledWith(
    'task-draft-reasoning-only',
    expect.objectContaining({
      stage: 'draft',
      status: 'failed',
      error: expect.stringContaining('推理'),
    }),
  );
  expect(mockStore.persistCompleteTask).not.toHaveBeenCalled();
  expect(mockSaveDraft).not.toHaveBeenCalled();
  expect(mockCallLLMResult).toHaveBeenCalledTimes(2);
  expect(mockCallLLMResult.mock.calls[1][2]?.thinking).toEqual({
    type: 'disabled',
  });
});

/* ============================ twoStage ============================ */

test('pipeline marks setup errors as failed tasks instead of leaving them unclear', async () => {
  mockGetPipelineConfig.mockRejectedValueOnce(new Error('配置读取失败'));

  await runPipeline('task-config-fail');

  expect(mockStore.persistFailTask).toHaveBeenCalledWith(
    'task-config-fail',
    expect.stringContaining('配置读取失败'),
  );
  expect(mockCallLLMResult).not.toHaveBeenCalled();
});

test('pipeline starts its foreground service before asynchronous configuration loading', async () => {
  let releaseConfig!: () => void;
  mockGetPipelineConfig.mockReturnValueOnce(
    new Promise(resolve => {
      releaseConfig = () => resolve(baseConfig());
    }),
  );

  seedTask('task-start-foreground-early');
  const { runChapterPipeline } = require('../src/services/pipelineRunner');
  const {
    PipelineForeground,
  } = require('../src/native/PipelineForegroundModule');
  const run = runChapterPipeline('task-start-foreground-early', chapter);

  await Promise.resolve();
  expect(PipelineForeground.start).toHaveBeenCalledWith(
    'task-start-foreground-early',
    'Chapter 1',
    '正在准备写作',
    0,
  );

  releaseConfig();
  mockCallLLMResult
    .mockResolvedValueOnce({
      text: 'draft',
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    })
    .mockResolvedValueOnce({
      text: validReview(),
      inputTokens: 8,
      outputTokens: 6,
      totalTokens: 14,
    })
    .mockResolvedValueOnce({
      text: validBrief(),
      inputTokens: 4,
      outputTokens: 6,
      totalTokens: 10,
    })
    .mockResolvedValueOnce({
      text: 'polished',
      inputTokens: 15,
      outputTokens: 20,
      totalTokens: 35,
    });
  await run;
});

test('explicit cancellation immediately persists the cancelled task and stops foreground work', async () => {
  const { cancelPipeline } = require('../src/services/pipelineRunner');
  const {
    PipelineForeground,
  } = require('../src/native/PipelineForegroundModule');

  cancelPipeline('task-stop-now');

  expect(mockStore.cancelTask).toHaveBeenCalledWith('task-stop-now');
  expect(PipelineForeground.stop).toHaveBeenCalledWith('task-stop-now');
});

test('late LLM response after cancellation never advances to review, proof, or completion', async () => {
  let releaseDraft!: (result: any) => void;
  mockCallLLMResult.mockImplementation((_: any, __: any, cfg: any) => {
    if (cfg.scenario === 'pipeline_draft') {
      return new Promise(resolve => {
        releaseDraft = resolve;
      });
    }
    throw new Error(`must not start ${cfg.scenario} after cancellation`);
  });

  seedTask('task-late-response-cancel');
  const {
    runChapterPipeline,
    cancelPipeline,
  } = require('../src/services/pipelineRunner');
  const run = runChapterPipeline('task-late-response-cancel', chapter);

  for (let i = 0; i < 200 && !releaseDraft; i += 1) {
    await Promise.resolve();
    await new Promise(r => setImmediate(r));
  }
  expect(releaseDraft).toBeDefined();

  cancelPipeline('task-late-response-cancel');
  releaseDraft({
    text: 'late draft',
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
  });
  await run;

  expect(mockStore.cancelTask).toHaveBeenCalledWith(
    'task-late-response-cancel',
  );
  expect(
    callForScenario(mockCallLLMResult.mock.calls, 'pipeline_review'),
  ).toBeUndefined();
  expect(
    callForScenario(mockCallLLMResult.mock.calls, 'pipeline_proof'),
  ).toBeUndefined();
  expect(mockStore.persistCompleteTask).not.toHaveBeenCalledWith(
    'task-late-response-cancel',
    expect.anything(),
  );
});

