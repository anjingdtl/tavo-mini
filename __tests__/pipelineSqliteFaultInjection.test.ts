/**
 * Real-ish SQLite fault injection for pipeline seal:
 * checkpoint CAS / query failures must never call the model.
 *
 * Uses repository mocks that behave like Schema 39 fail-closed paths while
 * tracking LLM call counts across reconcile restarts.
 */
import type { Chapter } from '../src/types/novel';

const llmCalls: Array<{ scenario: string }> = [];
const mockCallLLMResult = jest.fn(
  async (_m: any, _t: any, cfg: any, _signal?: any) => {
    llmCalls.push({ scenario: cfg?.scenario || 'unknown' });
    return {
      text: `body-for-${cfg?.scenario}`,
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    };
  },
);

const checkpointState = new Map<string, any>();

function key(taskId: string, stage: string) {
  return `${taskId}::${stage}`;
}

const mockEnsure = jest.fn(async (taskId: string, stages: string[]) => {
  for (const stage of stages) {
    const k = key(taskId, stage);
    if (!checkpointState.has(k)) {
      checkpointState.set(k, {
        taskId,
        stage,
        status: 'pending',
        outputText: null,
        attemptCount: 0,
        updatedAt: Date.now(),
      });
    }
  }
});

const mockGetAll = jest.fn(async (taskId: string) => {
  return [...checkpointState.values()].filter(r => r.taskId === taskId);
});

const mockGetOne = jest.fn(async (taskId: string, stage: string) => {
  return checkpointState.get(key(taskId, stage)) || null;
});

const mockClaim = jest.fn(async (taskId: string, stage: string) => {
  const k = key(taskId, stage);
  const row = checkpointState.get(k);
  if (!row) {
    checkpointState.set(k, {
      taskId,
      stage,
      status: 'running',
      outputText: null,
      attemptCount: 1,
      updatedAt: Date.now(),
    });
    return true;
  }
  if (row.status === 'pending' || row.status === 'interrupted') {
    row.status = 'running';
    row.attemptCount = (row.attemptCount || 0) + 1;
    row.updatedAt = Date.now();
    return true;
  }
  return false;
});

const mockUpsert = jest.fn(async (params: any) => {
  const k = key(params.taskId, params.stage);
  const prev = checkpointState.get(k) || {
    taskId: params.taskId,
    stage: params.stage,
    attemptCount: 0,
  };
  checkpointState.set(k, {
    ...prev,
    status: params.status,
    outputText: params.outputText ?? prev.outputText ?? null,
    errorMessage: params.errorMessage ?? null,
    errorCode: params.errorCode ?? null,
    inputTokens: params.inputTokens ?? null,
    outputTokens: params.outputTokens ?? null,
    totalTokens: params.totalTokens ?? null,
    durationMs: params.durationMs ?? null,
    startedAt: params.startedAt ?? prev.startedAt ?? null,
    updatedAt: Date.now(),
  });
});

jest.mock('../src/services/database', () => ({
  getPipelineConfig: jest.fn(async () => ({
    pipelineMode: 'noReview',
    draftPresetId: null,
    reviewPresetId: null,
    factCheckPresetId: null,
    proofPresetId: null,
    draftMaxTokens: 1000,
    reviewMaxTokens: 500,
    factCheckMaxTokens: 500,
    proofMaxTokens: 1000,
  })),
  getContextConfig: jest.fn(async () => ({
    strategy: 'sliding',
    slidingWindowSize: 1000,
    customRangeStart: 0,
    customRangeEnd: -1,
    resourceBudget: 0,
    includeResources: false,
  })),
  getPresetsByProject: jest.fn(async () => []),
  getActiveLLMConfig: jest.fn(async () => ({
    id: 1,
    context_window: 128000,
    max_output_tokens: 8000,
  })),
  getProjectById: jest.fn(async () => ({ id: 1, mode: 'freeform' })),
  getChaptersByProject: jest.fn(async () => []),
  getCharactersByProject: jest.fn(async () => []),
  getWorldbookEntriesByProject: jest.fn(async () => []),
  ensurePendingCheckpoints: (taskId: string, stages: string[]) =>
    mockEnsure(taskId, stages),
  getStageCheckpoints: (taskId: string) => mockGetAll(taskId),
  getStageCheckpoint: (taskId: string, stage: string) =>
    mockGetOne(taskId, stage),
  claimStageCheckpoint: (taskId: string, stage: string) =>
    mockClaim(taskId, stage),
  upsertStageCheckpoint: (params: any) => mockUpsert(params),
  savePipelineTask: jest.fn(async () => undefined),
  interruptAllRunningStages: jest.fn(async () => 0),
}));

// Phase 3: attempt persistence is covered by the dedicated repository tests;
// fault-injection runs keep attempt writes inert.
jest.mock('../src/data/repositories/pipelineStageAttemptRepository', () => ({
  createStageAttempt: jest.fn(async () => undefined),
  updateStageAttempt: jest.fn(async () => undefined),
  getStageAttempts: jest.fn(async () => []),
  getLatestStageAttempt: jest.fn(async () => null),
  getStageAttempt: jest.fn(async () => null),
  getRetryDueAttempts: jest.fn(async () => []),
}));

jest.mock('../src/services/llm', () => ({
  callLLMResult: (messages: any, maxTokens: any, config: any, signal?: any) =>
    mockCallLLMResult(messages, maxTokens, config, signal),
  resolveLLMRequestConfig: jest.fn(async () => ({
    id: 1,
    name: 'm',
    url: 'https://example.com/v1/chat/completions',
    api_key: 'sk',
    model_name: 'model-a',
    provider_type: 'openai_compatible',
    context_window: 128000,
    max_output_tokens: 8000,
  })),
  resolveLLMRequestConfigById: jest.fn(async () => ({
    id: 1,
    name: 'm',
    url: 'https://example.com/v1/chat/completions',
    api_key: 'sk',
    model_name: 'model-a',
    provider_type: 'openai_compatible',
    context_window: 128000,
    max_output_tokens: 8000,
  })),
}));

jest.mock('../src/services/draftService', () => ({
  saveDraft: jest.fn(async () => 1),
}));

jest.mock('../src/services/draftPipelineCompiler', () => ({
  compileDraftPipelineRequest: jest.fn(async () => ({
    messages: [{ role: 'system', content: 'FROZEN_MSG' }],
    baseContext: [],
    pipelineContext: {
      presetText: '',
      storyMemoryText: '',
      characterText: '',
      noteText: '',
      worldbookText: '',
      episodicMemoryText: '',
      recentBridgeText: '',
      currentInstructionText: '',
      retrievalUserPrompt: 'u',
      outlineText: '',
      outlineFingerprint: '',
      outlineIds: [],
      outlineComplete: true,
      outlineEstimatedTokens: 0,
      projectId: 1,
      chapterId: 1,
    },
    estimatedInputTokens: 10,
    reservedOutputTokens: 1000,
    safetyMargin: 512,
    contextWindow: 128000,
    fits: true,
    blockingReason: null,
    chapterTitle: 'c1',
    prevEnding: '',
    userPrompt: 'u',
    draftPreset: null,
    requestConfig: {
      id: 1,
      context_window: 128000,
      provider_type: 'openai_compatible',
      api_key: 'sk',
      model_name: 'model-a',
      url: 'https://example.com/v1/chat/completions',
    },
    trace: [],
  })),
}));

const mockStore: any = {
  tasks: [] as any[],
  setTaskStatus: jest.fn((id: string, status: string) => {
    const t = mockStore.tasks.find((x: any) => x.id === id);
    if (t) t.status = status;
  }),
  updateTaskStage: jest.fn(),
  persistTaskStage: jest.fn(async (id: string, result: any) => {
    const t = mockStore.tasks.find((x: any) => x.id === id);
    if (!t) throw new Error('missing task');
    // Mirror store → also write checkpoint (Schema 39 authority).
    await mockUpsert({
      taskId: id,
      stage: result.stage,
      status:
        result.status === 'success'
          ? 'succeeded'
          : result.status === 'skipped'
            ? 'skipped'
            : 'failed',
      outputText: result.text,
      errorMessage: result.error,
    });
    t.stageResults = [
      ...(t.stageResults || []).filter((s: any) => s.stage !== result.stage),
      result,
    ];
  }),
  persistTaskStatus: jest.fn(async (id: string, status: string) => {
    mockStore.setTaskStatus(id, status);
  }),
  completeTask: jest.fn(),
  persistCompleteTask: jest.fn(async (id: string, finalText: string) => {
    const t = mockStore.tasks.find((x: any) => x.id === id);
    if (t) {
      t.status = 'completed';
      t.finalText = finalText;
    }
  }),
  setTaskFinalText: jest.fn(),
  persistTaskFinalText: jest.fn(async (id: string, finalText: string) => {
    const t = mockStore.tasks.find((x: any) => x.id === id);
    if (t) t.finalText = finalText;
  }),
  failTask: jest.fn((id: string, error: string) => {
    const t = mockStore.tasks.find((x: any) => x.id === id);
    if (t) {
      t.status = 'failed';
      t.error = error;
    }
  }),
  persistFailTask: jest.fn(async (id: string, error: string) => {
    mockStore.failTask(id, error);
  }),
  cancelTask: jest.fn(),
  setTaskInputFingerprint: jest.fn(),
  setTaskPipelineContext: jest.fn(),
  persistTaskPipelineContext: jest.fn(async (id: string, snap: any) => {
    const t = mockStore.tasks.find((x: any) => x.id === id);
    if (t) {
      t.pipelineContextJson = snap.pipelineContextJson;
      t.pipelineContextVersion = snap.pipelineContextVersion;
      t.pipelineContextHash = snap.pipelineContextHash;
    }
  }),
  getState() {
    return mockStore;
  },
};

jest.mock('../src/store/pipelineTaskStore', () => ({
  usePipelineTaskStore: { getState: () => mockStore },
}));

jest.mock('../src/native/PipelineForegroundModule', () => ({
  PipelineForeground: {
    start: jest.fn(async () => undefined),
    updateProgress: jest.fn(async () => undefined),
    notifyComplete: jest.fn(async () => undefined),
    notifyFailed: jest.fn(async () => undefined),
    stop: jest.fn(async () => undefined),
  },
}));

const chapter: Chapter = {
  id: 1,
  project_id: 1,
  position: 0,
  title: 'c1',
  synopsis: '',
  content: '',
  status: 'draft',
  summary_json: null,
  created_at: '',
  updated_at: '',
};

function seedTask(id: string) {
  mockStore.tasks = [
    {
      id,
      targetType: 'chapter',
      targetId: 1,
      status: 'idle',
      stageResults: [],
      finalText: null,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      resolvedAt: null,
    },
  ];
}

function clearProcessLocks() {
  // Re-require would be ideal; reconcile uses module-level Set.
  // Soft reset: mark any running checkpoints interrupted like cold start.
  for (const row of checkpointState.values()) {
    if (row.status === 'running') {
      row.status = 'interrupted';
    }
  }
}

beforeEach(() => {
  llmCalls.length = 0;
  checkpointState.clear();
  mockCallLLMResult.mockClear();
  mockClaim.mockClear();
  mockGetAll.mockClear();
  mockEnsure.mockClear();
  mockUpsert.mockClear();
  jest.clearAllMocks();
  seedTask('fault-task');
});

describe('SQLite fault injection (Schema 39 fail-closed)', () => {
  test('getStageCheckpoints throws → LLM calls = 0', async () => {
    mockGetAll.mockRejectedValueOnce(new Error('db query fail'));
    const { reconcilePipelineTask } = require('../src/services/pipeline/reconcile');
    await reconcilePipelineTask('fault-task', chapter);
    expect(llmCalls.length).toBe(0);
    expect(mockStore.persistFailTask).toHaveBeenCalled();
  });

  test('claimStageCheckpoint throws → LLM calls = 0', async () => {
    // Let snapshot persist succeed, fail on draft claim.
    mockClaim.mockRejectedValueOnce(new Error('cas boom'));
    const { reconcilePipelineTask } = require('../src/services/pipeline/reconcile');
    await reconcilePipelineTask('fault-task', chapter);
    expect(llmCalls.length).toBe(0);
  });

  test('claim returns false → LLM calls = 0', async () => {
    mockClaim.mockResolvedValue(false);
    const { reconcilePipelineTask } = require('../src/services/pipeline/reconcile');
    // First loop needs snapshot; force claim false after snapshot by:
    // run once with claim true for ensure, but claim false always.
    // Snapshot path does not claim; draft claim returns false.
    await reconcilePipelineTask('fault-task', chapter);
    expect(llmCalls.filter(c => c.scenario === 'pipeline_draft').length).toBe(0);
  });

  test('die after snapshot before draft → resume uses frozen context via shared Draft compiler, draft once', async () => {
    // First run: kill after snapshot by making claim fail once then recover.
    let claimAttempts = 0;
    mockClaim.mockImplementation(async (taskId: string, stage: string) => {
      claimAttempts += 1;
      if (claimAttempts === 1) {
        // Simulate process death after snapshot: leave draft pending.
        return false;
      }
      // Resume path
      const k = key(taskId, stage);
      const row = checkpointState.get(k) || {
        taskId,
        stage,
        status: 'pending',
        attemptCount: 0,
      };
      if (row.status === 'pending' || row.status === 'interrupted') {
        row.status = 'running';
        checkpointState.set(k, row);
        return true;
      }
      return false;
    });

    const { reconcilePipelineTask } = require('../src/services/pipeline/reconcile');
    await reconcilePipelineTask('fault-task', chapter);
    // First attempt blocked on claim.
    expect(llmCalls.length).toBe(0);
    expect(mockStore.tasks[0].pipelineContextJson).toBeTruthy();

    // Simulate process restart: clear reconcile lock by not being active, interrupt running.
    clearProcessLocks();
    mockClaim.mockImplementation(async (taskId: string, stage: string) => {
      const k = key(taskId, stage);
      let row = checkpointState.get(k);
      if (!row) {
        row = { taskId, stage, status: 'pending', attemptCount: 0 };
        checkpointState.set(k, row);
      }
      if (row.status === 'pending' || row.status === 'interrupted') {
        row.status = 'running';
        return true;
      }
      return false;
    });

    await reconcilePipelineTask('fault-task', chapter);
    expect(llmCalls.filter(c => c.scenario === 'pipeline_draft').length).toBe(1);
    const draftCall = mockCallLLMResult.mock.calls.find(
      c => c[2]?.scenario === 'pipeline_draft',
    );
    expect(draftCall?.[0]?.[0]?.content).toContain('Shared Draft Writer');
    expect(draftCall?.[0]?.map((item: { content?: string }) => item.content).join('\n')).not.toContain(
      'FROZEN_MSG',
    );
    expect(mockStore.tasks[0].status).toBe('completed');
  });

  test('succeeded draft not re-called on resume after proof skip finalize', async () => {
    mockClaim.mockImplementation(async (taskId: string, stage: string) => {
      const k = key(taskId, stage);
      let row = checkpointState.get(k);
      if (!row) {
        row = { taskId, stage, status: 'pending', attemptCount: 0 };
        checkpointState.set(k, row);
      }
      if (row.status === 'pending' || row.status === 'interrupted') {
        row.status = 'running';
        return true;
      }
      return false;
    });
    const { reconcilePipelineTask } = require('../src/services/pipeline/reconcile');
    await reconcilePipelineTask('fault-task', chapter);
    const draftCalls = llmCalls.filter(c => c.scenario === 'pipeline_draft').length;
    expect(draftCalls).toBe(1);
    expect(mockStore.tasks[0].status).toBe('completed');

    // Resume completed task — no more LLM.
    llmCalls.length = 0;
    mockCallLLMResult.mockClear();
    await reconcilePipelineTask('fault-task', chapter);
    expect(llmCalls.length).toBe(0);
  });

  test('upsert failure on stage success blocks progression', async () => {
    mockClaim.mockImplementation(async (taskId: string, stage: string) => {
      const k = key(taskId, stage);
      let row = checkpointState.get(k);
      if (!row) {
        row = { taskId, stage, status: 'pending', attemptCount: 0 };
        checkpointState.set(k, row);
      }
      if (row.status === 'pending' || row.status === 'interrupted') {
        row.status = 'running';
        return true;
      }
      return false;
    });
    // Fail first successful draft checkpoint write.
    mockUpsert.mockImplementation(async (params: any) => {
      if (params.stage === 'draft' && params.status === 'succeeded') {
        throw new Error('checkpoint write failed');
      }
      const k = key(params.taskId, params.stage);
      checkpointState.set(k, {
        taskId: params.taskId,
        stage: params.stage,
        status: params.status,
        outputText: params.outputText ?? null,
        attemptCount: 1,
        updatedAt: Date.now(),
      });
    });
    // Also make store persist fail accordingly
    mockStore.persistTaskStage.mockImplementation(async (id: string, result: any) => {
      if (result.stage === 'draft' && result.status === 'success') {
        throw new Error('checkpoint write failed');
      }
      const t = mockStore.tasks.find((x: any) => x.id === id);
      if (t) {
        t.stageResults = [
          ...(t.stageResults || []).filter((s: any) => s.stage !== result.stage),
          result,
        ];
      }
    });

    const { reconcilePipelineTask } = require('../src/services/pipeline/reconcile');
    await reconcilePipelineTask('fault-task', chapter);
    expect(mockStore.tasks[0].status).not.toBe('completed');
    // Draft LLM may have run once, but task must fail-closed without complete.
    expect(mockStore.persistCompleteTask).not.toHaveBeenCalled();
  });
});
