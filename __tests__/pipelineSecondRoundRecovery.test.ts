/**
 * Second-round outline upgrade recovery tests.
 *
 * Covers: snapshot await-before-LLM, cold-start classification, auditContext
 * envelope, strict parse, window bound to requestConfig, execution freeze.
 */
import {
  classifyInterruptedTask,
  parsePersistedPipelineTaskContext,
  serializePipelineTaskContext,
  resolveAuditContext,
} from '../src/services/pipelineTaskContext';
import type { PipelineContextSnapshot } from '../src/types/pipelineContext';
import type { PipelineExecutionSnapshot } from '../src/types/pipelineExecution';
import { OutlineContextError } from '../src/services/outlineContextBuilder';
import { checkRequestFitsContextWindow } from '../src/services/outlineContextBuilder';
import { computeOutlinePacking } from '../src/services/outlineContextBuilder';

function baseSnapshot(
  overrides: Partial<PipelineContextSnapshot> = {},
): PipelineContextSnapshot {
  return {
    presetText: 'preset',
    storyMemoryText: 'story',
    characterText: 'char',
    noteText: 'note',
    worldbookText: 'wb',
    episodicMemoryText: 'episodic',
    recentBridgeText: 'bridge',
    currentInstructionText: 'instruction',
    retrievalUserPrompt: 'prompt',
    outlineText: 'outline body',
    outlineFingerprint: 'fp1',
    outlineIds: [1],
    outlineComplete: true,
    outlineEstimatedTokens: 10,
    projectId: 7,
    chapterId: 3,
    createdAt: 1000,
    snapshotVersion: 1,
    ...overrides,
  };
}

function baseExecution(
  overrides: Partial<PipelineExecutionSnapshot> = {},
): PipelineExecutionSnapshot {
  return {
    pipelineMode: 'full',
    draftMaxTokens: 4000,
    reviewMaxTokens: 1500,
    factCheckMaxTokens: 1500,
    proofMaxTokens: 4000,
    draftPresetId: 1,
    reviewPresetId: 2,
    factCheckPresetId: 3,
    proofPresetId: 4,
    draftPreset: {
      id: 1,
      system_prompt: 'd',
      writing_style: '',
      extra_instructions: '',
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 1000,
    },
    reviewPreset: null,
    factCheckPreset: null,
    proofPreset: null,
    model: {
      llmConfigId: 11,
      modelName: 'model-a',
      contextWindow: 32000,
    },
    createdAt: 1000,
    ...overrides,
  };
}

describe('pipeline task context V2 envelope', () => {
  test('serialize + parse round-trip keeps draft, audit, execution', () => {
    const draft = baseSnapshot();
    const audit = baseSnapshot({
      characterText: 'char+new-hit',
      worldbookText: 'wb+new-hit',
    });
    const execution = baseExecution();
    const persisted = serializePipelineTaskContext({
      draftContext: draft,
      auditContext: audit,
      execution,
      auditFellBack: false,
    });
    expect(persisted.pipelineContextVersion).toBe(2);
    expect(persisted.pipelineContextHash).toHaveLength(32);

    const parsed = parsePersistedPipelineTaskContext(persisted, {
      expectedProjectId: 7,
      expectedChapterId: 3,
    });
    expect(parsed.version).toBe(2);
    expect(parsed.draftContext.characterText).toBe('char');
    expect(parsed.auditContext?.characterText).toBe('char+new-hit');
    expect(resolveAuditContext(parsed).worldbookText).toBe('wb+new-hit');
    expect(parsed.execution?.model.contextWindow).toBe(32000);
    expect(parsed.execution?.pipelineMode).toBe('full');
  });

  test('hash mismatch is rejected', () => {
    const persisted = serializePipelineTaskContext({
      draftContext: baseSnapshot(),
      execution: baseExecution(),
    });
    expect(() =>
      parsePersistedPipelineTaskContext({
        ...persisted,
        pipelineContextHash: 'deadbeef',
      }),
    ).toThrow(OutlineContextError);
  });

  test('unknown version is rejected', () => {
    expect(() =>
      parsePersistedPipelineTaskContext({
        pipelineContextJson: JSON.stringify({ version: 99 }),
        pipelineContextVersion: 99,
        pipelineContextHash: null,
      }),
    ).toThrow(/不支持的流水线上下文版本/);
  });

  test('projectId ownership mismatch is rejected', () => {
    const persisted = serializePipelineTaskContext({
      draftContext: baseSnapshot({ projectId: 7 }),
      execution: baseExecution(),
    });
    expect(() =>
      parsePersistedPipelineTaskContext(persisted, {
        expectedProjectId: 99,
      }),
    ).toThrow(/项目不匹配/);
  });

  test('chapterId ownership mismatch is rejected', () => {
    const persisted = serializePipelineTaskContext({
      draftContext: baseSnapshot({ chapterId: 3 }),
      execution: baseExecution(),
    });
    expect(() =>
      parsePersistedPipelineTaskContext(persisted, {
        expectedChapterId: 99,
      }),
    ).toThrow(/章节不匹配/);
  });

  test('missing required string fields rejected', () => {
    const bad = {
      version: 2,
      draftContext: { outlineText: 'x' },
      execution: baseExecution(),
      createdAt: 1,
    };
    expect(() =>
      parsePersistedPipelineTaskContext({
        pipelineContextJson: JSON.stringify(bad),
        pipelineContextVersion: 2,
        pipelineContextHash: null,
      }),
    ).toThrow(OutlineContextError);
  });

  test('illegal outlineIds rejected', () => {
    const draft = baseSnapshot({ outlineIds: [-1] as any });
    // Bypass serialize (which would pass arrays as-is) and craft JSON.
    const envelope = {
      version: 2,
      draftContext: { ...draft, outlineIds: [-1] },
      execution: baseExecution(),
      createdAt: 1,
    };
    expect(() =>
      parsePersistedPipelineTaskContext({
        pipelineContextJson: JSON.stringify(envelope),
        pipelineContextVersion: 2,
        pipelineContextHash: null,
      }),
    ).toThrow(/outlineIds/);
  });
});

describe('classifyInterruptedTask', () => {
  test('successful draft + valid snapshot → recoverable interrupted', () => {
    const persisted = serializePipelineTaskContext({
      draftContext: baseSnapshot({ chapterId: 5 }),
      execution: baseExecution(),
    });
    const result = classifyInterruptedTask({
      status: 'reviewing',
      targetType: 'chapter',
      targetId: 5,
      stageResults: [{ stage: 'draft', status: 'success' }],
      ...persisted,
    });
    expect(result.recoverable).toBe(true);
    expect(result.nextStatus).toBe('interrupted');
  });

  test('no draft → not recoverable', () => {
    const result = classifyInterruptedTask({
      status: 'drafting',
      stageResults: [],
      pipelineContextJson: null,
    });
    expect(result.recoverable).toBe(false);
    expect(result.nextStatus).toBe('failed');
    expect(result.reason).toMatch(/没有成功的初稿/);
  });

  test('draft but corrupt snapshot → not recoverable', () => {
    const result = classifyInterruptedTask({
      status: 'reviewing',
      stageResults: [{ stage: 'draft', status: 'success' }],
      pipelineContextJson: '{not-json',
      pipelineContextHash: null,
    });
    expect(result.recoverable).toBe(false);
    expect(result.nextStatus).toBe('failed');
  });

  test('cancelled stays not recoverable', () => {
    const result = classifyInterruptedTask({
      status: 'cancelled',
      stageResults: [{ stage: 'draft', status: 'success' }],
    });
    expect(result.recoverable).toBe(false);
  });
});

describe('window check bound to request model', () => {
  test('uses provided contextWindow, not a larger live window', () => {
    const reason = checkRequestFitsContextWindow({
      estimatedInputTokens: 30000,
      reservedOutputTokens: 4000,
      contextWindow: 32000,
      stageLabel: '初稿',
    });
    expect(reason).toBeTruthy();

    const okOnLarger = checkRequestFitsContextWindow({
      estimatedInputTokens: 30000,
      reservedOutputTokens: 4000,
      contextWindow: 128000,
      stageLabel: '初稿',
    });
    expect(okOnLarger).toBeNull();
  });
});

describe('suggest-disable re-packs prefixes', () => {
  test('suggestedDisableIds makes remaining packing complete', () => {
    const outlines = [
      {
        id: 1,
        title: 'A',
        content: '甲'.repeat(200),
        position: 0,
        contentHash: 'a',
        enabled: true,
        updatedAt: 1,
      },
      {
        id: 2,
        title: 'B',
        content: '乙'.repeat(200),
        position: 1,
        contentHash: 'b',
        enabled: true,
        updatedAt: 1,
      },
      {
        id: 3,
        title: 'C',
        content: '丙'.repeat(200),
        position: 2,
        contentHash: 'c',
        enabled: true,
        updatedAt: 1,
      },
    ];
    const two = computeOutlinePacking({
      outlines: outlines.slice(0, 2) as any,
      budgetTokens: 1_000_000,
    });
    const budget = two.totalTokens + 1;
    const packing = computeOutlinePacking({
      outlines: outlines as any,
      budgetTokens: budget,
    });
    expect(packing.complete).toBe(false);
    expect(packing.suggestedDisableIds.length).toBeGreaterThan(0);

    const kept = outlines.filter(
      o => !packing.suggestedDisableIds.includes(o.id),
    );
    const repacked = computeOutlinePacking({
      outlines: kept as any,
      budgetTokens: budget,
    });
    // After applying suggested disables, remaining must fit.
    expect(repacked.complete).toBe(true);
  });
});

describe('persist-before-LLM contract (store)', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('persistTaskPipelineContext awaits DB write and fails closed', async () => {
    let resolveWrite: (() => void) | null = null;
    const writeGate = new Promise<void>(resolve => {
      resolveWrite = resolve;
    });
    let writeStarted = false;
    let writeCompleted = false;

    jest.doMock('../src/services/database', () => ({
      openDatabase: jest.fn(async () => undefined),
      getAllPipelineTasks: jest.fn(async () => []),
      savePipelineTask: jest.fn(async () => undefined),
      updatePipelineTaskContext: jest.fn(async () => {
        writeStarted = true;
        await writeGate;
        writeCompleted = true;
      }),
      deleteResolvedPipelineTasks: jest.fn(async () => undefined),
    }));

    const { usePipelineTaskStore } = require('../src/store/pipelineTaskStore');
    usePipelineTaskStore.setState({
      tasks: [
        {
          id: 't1',
          targetType: 'chapter',
          targetId: 1,
          status: 'drafting',
          stageResults: [],
          finalText: null,
          error: null,
          createdAt: 1,
          updatedAt: 1,
          resolvedAt: null,
        },
      ],
      _loaded: true,
    });

    let llmCalls = 0;
    const persistPromise = usePipelineTaskStore
      .getState()
      .persistTaskPipelineContext('t1', {
        pipelineContextJson: '{"ok":true}',
        pipelineContextVersion: 2,
        pipelineContextHash: 'abc',
      })
      .then(() => {
        // Only after await may LLM proceed.
        if (!writeCompleted) {
          throw new Error('LLM would have started before write finished');
        }
        llmCalls += 1;
      });

    // Write started but not finished — LLM must still be 0.
    await Promise.resolve();
    expect(writeStarted).toBe(true);
    expect(writeCompleted).toBe(false);
    expect(llmCalls).toBe(0);

    resolveWrite!();
    await persistPromise;
    expect(writeCompleted).toBe(true);
    expect(llmCalls).toBe(1);

    const task = usePipelineTaskStore.getState().tasks.find((t: any) => t.id === 't1');
    expect(task.pipelineContextJson).toBe('{"ok":true}');
  });

  test('persist failure throws and leaves memory without snapshot', async () => {
    jest.doMock('../src/services/database', () => ({
      openDatabase: jest.fn(async () => undefined),
      getAllPipelineTasks: jest.fn(async () => []),
      savePipelineTask: jest.fn(async () => undefined),
      updatePipelineTaskContext: jest.fn(async () => {
        throw new Error('disk full');
      }),
      deleteResolvedPipelineTasks: jest.fn(async () => undefined),
    }));

    const { usePipelineTaskStore } = require('../src/store/pipelineTaskStore');
    usePipelineTaskStore.setState({
      tasks: [
        {
          id: 't2',
          targetType: 'chapter',
          targetId: 1,
          status: 'drafting',
          stageResults: [],
          finalText: null,
          error: null,
          createdAt: 1,
          updatedAt: 1,
          resolvedAt: null,
        },
      ],
      _loaded: true,
    });

    await expect(
      usePipelineTaskStore.getState().persistTaskPipelineContext('t2', {
        pipelineContextJson: '{}',
        pipelineContextVersion: 2,
        pipelineContextHash: 'x',
      }),
    ).rejects.toMatchObject({ code: 'OUTLINE_SNAPSHOT_PERSIST_FAILED' });

    const task = usePipelineTaskStore.getState().tasks.find((t: any) => t.id === 't2');
    expect(task.pipelineContextJson).toBeUndefined();
  });

  test('cold start: draft+snapshot becomes interrupted without resolve', () => {
    jest.doMock('../src/services/database', () => ({
      openDatabase: jest.fn(async () => undefined),
      getAllPipelineTasks: jest.fn(async () => []),
      savePipelineTask: jest.fn(async () => undefined),
      updatePipelineTaskContext: jest.fn(async () => undefined),
      deleteResolvedPipelineTasks: jest.fn(async () => undefined),
    }));

    const { usePipelineTaskStore } = require('../src/store/pipelineTaskStore');
    const persisted = serializePipelineTaskContext({
      draftContext: baseSnapshot({ chapterId: 9 }),
      execution: baseExecution(),
    });
    usePipelineTaskStore.setState({
      tasks: [
        {
          id: 'recoverable',
          targetType: 'chapter',
          targetId: 9,
          status: 'reviewing',
          stageResults: [
            { stage: 'draft', text: 'draft', status: 'success', durationMs: 1 },
          ],
          finalText: null,
          error: null,
          ...persisted,
          createdAt: 1,
          updatedAt: 1,
          resolvedAt: null,
        },
        {
          id: 'no-draft',
          targetType: 'chapter',
          targetId: 10,
          status: 'drafting',
          stageResults: [],
          finalText: null,
          error: null,
          createdAt: 1,
          updatedAt: 1,
          resolvedAt: null,
        },
      ],
      _loaded: true,
    });

    const marked = usePipelineTaskStore.getState().markActiveTasksAsInterrupted();
    expect(marked).toBe(2);
    const tasks = usePipelineTaskStore.getState().tasks;
    const ok = tasks.find((t: any) => t.id === 'recoverable');
    const bad = tasks.find((t: any) => t.id === 'no-draft');
    expect(ok.status).toBe('interrupted');
    expect(ok.recoverable).toBe(true);
    expect(ok.resolvedAt).toBeNull();
    expect(bad.status).toBe('failed');
    expect(bad.resolvedAt).toBeNull();
  });
});

describe('runner awaits persist before LLM', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('LLM not called when persist rejects', async () => {
    const mockCallLLM = jest.fn();
    const mockPersist = jest.fn(async () => {
      throw new OutlineContextError(
        'OUTLINE_SNAPSHOT_PERSIST_FAILED',
        'freeze failed',
        'restart_task',
      );
    });
    const mockStore: any = {
      setTaskStatus: jest.fn(),
      updateTaskStage: jest.fn(),
      completeTask: jest.fn(),
      setTaskFinalText: jest.fn(),
      failTask: jest.fn(),
      cancelTask: jest.fn(),
      setTaskInputFingerprint: jest.fn(),
      setTaskPipelineContext: jest.fn(),
      persistTaskPipelineContext: mockPersist,
      tasks: [],
      getState() {
        return mockStore;
      },
    };

    jest.doMock('../src/store/pipelineTaskStore', () => ({
      usePipelineTaskStore: { getState: () => mockStore },
    }));
    jest.doMock('../src/services/database', () => ({
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
      getPresetsByProject: jest.fn(async () => [
        {
          id: 1,
          system_prompt: 's',
          writing_style: '',
          extra_instructions: '',
          temperature: 0.7,
          top_p: 0.9,
          max_tokens: 1000,
        },
      ]),
      getActiveLLMConfig: jest.fn(async () => ({
        id: 1,
        context_window: 128000,
      })),
      getProjectById: jest.fn(async () => ({ id: 1, mode: 'outline' })),
    }));
    jest.doMock('../src/services/llm', () => ({
      callLLMResult: (...args: any[]) => mockCallLLM(...args),
      resolveLLMRequestConfig: jest.fn(async () => ({
        id: 1,
        name: 'm',
        provider_type: 'openai_compatible',
        api_key: 'k',
        model_name: 'm',
        url: 'https://example.com/v1/chat/completions',
        context_window: 32000,
      })),
    }));
    jest.doMock('../src/services/draftService', () => ({
      saveDraft: jest.fn(async () => 1),
    }));
    jest.doMock('../src/services/draftPipelineCompiler', () => ({
      compileDraftPipelineRequest: jest.fn(async () => ({
        messages: [{ role: 'user', content: 'hi' }],
        baseContext: [],
        pipelineContext: baseSnapshot(),
        estimatedInputTokens: 10,
        reservedOutputTokens: 1000,
        safetyMargin: 512,
        contextWindow: 32000,
        fits: true,
        blockingReason: null,
        chapterTitle: 'c',
        prevEnding: '',
        userPrompt: 'p',
        draftPreset: null,
        requestConfig: {
          id: 1,
          context_window: 32000,
          provider_type: 'openai_compatible',
          api_key: 'k',
          model_name: 'm',
          url: 'https://example.com/v1/chat/completions',
        },
        trace: [],
      })),
    }));
    jest.doMock('../src/native/PipelineForegroundModule', () => ({
      PipelineForeground: {
        start: jest.fn(async () => undefined),
        updateProgress: jest.fn(async () => undefined),
        notifyComplete: jest.fn(async () => undefined),
        notifyFailed: jest.fn(async () => undefined),
        stop: jest.fn(async () => undefined),
      },
    }));
    jest.doMock('../src/services/llm/requestScheduler', () => ({
      setLLMTaskQueueDefaults: jest.fn(),
      clearLLMTaskQueueDefaults: jest.fn(),
    }));

    const { runChapterPipeline } = require('../src/services/pipelineRunner');
    await runChapterPipeline('task-persist-fail', {
      id: 1,
      project_id: 7,
      position: 0,
      title: 'c',
      synopsis: '',
      content: '',
      status: 'draft',
      summary_json: null,
      created_at: '',
      updated_at: '',
    });

    expect(mockPersist).toHaveBeenCalled();
    expect(mockCallLLM).not.toHaveBeenCalled();
    expect(mockStore.failTask).toHaveBeenCalled();
  });
});
