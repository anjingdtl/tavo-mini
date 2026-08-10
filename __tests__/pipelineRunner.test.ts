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

/** Valid fact-check JSON (all required fields present). */
function validFactCheck(partial?: {
  errors?: Array<string | Record<string, string>>;
  warnings?: Array<string | Record<string, string>>;
  confirmed?: Array<string | Record<string, string>>;
}): string {
  return JSON.stringify({
    errors: partial?.errors ?? [],
    warnings: partial?.warnings ?? [],
    confirmed: partial?.confirmed ?? ['无矛盾'],
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

/** Collect the order of stage status transitions the store saw. */
function stageStatusSequence(): string[] {
  return mockStore.setTaskStatus.mock.calls.map(c => c[1]);
}

/* ============================ noReview ============================ */

test('noReview: only draft is called, review/factCheck/proof are skipped', async () => {
  mockGetPipelineConfig.mockResolvedValue(
    baseConfig({ pipelineMode: 'noReview' }),
  );
  mockCallLLMResult.mockResolvedValueOnce({
    text: 'draft',
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
  });

  await runPipeline('task-no-review');

  expect(mockCallLLMResult).toHaveBeenCalledTimes(1);
  expect(
    callForScenario(mockCallLLMResult.mock.calls, 'pipeline_draft'),
  ).toBeDefined();
  expect(mockStore.persistTaskStage).toHaveBeenCalledWith(
    'task-no-review',
    expect.objectContaining({ stage: 'review', status: 'skipped' }),
  );
  expect(mockStore.persistTaskStage).toHaveBeenCalledWith(
    'task-no-review',
    expect.objectContaining({ stage: 'factCheck', status: 'skipped' }),
  );
  expect(mockStore.persistTaskStage).toHaveBeenCalledWith(
    'task-no-review',
    expect.objectContaining({ stage: 'proof', status: 'skipped' }),
  );
  expect(mockStore.persistCompleteTask).toHaveBeenCalledWith(
    'task-no-review',
    'draft',
  );
});

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
});

/* ============================ twoStage ============================ */

test('twoStage: proof starts AFTER review completes and receives the real reviewText (SPEC §5.2)', async () => {
  // Sequence the LLM calls: draft, then review, then proof. Capture call order
  // via the mock invocation order to assert proof runs after review resolves.
  const callLog: string[] = [];
  mockCallLLMResult.mockImplementation(
    async (messages: any[], _tokens: any, cfg: any) => {
      callLog.push(cfg.scenario);
      if (cfg.scenario === 'pipeline_draft') {
        return {
          text: 'draft-body',
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
        };
      }
      if (cfg.scenario === 'pipeline_review') {
        return {
          text: validReview({
            issues: ['tighten ending'],
            suggestions: ['rewrite last paragraph'],
          }),
          inputTokens: 8,
          outputTokens: 6,
          totalTokens: 14,
        };
      }
      if (cfg.scenario === 'pipeline_proof') {
        return {
          text: 'final-polished',
          inputTokens: 15,
          outputTokens: 20,
          totalTokens: 35,
        };
      }
      throw new Error('unexpected scenario');
    },
  );

  await runPipeline('task-two-stage');

  // Exact order: draft, then review, then proof (sequential).
  expect(callLog).toEqual([
    'pipeline_draft',
    'pipeline_review',
    'pipeline_proof',
  ]);
  expect(mockCallLLMResult).toHaveBeenCalledTimes(3);

  // proof received the REAL review text.
  const proofCall = callForScenario(
    mockCallLLMResult.mock.calls,
    'pipeline_proof',
  );
  expect(proofCall).toBeDefined();
  expect(proofCall![0][1].content).toContain('tighten ending');
  expect(proofCall![0][1].content).toContain('rewrite last paragraph');
  expect(proofCall![0][1].content).not.toContain('未能完成');

  // factCheck was skipped.
  expect(mockStore.persistTaskStage).toHaveBeenCalledWith(
    'task-two-stage',
    expect.objectContaining({ stage: 'factCheck', status: 'skipped' }),
  );
  expect(mockStore.persistCompleteTask).toHaveBeenCalledWith(
    'task-two-stage',
    'final-polished',
  );
});

test('twoStage: status transitions go drafting → reviewing → proofing (never jumps to proofing before reviewing)', async () => {
  mockCallLLMResult
    .mockResolvedValueOnce({
      text: 'd',
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    })
    .mockResolvedValueOnce({
      text: validReview(),
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    })
    .mockResolvedValueOnce({
      text: 'p',
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    });

  await runPipeline('task-two-stage-status');

  const seq = stageStatusSequence();
  const reviewIdx = seq.indexOf('reviewing');
  const proofIdx = seq.indexOf('proofing');
  expect(reviewIdx).toBeGreaterThanOrEqual(0);
  expect(proofIdx).toBeGreaterThan(reviewIdx);
});

test('twoStage: review failure skips proof and falls back to draft (SPEC §13.2)', async () => {
  mockCallLLMResult
    .mockResolvedValueOnce({
      text: 'draft-body',
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    })
    .mockRejectedValueOnce(new Error('review LLM error'));

  await runPipeline('task-two-stage-review-fail');

  // Only draft + review attempted (review rejected). proof never called.
  expect(mockCallLLMResult).toHaveBeenCalledTimes(2);
  expect(
    callForScenario(mockCallLLMResult.mock.calls, 'pipeline_proof'),
  ).toBeUndefined();
  expect(mockStore.persistTaskStage).toHaveBeenCalledWith(
    'task-two-stage-review-fail',
    expect.objectContaining({ stage: 'review', status: 'failed' }),
  );
  expect(mockStore.persistTaskStage).toHaveBeenCalledWith(
    'task-two-stage-review-fail',
    expect.objectContaining({ stage: 'proof', status: 'skipped' }),
  );
  // Degraded: retain draft without completeTask (status stays failed).
  expect(mockStore.persistFailTask).toHaveBeenCalledWith(
    'task-two-stage-review-fail',
    expect.stringContaining('已保留初稿'),
  );
  expect(mockStore.persistTaskFinalText).toHaveBeenCalledWith(
    'task-two-stage-review-fail',
    'draft-body',
  );
  expect(mockStore.persistCompleteTask).not.toHaveBeenCalled();
  expect(mockSaveDraft).toHaveBeenCalledWith(
    expect.objectContaining({ content: 'draft-body' }),
  );
});

test('twoStage: proof failure falls back to draft and marks proof failed (SPEC §13.5)', async () => {
  mockCallLLMResult
    .mockResolvedValueOnce({
      text: 'draft-body',
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
    .mockRejectedValueOnce(new Error('proof LLM error'));

  await runPipeline('task-two-stage-proof-fail');

  expect(mockCallLLMResult).toHaveBeenCalledTimes(3);
  expect(mockStore.persistTaskStage).toHaveBeenCalledWith(
    'task-two-stage-proof-fail',
    expect.objectContaining({ stage: 'proof', status: 'failed' }),
  );
  expect(mockStore.persistFailTask).toHaveBeenCalledWith(
    'task-two-stage-proof-fail',
    expect.stringMatching(/终审|proof LLM error|回退/),
  );
  expect(mockStore.persistTaskFinalText).toHaveBeenCalledWith(
    'task-two-stage-proof-fail',
    'draft-body',
  );
  expect(mockStore.persistCompleteTask).not.toHaveBeenCalled();
});

/* ============================ conditional ============================ */

test('conditional: proof starts AFTER factCheck completes and receives the real factCheckText (SPEC §5.3)', async () => {
  const callLog: string[] = [];
  mockCallLLMResult.mockImplementation(async (_m: any[], _t: any, cfg: any) => {
    callLog.push(cfg.scenario);
    if (cfg.scenario === 'pipeline_draft') {
      return {
        text: 'draft-body',
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
      };
    }
    if (cfg.scenario === 'pipeline_factcheck') {
      return {
        text: validFactCheck({ errors: ['主角当前没有银钥匙'], confirmed: [] }),
        inputTokens: 9,
        outputTokens: 6,
        totalTokens: 15,
      };
    }
    if (cfg.scenario === 'pipeline_proof') {
      return {
        text: 'final-after-factcheck',
        inputTokens: 14,
        outputTokens: 20,
        totalTokens: 34,
      };
    }
    throw new Error('unexpected scenario');
  });

  mockGetPipelineConfig.mockResolvedValue(
    baseConfig({ pipelineMode: 'conditional' }),
  );
  await runPipeline('task-conditional');

  expect(callLog).toEqual([
    'pipeline_draft',
    'pipeline_factcheck',
    'pipeline_proof',
  ]);
  const proofCall = callForScenario(
    mockCallLLMResult.mock.calls,
    'pipeline_proof',
  );
  expect(proofCall).toBeDefined();
  expect(proofCall![0][1].content).toContain('主角当前没有银钥匙');
  expect(proofCall![0][1].content).not.toContain('未能完成核查');

  expect(mockStore.persistTaskStage).toHaveBeenCalledWith(
    'task-conditional',
    expect.objectContaining({ stage: 'review', status: 'skipped' }),
  );
  expect(mockStore.persistCompleteTask).toHaveBeenCalledWith(
    'task-conditional',
    'final-after-factcheck',
  );
});

test('conditional: factCheck failure skips proof and falls back to draft (SPEC §13.3)', async () => {
  mockGetPipelineConfig.mockResolvedValue(
    baseConfig({ pipelineMode: 'conditional' }),
  );
  mockCallLLMResult
    .mockResolvedValueOnce({
      text: 'draft-body',
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    })
    .mockRejectedValueOnce(new Error('factcheck error'));

  await runPipeline('task-conditional-fail');

  expect(mockCallLLMResult).toHaveBeenCalledTimes(2);
  expect(
    callForScenario(mockCallLLMResult.mock.calls, 'pipeline_proof'),
  ).toBeUndefined();
  expect(mockStore.persistTaskStage).toHaveBeenCalledWith(
    'task-conditional-fail',
    expect.objectContaining({ stage: 'factCheck', status: 'failed' }),
  );
  expect(mockStore.persistTaskStage).toHaveBeenCalledWith(
    'task-conditional-fail',
    expect.objectContaining({ stage: 'proof', status: 'skipped' }),
  );
  expect(mockStore.persistFailTask).toHaveBeenCalledWith(
    'task-conditional-fail',
    expect.stringContaining('已保留初稿'),
  );
  expect(mockStore.persistTaskFinalText).toHaveBeenCalledWith(
    'task-conditional-fail',
    'draft-body',
  );
  expect(mockStore.persistCompleteTask).not.toHaveBeenCalled();
});

/* ============================ full ============================ */

test('full: review and factCheck run; proof receives both reports (SPEC §5.4)', async () => {
  mockGetPipelineConfig.mockResolvedValue(baseConfig({ pipelineMode: 'full' }));
  mockCallLLMResult
    .mockResolvedValueOnce({
      text: 'draft-body',
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    })
    .mockResolvedValueOnce({
      text: validReview({
        issues: ['tighten ending'],
        suggestions: ['rewrite'],
      }),
      inputTokens: 5,
      outputTokens: 4,
      totalTokens: 9,
    })
    .mockResolvedValueOnce({
      text: validFactCheck({ errors: ['主角当前没有银钥匙'], confirmed: [] }),
      inputTokens: 6,
      outputTokens: 4,
      totalTokens: 10,
    })
    .mockResolvedValueOnce({
      text: 'final',
      inputTokens: 12,
      outputTokens: 20,
      totalTokens: 32,
    });

  await runPipeline('task-full');

  expect(mockCallLLMResult).toHaveBeenCalledTimes(4);
  const proofCall = callForScenario(
    mockCallLLMResult.mock.calls,
    'pipeline_proof',
  );
  expect(proofCall).toBeDefined();
  // proof received BOTH the review and factcheck reports.
  expect(proofCall![0][1].content).toContain('tighten ending');
  expect(proofCall![0][1].content).toContain('主角当前没有银钥匙');

  expect(mockStore.persistTaskStage).toHaveBeenCalledWith(
    'task-full',
    expect.objectContaining({ stage: 'review', status: 'success' }),
  );
  expect(mockStore.persistTaskStage).toHaveBeenCalledWith(
    'task-full',
    expect.objectContaining({ stage: 'factCheck', status: 'success' }),
  );
  expect(mockStore.persistCompleteTask).toHaveBeenCalledWith(
    'task-full',
    'final',
  );
});

test('full: both audits fail → proof never called, fallback to draft (SPEC §13.4)', async () => {
  mockGetPipelineConfig.mockResolvedValue(baseConfig({ pipelineMode: 'full' }));
  mockCallLLMResult
    .mockResolvedValueOnce({
      text: 'draft-body',
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    })
    .mockRejectedValueOnce(new Error('review error'))
    .mockRejectedValueOnce(new Error('factcheck error'));

  await runPipeline('task-full-both-fail');

  // draft + review + factcheck attempted; proof NOT called.
  expect(mockCallLLMResult).toHaveBeenCalledTimes(3);
  expect(
    callForScenario(mockCallLLMResult.mock.calls, 'pipeline_proof'),
  ).toBeUndefined();
  expect(mockStore.persistTaskStage).toHaveBeenCalledWith(
    'task-full-both-fail',
    expect.objectContaining({ stage: 'proof', status: 'skipped' }),
  );
  expect(mockStore.persistFailTask).toHaveBeenCalledWith(
    'task-full-both-fail',
    expect.stringContaining('均失败'),
  );
  expect(mockStore.persistTaskFinalText).toHaveBeenCalledWith(
    'task-full-both-fail',
    'draft-body',
  );
  expect(mockStore.persistCompleteTask).not.toHaveBeenCalled();
});

test('full: single-side failure still runs proof with the surviving report (SPEC §13.4)', async () => {
  mockGetPipelineConfig.mockResolvedValue(baseConfig({ pipelineMode: 'full' }));
  mockCallLLMResult
    .mockResolvedValueOnce({
      text: 'draft-body',
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    })
    .mockRejectedValueOnce(new Error('review error'))
    .mockResolvedValueOnce({
      text: validFactCheck({ errors: ['主角当前没有银钥匙'], confirmed: [] }),
      inputTokens: 6,
      outputTokens: 4,
      totalTokens: 10,
    })
    .mockResolvedValueOnce({
      text: 'final-from-factcheck',
      inputTokens: 12,
      outputTokens: 20,
      totalTokens: 32,
    });

  await runPipeline('task-full-one-fail');

  expect(mockCallLLMResult).toHaveBeenCalledTimes(4);
  const proofCall = callForScenario(
    mockCallLLMResult.mock.calls,
    'pipeline_proof',
  );
  expect(proofCall).toBeDefined();
  // proof received the surviving factcheck report.
  expect(proofCall![0][1].content).toContain('主角当前没有银钥匙');
  expect(mockStore.persistCompleteTask).toHaveBeenCalledWith(
    'task-full-one-fail',
    'final-from-factcheck',
  );
});

test('full: review and factCheck can run in parallel (proof still waits) — timing check', async () => {
  mockGetPipelineConfig.mockResolvedValue(baseConfig({ pipelineMode: 'full' }));
  const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
  // Each audit takes 150ms. If sequential they sum to 300ms+; parallel ~150ms.
  mockCallLLMResult
    .mockImplementationOnce(async () => {
      await delay(50);
      return { text: 'draft', inputTokens: 1, outputTokens: 1, totalTokens: 2 };
    })
    .mockImplementationOnce(async () => {
      await delay(150);
      return {
        text: validReview(),
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      };
    })
    .mockImplementationOnce(async () => {
      await delay(150);
      return {
        text: validFactCheck(),
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      };
    })
    .mockImplementationOnce(async () => {
      return { text: 'final', inputTokens: 1, outputTokens: 1, totalTokens: 2 };
    });

  const start = Date.now();
  await runPipeline('task-full-parallel');
  const elapsed = Date.now() - start;
  // draft(50) + parallel audits(150) + proof(~0) ≈ 200ms. Sequential would be 350ms+.
  expect(elapsed).toBeLessThan(320);
});

/* ============================ shared config / lifecycle ============================ */

test('pipeline does not resolve until the completed draft is saved and task is completed', async () => {
  let releaseSave!: () => void;
  mockSaveDraft.mockReturnValueOnce(
    new Promise<number>(resolve => {
      releaseSave = () => resolve(1);
    }),
  );
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
      text: 'polished',
      inputTokens: 15,
      outputTokens: 20,
      totalTokens: 35,
    });

  seedTask('task-await-save');
  const { runChapterPipeline } = require('../src/services/pipelineRunner');
  let resolved = false;
  const run = runChapterPipeline('task-await-save', chapter).then(() => {
    resolved = true;
  });

  for (let i = 0; i < 200 && mockSaveDraft.mock.calls.length === 0; i += 1) {
    await Promise.resolve();
    await new Promise(r => setImmediate(r));
  }

  expect(mockSaveDraft).toHaveBeenCalledWith(
    expect.objectContaining({
      content: 'polished',
      pipelineTaskId: 'task-await-save',
      source: 'pipeline',
    }),
  );
  expect(resolved).toBe(false);
  expect(mockStore.persistCompleteTask).not.toHaveBeenCalledWith(
    'task-await-save',
    'polished',
  );

  releaseSave();
  await run;

  expect(resolved).toBe(true);
  expect(mockStore.persistCompleteTask).toHaveBeenCalledWith(
    'task-await-save',
    'polished',
  );
});

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

  for (let i = 0; i < 30 && !releaseDraft; i += 1) {
    await Promise.resolve();
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

test('pipeline defaults to non-streaming draft generation and reuses one LLM request config', async () => {
  const llmRequestConfig = {
    id: 7,
    name: 'shared',
    url: 'https://api.example/v1/chat/completions',
    api_key: 'sk-shared',
    model_name: 'shared-model',
    provider_type: 'openai_compatible' as const,
    context_window: 128000,
    max_output_tokens: 8000,
  };
  mockResolveLLMRequestConfig.mockResolvedValue(llmRequestConfig);
  mockCallLLMResult
    .mockResolvedValueOnce({
      text: 'draft-non-stream',
      inputTokens: 11,
      outputTokens: 22,
      totalTokens: 33,
    })
    .mockResolvedValueOnce({
      text: validReview(),
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    })
    .mockResolvedValueOnce({
      text: 'polished',
      inputTokens: 15,
      outputTokens: 25,
      totalTokens: 40,
    });

  await runPipeline('task-non-stream-default');

  // Reconcile may resolve credentials more than once (snapshot + stages).
  expect(mockResolveLLMRequestConfig).toHaveBeenCalled();
  expect(mockCallLLMResult).toHaveBeenCalledTimes(3);
  const draftStageCall = mockStore.persistTaskStage.mock.calls.find(
    (c: any[]) => c[1]?.stage === 'draft',
  );
  expect(draftStageCall?.[1]?.text).toBe('draft-non-stream');
  expect(draftStageCall?.[1]?.tokens).toEqual({
    input: 11,
    output: 22,
    total: 33,
    reasoning: 0,
    visible: 22,
  });
  for (const call of mockCallLLMResult.mock.calls) {
    // Identity may be a frozen/rebuilt config object; fields must match.
    expect(call[2]?.requestConfig).toEqual(
      expect.objectContaining({
        id: llmRequestConfig.id,
        model_name: llmRequestConfig.model_name,
        context_window: llmRequestConfig.context_window,
      }),
    );
  }
  expect(mockStore.persistCompleteTask).toHaveBeenCalledWith(
    'task-non-stream-default',
    'polished',
  );
});

test('twoStage proof stage tokens and duration are recorded (SPEC §20.8)', async () => {
  mockCallLLMResult
    .mockResolvedValueOnce({
      text: 'd',
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    })
    .mockResolvedValueOnce({
      text: validReview(),
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    })
    .mockResolvedValueOnce({
      text: 'p',
      inputTokens: 30,
      outputTokens: 40,
      totalTokens: 70,
    });

  await runPipeline('task-tokens');

  const proofStage = mockStore.persistTaskStage.mock.calls.find(
    (c: any[]) => c[1]?.stage === 'proof' && c[1]?.status === 'success',
  );
  expect(proofStage?.[1]?.tokens).toEqual({ input: 30, output: 40, total: 70 });
  expect(proofStage?.[1]?.durationMs).toEqual(expect.any(Number));
});

/* ============================ audit validity ============================ */

const NOVEL_BODY = `${'夜色笼罩古城。'.repeat(
  80,
)}主角拔剑走向城门，风沙扑面。${'远处传来钟声。'.repeat(40)}`;

test('twoStage: review returns full novel body → one repair retry → still invalid → proof skipped', async () => {
  let reviewCalls = 0;
  mockCallLLMResult.mockImplementation(async (_m: any[], _t: any, cfg: any) => {
    if (cfg.scenario === 'pipeline_draft') {
      return {
        text: NOVEL_BODY,
        inputTokens: 10,
        outputTokens: 200,
        totalTokens: 210,
      };
    }
    if (cfg.scenario === 'pipeline_review') {
      reviewCalls += 1;
      // Always return the full draft body — never a valid report.
      return {
        text: NOVEL_BODY,
        inputTokens: 5,
        outputTokens: 200,
        totalTokens: 205,
      };
    }
    throw new Error(`unexpected scenario ${cfg.scenario}`);
  });

  await runPipeline('task-review-novel');

  expect(reviewCalls).toBe(2); // first + one repair only
  expect(
    callForScenario(mockCallLLMResult.mock.calls, 'pipeline_proof'),
  ).toBeUndefined();
  expect(mockStore.persistTaskStage).toHaveBeenCalledWith(
    'task-review-novel',
    expect.objectContaining({
      stage: 'review',
      status: 'failed',
      text: '',
    }),
  );
  expect(mockStore.persistTaskStage).toHaveBeenCalledWith(
    'task-review-novel',
    expect.objectContaining({ stage: 'proof', status: 'skipped' }),
  );
  expect(mockStore.persistFailTask).toHaveBeenCalled();
  expect(mockStore.persistTaskFinalText).toHaveBeenCalledWith(
    'task-review-novel',
    NOVEL_BODY,
  );
  expect(mockStore.persistCompleteTask).not.toHaveBeenCalled();
});

test('twoStage: first review invalid, second repair valid → proof runs with normalized report', async () => {
  let reviewCalls = 0;
  mockCallLLMResult.mockImplementation(
    async (messages: any[], _t: any, cfg: any) => {
      if (cfg.scenario === 'pipeline_draft') {
        return {
          text: 'draft-body-short',
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
        };
      }
      if (cfg.scenario === 'pipeline_review') {
        reviewCalls += 1;
        expect(cfg.responseFormat).toBe('json_object');
        if (reviewCalls === 1) {
          return {
            text:
              '这是一整段胡乱复述的正文，完全不是 JSON。' +
              '多余文字。'.repeat(30),
            inputTokens: 5,
            outputTokens: 40,
            totalTokens: 45,
          };
        }
        // Repair must not re-inject the full invalid body.
        const joined = messages.map((m: any) => m.content).join('\n');
        expect(joined).not.toContain('胡乱复述的正文'.repeat(2));
        return {
          text: validReview({
            issues: ['节奏偏慢'],
            suggestions: ['压缩开场'],
          }),
          inputTokens: 6,
          outputTokens: 8,
          totalTokens: 14,
        };
      }
      if (cfg.scenario === 'pipeline_proof') {
        return {
          text: 'final-after-repair',
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
        };
      }
      throw new Error(`unexpected ${cfg.scenario}`);
    },
  );

  await runPipeline('task-review-repair');

  expect(reviewCalls).toBe(2);
  const proofCall = callForScenario(
    mockCallLLMResult.mock.calls,
    'pipeline_proof',
  );
  expect(proofCall![0][1].content).toContain('节奏偏慢');
  expect(mockStore.persistTaskStage).toHaveBeenCalledWith(
    'task-review-repair',
    expect.objectContaining({ stage: 'review', status: 'success' }),
  );
  expect(mockStore.persistCompleteTask).toHaveBeenCalledWith(
    'task-review-repair',
    'final-after-repair',
  );
});

test('twoStage: reasoning-only review fails without proof', async () => {
  mockCallLLMResult
    .mockResolvedValueOnce({
      text: 'draft-body',
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    })
    .mockResolvedValueOnce({
      text: null,
      reasoningText: '我先思考情节逻辑……' + '推理'.repeat(50),
      inputTokens: 5,
      outputTokens: 40,
      totalTokens: 45,
    })
    .mockResolvedValueOnce({
      text: null,
      reasoningText: '再次推理仍无 content',
      inputTokens: 5,
      outputTokens: 10,
      totalTokens: 15,
    });

  await runPipeline('task-review-reasoning');

  expect(
    callForScenario(mockCallLLMResult.mock.calls, 'pipeline_proof'),
  ).toBeUndefined();
  expect(mockStore.persistTaskStage).toHaveBeenCalledWith(
    'task-review-reasoning',
    expect.objectContaining({
      stage: 'review',
      status: 'failed',
      text: '',
      error: expect.stringContaining('推理'),
    }),
  );
  expect(mockStore.persistFailTask).toHaveBeenCalledWith(
    'task-review-reasoning',
    expect.stringContaining('已保留初稿'),
  );
  expect(mockStore.persistTaskFinalText).toHaveBeenCalledWith(
    'task-review-reasoning',
    'draft-body',
  );
  expect(mockStore.persistCompleteTask).not.toHaveBeenCalled();
});

test('conditional: factCheck draft echo twice → proof skipped, keeps draft', async () => {
  mockGetPipelineConfig.mockResolvedValue(
    baseConfig({ pipelineMode: 'conditional' }),
  );
  let fcCalls = 0;
  mockCallLLMResult.mockImplementation(async (_m: any[], _t: any, cfg: any) => {
    if (cfg.scenario === 'pipeline_draft') {
      return {
        text: NOVEL_BODY,
        inputTokens: 10,
        outputTokens: 200,
        totalTokens: 210,
      };
    }
    if (cfg.scenario === 'pipeline_factcheck') {
      fcCalls += 1;
      expect(cfg.responseFormat).toBe('json_object');
      return {
        text: NOVEL_BODY,
        inputTokens: 5,
        outputTokens: 200,
        totalTokens: 205,
      };
    }
    throw new Error(`unexpected ${cfg.scenario}`);
  });

  await runPipeline('task-fc-echo');

  expect(fcCalls).toBe(2);
  expect(
    callForScenario(mockCallLLMResult.mock.calls, 'pipeline_proof'),
  ).toBeUndefined();
  expect(mockStore.persistTaskStage).toHaveBeenCalledWith(
    'task-fc-echo',
    expect.objectContaining({ stage: 'factCheck', status: 'failed', text: '' }),
  );
  expect(mockStore.persistFailTask).toHaveBeenCalled();
  expect(mockStore.persistTaskFinalText).toHaveBeenCalledWith(
    'task-fc-echo',
    NOVEL_BODY,
  );
  expect(mockStore.persistCompleteTask).not.toHaveBeenCalled();
});

test('full: both audits return novel body → proof never called', async () => {
  mockGetPipelineConfig.mockResolvedValue(baseConfig({ pipelineMode: 'full' }));
  mockCallLLMResult.mockImplementation(async (_m: any[], _t: any, cfg: any) => {
    if (cfg.scenario === 'pipeline_draft') {
      return {
        text: NOVEL_BODY,
        inputTokens: 10,
        outputTokens: 200,
        totalTokens: 210,
      };
    }
    if (
      cfg.scenario === 'pipeline_review' ||
      cfg.scenario === 'pipeline_factcheck'
    ) {
      return {
        text: NOVEL_BODY,
        inputTokens: 5,
        outputTokens: 200,
        totalTokens: 205,
      };
    }
    throw new Error(`proof must not run: ${cfg.scenario}`);
  });

  await runPipeline('task-full-both-novel');

  expect(
    callForScenario(mockCallLLMResult.mock.calls, 'pipeline_proof'),
  ).toBeUndefined();
  expect(mockStore.persistTaskStage).toHaveBeenCalledWith(
    'task-full-both-novel',
    expect.objectContaining({ stage: 'proof', status: 'skipped' }),
  );
  expect(mockStore.persistFailTask).toHaveBeenCalledWith(
    'task-full-both-novel',
    expect.stringContaining('均失败'),
  );
  expect(mockStore.persistTaskFinalText).toHaveBeenCalledWith(
    'task-full-both-novel',
    NOVEL_BODY,
  );
  expect(mockStore.persistCompleteTask).not.toHaveBeenCalled();
});

test('full: review valid + factCheck novel → proof only receives review', async () => {
  mockGetPipelineConfig.mockResolvedValue(baseConfig({ pipelineMode: 'full' }));
  mockCallLLMResult.mockImplementation(async (_m: any[], _t: any, cfg: any) => {
    if (cfg.scenario === 'pipeline_draft') {
      return {
        text: NOVEL_BODY,
        inputTokens: 10,
        outputTokens: 200,
        totalTokens: 210,
      };
    }
    if (cfg.scenario === 'pipeline_review') {
      return {
        text: validReview({ issues: ['开场略慢'], suggestions: ['加快节奏'] }),
        inputTokens: 5,
        outputTokens: 8,
        totalTokens: 13,
      };
    }
    if (cfg.scenario === 'pipeline_factcheck') {
      return {
        text: NOVEL_BODY,
        inputTokens: 5,
        outputTokens: 200,
        totalTokens: 205,
      };
    }
    if (cfg.scenario === 'pipeline_proof') {
      return {
        text: 'final-from-review-only',
        inputTokens: 12,
        outputTokens: 20,
        totalTokens: 32,
      };
    }
    throw new Error(`unexpected ${cfg.scenario}`);
  });

  await runPipeline('task-full-one-novel');

  const proofCall = callForScenario(
    mockCallLLMResult.mock.calls,
    'pipeline_proof',
  );
  expect(proofCall).toBeDefined();
  expect(proofCall![0][1].content).toContain('开场略慢');
  expect(proofCall![0][1].content).toContain('本次未提供有效事实核查');
  // Fact-check section must be the empty placeholder, not a pasted novel report.
  // (Draft body still appears under 【初稿】, which is correct.)
  const factSection = proofCall![0][1].content.split('【事实核查】')[1] || '';
  expect(factSection).toContain('本次未提供有效事实核查');
  expect(factSection).not.toContain('主角拔剑走向城门');
  expect(mockStore.persistTaskStage).toHaveBeenCalledWith(
    'task-full-one-novel',
    expect.objectContaining({ stage: 'factCheck', status: 'failed', text: '' }),
  );
  expect(mockStore.persistCompleteTask).toHaveBeenCalledWith(
    'task-full-one-novel',
    'final-from-review-only',
  );
});

test('proof: empty content with reasoningText fails and falls back to draft', async () => {
  mockCallLLMResult
    .mockResolvedValueOnce({
      text: 'draft-body',
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    })
    .mockResolvedValueOnce({
      text: validReview(),
      inputTokens: 5,
      outputTokens: 5,
      totalTokens: 10,
    })
    .mockResolvedValueOnce({
      text: null,
      reasoningText: '我先规划如何改写……',
      inputTokens: 8,
      outputTokens: 30,
      totalTokens: 38,
    });

  await runPipeline('task-proof-reasoning');

  expect(mockStore.persistTaskStage).toHaveBeenCalledWith(
    'task-proof-reasoning',
    expect.objectContaining({
      stage: 'proof',
      status: 'failed',
      text: 'draft-body',
      error: expect.stringContaining('推理'),
    }),
  );
  expect(mockStore.persistFailTask).toHaveBeenCalledWith(
    'task-proof-reasoning',
    expect.stringContaining('推理'),
  );
  expect(mockStore.persistTaskFinalText).toHaveBeenCalledWith(
    'task-proof-reasoning',
    'draft-body',
  );
  expect(mockStore.persistCompleteTask).not.toHaveBeenCalled();
});

test('review stage only persists normalizedText after validation, never raw invalid body', async () => {
  mockCallLLMResult
    .mockResolvedValueOnce({
      text: 'draft-body',
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    })
    .mockResolvedValueOnce({
      text: '```json\n' + validReview({ issues: ['用词重复'] }) + '\n```',
      inputTokens: 5,
      outputTokens: 8,
      totalTokens: 13,
    })
    .mockResolvedValueOnce({
      text: 'final',
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    });

  await runPipeline('task-normalized');

  const reviewStage = mockStore.persistTaskStage.mock.calls.find(
    (c: any[]) => c[1]?.stage === 'review' && c[1]?.status === 'success',
  );
  expect(reviewStage?.[1]?.text).toBe(validReview({ issues: ['用词重复'] }));
  expect(reviewStage?.[1]?.text).not.toContain('```');
});

test('twoStage: truncated JSON then repair success → proof runs', async () => {
  let reviewCalls = 0;
  mockCallLLMResult.mockImplementation(async (_m: any[], _t: any, cfg: any) => {
    if (cfg.scenario === 'pipeline_draft') {
      return {
        text: 'draft-body',
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
      };
    }
    if (cfg.scenario === 'pipeline_review') {
      reviewCalls += 1;
      if (reviewCalls === 1) {
        return {
          text: '{"strengths":["a"],"issues":["b"],"suggestions":',
          finishReason: 'length',
          inputTokens: 5,
          outputTokens: 10,
          totalTokens: 15,
        };
      }
      return {
        text: validReview({
          issues: ['补全后的问题'],
          suggestions: ['补建议'],
        }),
        inputTokens: 5,
        outputTokens: 8,
        totalTokens: 13,
      };
    }
    if (cfg.scenario === 'pipeline_proof') {
      return {
        text: 'final-after-truncated-repair',
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
      };
    }
    throw new Error(cfg.scenario);
  });

  await runPipeline('task-truncated-repair');

  expect(reviewCalls).toBe(2);
  const proofCall = callForScenario(
    mockCallLLMResult.mock.calls,
    'pipeline_proof',
  );
  expect(proofCall![0][1].content).toContain('补全后的问题');
  expect(mockStore.persistCompleteTask).toHaveBeenCalledWith(
    'task-truncated-repair',
    'final-after-truncated-repair',
  );
});

test('twoStage: two empty contents → at most one retry then fail, no third call', async () => {
  let reviewCalls = 0;
  mockCallLLMResult.mockImplementation(async (_m: any[], _t: any, cfg: any) => {
    if (cfg.scenario === 'pipeline_draft') {
      return {
        text: 'draft-body',
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      };
    }
    if (cfg.scenario === 'pipeline_review') {
      reviewCalls += 1;
      return {
        text: null,
        reasoningText: null,
        inputTokens: 1,
        outputTokens: 0,
        totalTokens: 1,
      };
    }
    throw new Error(`unexpected ${cfg.scenario}`);
  });

  await runPipeline('task-empty-twice');

  expect(reviewCalls).toBe(2);
  expect(
    callForScenario(mockCallLLMResult.mock.calls, 'pipeline_proof'),
  ).toBeUndefined();
  expect(mockStore.persistTaskStage).toHaveBeenCalledWith(
    'task-empty-twice',
    expect.objectContaining({
      stage: 'review',
      status: 'failed',
      error: expect.stringMatching(/空|empty/i),
    }),
  );
});

test('full: review novel body + factCheck valid → proof only receives factCheck', async () => {
  mockGetPipelineConfig.mockResolvedValue(baseConfig({ pipelineMode: 'full' }));
  mockCallLLMResult.mockImplementation(async (_m: any[], _t: any, cfg: any) => {
    if (cfg.scenario === 'pipeline_draft') {
      return {
        text: NOVEL_BODY,
        inputTokens: 10,
        outputTokens: 200,
        totalTokens: 210,
      };
    }
    if (cfg.scenario === 'pipeline_review') {
      return {
        text: NOVEL_BODY,
        inputTokens: 5,
        outputTokens: 200,
        totalTokens: 205,
      };
    }
    if (cfg.scenario === 'pipeline_factcheck') {
      return {
        text: validFactCheck({ errors: ['银钥匙归属错误'], confirmed: [] }),
        inputTokens: 6,
        outputTokens: 8,
        totalTokens: 14,
      };
    }
    if (cfg.scenario === 'pipeline_proof') {
      return {
        text: 'final-from-fc-only',
        inputTokens: 12,
        outputTokens: 20,
        totalTokens: 32,
      };
    }
    throw new Error(cfg.scenario);
  });

  await runPipeline('task-full-review-novel');

  const proofCall = callForScenario(
    mockCallLLMResult.mock.calls,
    'pipeline_proof',
  );
  expect(proofCall![0][1].content).toContain('银钥匙归属错误');
  expect(proofCall![0][1].content).toContain('本次未提供有效文学评估');
  expect(mockStore.persistTaskStage).toHaveBeenCalledWith(
    'task-full-review-novel',
    expect.objectContaining({ stage: 'review', status: 'failed', text: '' }),
  );
});

test('full: one side reasoning-only fails that side only', async () => {
  mockGetPipelineConfig.mockResolvedValue(baseConfig({ pipelineMode: 'full' }));
  mockCallLLMResult.mockImplementation(async (_m: any[], _t: any, cfg: any) => {
    if (cfg.scenario === 'pipeline_draft') {
      return {
        text: 'draft-body',
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
      };
    }
    if (cfg.scenario === 'pipeline_review') {
      return {
        text: null,
        reasoningText: '只推理不输出 JSON',
        finishReason: 'length',
        inputTokens: 5,
        outputTokens: 20,
        totalTokens: 25,
      };
    }
    if (cfg.scenario === 'pipeline_factcheck') {
      return {
        text: validFactCheck({ errors: ['时间线冲突'], confirmed: [] }),
        inputTokens: 6,
        outputTokens: 8,
        totalTokens: 14,
      };
    }
    if (cfg.scenario === 'pipeline_proof') {
      return {
        text: 'final-fc-only',
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
      };
    }
    throw new Error(cfg.scenario);
  });

  await runPipeline('task-full-reasoning-side');

  // review first + one reasoning-directed retry = 2, factcheck 1, proof 1 (+draft)
  const reviewCalls = mockCallLLMResult.mock.calls.filter(
    (c: any[]) => c[2]?.scenario === 'pipeline_review',
  );
  expect(reviewCalls.length).toBe(2);
  // The retry must request disabled thinking + a doubled budget clamped to
  // the model ceiling (reviewMaxTokens 1500 → 3000; max_output_tokens 8000).
  expect(reviewCalls[1][2].thinking).toEqual({ type: 'disabled' });
  expect(reviewCalls[1][2].max_tokens).toBe(3000);
  expect(
    callForScenario(mockCallLLMResult.mock.calls, 'pipeline_proof'),
  ).toBeDefined();
  expect(mockStore.persistTaskStage).toHaveBeenCalledWith(
    'task-full-reasoning-side',
    expect.objectContaining({
      stage: 'review',
      status: 'failed',
      // Reasoning-only failure now surfaces an actionable hint rather than the
      // vague "返回格式无效" label.
      error: expect.stringContaining('推理'),
    }),
  );
  expect(mockStore.persistTaskStage).toHaveBeenCalledWith(
    'task-full-reasoning-side',
    expect.objectContaining({
      stage: 'review',
      status: 'failed',
      error: expect.stringContaining('max_tokens'),
    }),
  );
  expect(mockStore.persistCompleteTask).toHaveBeenCalledWith(
    'task-full-reasoning-side',
    'final-fc-only',
  );
});

test('review reasoning-only → thinking-disabled retry succeeds', async () => {
  mockCallLLMResult.mockImplementation(async (_m: any[], _t: any, cfg: any) => {
    if (cfg.scenario === 'pipeline_draft') {
      return {
        text: 'draft-body',
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
      };
    }
    if (cfg.scenario === 'pipeline_review') {
      // First call: provider explicitly reports length after reasoning.
      if (cfg.thinking === undefined) {
        return {
          text: null,
          reasoningText: '我先评估情节与人物弧光……'.repeat(40),
          emptyReason: 'reasoning_only',
          finishReason: 'length',
          inputTokens: 5,
          outputTokens: 1500,
          totalTokens: 1505,
        };
      }
      // Retry with thinking disabled → model emits the JSON report directly.
      return {
        text: validReview({
          strengths: ['人物动机清晰'],
          issues: ['中段节奏稍快'],
          suggestions: ['可在转折前增加铺垫'],
        }),
        inputTokens: 6,
        outputTokens: 60,
        totalTokens: 66,
      };
    }
    if (cfg.scenario === 'pipeline_proof') {
      return {
        text: 'final-from-retry-review',
        inputTokens: 12,
        outputTokens: 20,
        totalTokens: 32,
      };
    }
    throw new Error(cfg.scenario);
  });

  await runPipeline('task-review-reasoning-retry');

  const reviewCalls = mockCallLLMResult.mock.calls.filter(
    (c: any[]) => c[2]?.scenario === 'pipeline_review',
  );
  expect(reviewCalls.length).toBe(2);
  expect(reviewCalls[1][2].thinking).toEqual({ type: 'disabled' });
  expect(reviewCalls[1][2].max_tokens).toBe(3000);
  expect(mockStore.persistTaskStage).toHaveBeenCalledWith(
    'task-review-reasoning-retry',
    expect.objectContaining({
      stage: 'review',
      status: 'success',
      text: expect.stringContaining('人物动机清晰'),
    }),
  );
});

test('factCheck reasoning-only → thinking-disabled retry succeeds', async () => {
  mockGetPipelineConfig.mockResolvedValue(baseConfig({ pipelineMode: 'full' }));
  mockCallLLMResult.mockImplementation(async (_m: any[], _t: any, cfg: any) => {
    if (cfg.scenario === 'pipeline_draft') {
      return {
        text: 'draft-body',
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
      };
    }
    if (cfg.scenario === 'pipeline_review') {
      return {
        text: validReview({ strengths: ['ok'] }),
        inputTokens: 5,
        outputTokens: 40,
        totalTokens: 45,
      };
    }
    if (cfg.scenario === 'pipeline_factcheck') {
      if (cfg.thinking === undefined) {
        return {
          text: null,
          reasoningText: '核验时间线与设定……'.repeat(40),
          emptyReason: 'reasoning_only',
          finishReason: 'length',
          inputTokens: 5,
          outputTokens: 1500,
          totalTokens: 1505,
        };
      }
      return {
        text: validFactCheck({
          errors: ['第3章银钥匙归属与前文矛盾'],
          confirmed: ['主角动机一致'],
        }),
        inputTokens: 6,
        outputTokens: 50,
        totalTokens: 56,
      };
    }
    if (cfg.scenario === 'pipeline_proof') {
      return {
        text: 'final-from-retry-fc',
        inputTokens: 12,
        outputTokens: 20,
        totalTokens: 32,
      };
    }
    throw new Error(cfg.scenario);
  });

  await runPipeline('task-fc-reasoning-retry');

  const fcCalls = mockCallLLMResult.mock.calls.filter(
    (c: any[]) => c[2]?.scenario === 'pipeline_factcheck',
  );
  expect(fcCalls.length).toBe(2);
  expect(fcCalls[1][2].thinking).toEqual({ type: 'disabled' });
  expect(fcCalls[1][2].max_tokens).toBe(3000);
  expect(mockStore.persistTaskStage).toHaveBeenCalledWith(
    'task-fc-reasoning-retry',
    expect.objectContaining({
      stage: 'factCheck',
      status: 'success',
      text: expect.stringContaining('银钥匙归属'),
    }),
  );
});

test('audit failure path does not fire success notifyComplete', async () => {
  const {
    PipelineForeground,
  } = require('../src/native/PipelineForegroundModule');
  mockCallLLMResult
    .mockResolvedValueOnce({
      text: 'draft-body',
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    })
    .mockResolvedValueOnce({
      text: null,
      reasoningText: 'x',
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    })
    .mockResolvedValueOnce({
      text: null,
      reasoningText: 'y',
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    });

  await runPipeline('task-no-success-notify');

  expect(PipelineForeground.notifyFailed).toHaveBeenCalled();
  expect(PipelineForeground.notifyComplete).not.toHaveBeenCalled();
  expect(mockStore.persistCompleteTask).not.toHaveBeenCalled();
  expect(mockStore.persistTaskFinalText).toHaveBeenCalledWith(
    'task-no-success-notify',
    'draft-body',
  );
  // Progress text must say 已保留初稿, never 已完成.
  expect(PipelineForeground.updateProgress).toHaveBeenCalledWith(
    'task-no-success-notify',
    '已保留初稿',
    100,
  );
  expect(PipelineForeground.updateProgress).not.toHaveBeenCalledWith(
    'task-no-success-notify',
    '已完成',
    100,
  );
});

test('proof empty content keeps failed and does not completeTask', async () => {
  const {
    PipelineForeground,
  } = require('../src/native/PipelineForegroundModule');
  mockCallLLMResult
    .mockResolvedValueOnce({
      text: 'draft-body',
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    })
    .mockResolvedValueOnce({
      text: validReview(),
      inputTokens: 5,
      outputTokens: 5,
      totalTokens: 10,
    })
    .mockResolvedValueOnce({
      text: '   ',
      reasoningText: null,
      inputTokens: 8,
      outputTokens: 0,
      totalTokens: 8,
    });

  await runPipeline('task-proof-empty');

  expect(mockStore.persistTaskStage).toHaveBeenCalledWith(
    'task-proof-empty',
    expect.objectContaining({
      stage: 'proof',
      status: 'failed',
      error: expect.stringContaining('空'),
    }),
  );
  expect(mockStore.persistFailTask).toHaveBeenCalled();
  expect(mockStore.persistTaskFinalText).toHaveBeenCalledWith(
    'task-proof-empty',
    'draft-body',
  );
  expect(mockStore.persistCompleteTask).not.toHaveBeenCalled();
  expect(PipelineForeground.notifyComplete).not.toHaveBeenCalled();
  expect(PipelineForeground.notifyFailed).toHaveBeenCalled();
});

test('success path still calls completeTask and notifyComplete', async () => {
  const {
    PipelineForeground,
  } = require('../src/native/PipelineForegroundModule');
  mockCallLLMResult
    .mockResolvedValueOnce({
      text: 'draft-ok',
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    })
    .mockResolvedValueOnce({
      text: validReview(),
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    })
    .mockResolvedValueOnce({
      text: 'final-ok',
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    });

  await runPipeline('task-success-ok');

  expect(mockStore.persistCompleteTask).toHaveBeenCalledWith(
    'task-success-ok',
    'final-ok',
  );
  expect(PipelineForeground.notifyComplete).toHaveBeenCalled();
  expect(PipelineForeground.updateProgress).toHaveBeenCalledWith(
    'task-success-ok',
    '已完成',
    100,
  );
});
