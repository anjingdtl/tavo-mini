/**
 * Stability Phase 3 — Freeze 之后下游消费收口（Gate P0-3）。
 *
 * 生产缺陷：pipeline/reconcile.ts loadRuntime 中，任务已有冻结信封但解析
 * 失败（hash 损坏 / JSON 损坏 / 指纹不匹配）时被 catch 静默吞掉，parsed=null
 * 走 live DB 分支 → 可能基于已变化的实时数据重新冻结，语义漂移且无任何诊断。
 *
 * 治理后契约：拥有冻结信封的任务，解析失败必须显式失败
 * （SNAPSHOT_PARSE_FAILED），不得回退实时数据重冻结。
 *
 * 本测试使用真实 sql.js SQLite + 真实 pipeline 状态机 + 真实持久化，
 * 只 mock 最外层 LLM 网络出口 callLLMResult。
 */
jest.mock('../src/services/llm', () => {
  const actual = jest.requireActual('../src/services/llm');
  return {
    ...actual,
    callLLMResult: (...args: unknown[]) => mockCallLLMResult(...args),
  };
});

import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import type { InMemorySqliteDb } from './helpers/canonInMemoryDb';
import {
  __setDatabaseForTest,
  __resetForTest,
  openDatabase,
} from '../src/data/connection/openDatabase';
import { execute } from '../src/data/connection/execute';
import { one } from '../src/data/connection/query';
import { savePipelineTask } from '../src/data/repositories/pipelineTaskRepository';
import { usePipelineTaskStore } from '../src/store/pipelineTaskStore';
import { serializePipelineTaskContext } from '../src/services/pipelineTaskContext';
import { resumePipeline } from '../src/services/pipelineRunner';
import type { PipelineContextSnapshot } from '../src/types/pipelineContext';
import type { PipelineExecutionSnapshot } from '../src/types/pipelineExecution';
import type { Chapter } from '../src/types/novel';
import {
  CURRENT_CONTEXT_BUDGET_VERSION,
  CURRENT_OUTLINE_WORKFLOW_VERSION,
} from '../src/services/pipeline/outlineWorkflowVersion';

let mockCallLLMResult: jest.Mock = jest.fn(async () => {
  throw new Error('LLM must never be called in this journey');
});

let testDb: InMemorySqliteDb | null = null;

async function resetDb() {
  __resetForTest();
  usePipelineTaskStore.setState({ tasks: [] });
  testDb = await createCanonInMemoryDb();
  __setDatabaseForTest(testDb as any);
}

afterEach(async () => {
  __resetForTest();
  if (testDb) {
    try {
      testDb.close();
    } catch {
      /* ignore */
    }
    testDb = null;
  }
});

function baseSnapshot(): PipelineContextSnapshot {
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
    projectId: 1,
    chapterId: 100,
    createdAt: 1000,
    snapshotVersion: 1,
  };
}

function baseExecution(): PipelineExecutionSnapshot {
  const tier = () => ({
    requestedTier: 'low' as const,
    effectiveTier: 'low' as const,
    thinking: 'enabled' as const,
    effort: 'low' as const,
  });
  return {
    pipelineMode: 'full',
    outlineWorkflowVersion: CURRENT_OUTLINE_WORKFLOW_VERSION,
    contextBudgetVersion: CURRENT_CONTEXT_BUDGET_VERSION,
    finalReviserReasoningPolicyVersion: 3,
    reasoningEffort: 'low',
    reasoningProfileVersion: 5,
    requestedReasoningTier: 'low',
    stageReasoning: {
      draft: { stage: 'draft', ...tier() },
      review: { stage: 'review', ...tier() },
      factCheck: { stage: 'factCheck', ...tier() },
      brief: { stage: 'brief', ...tier() },
      proof: { stage: 'proof', ...tier() },
    },
    briefPolicyVersion: 4,
    briefVisibleOutputFloor: 1200,
    briefReasoningHeadroom: 1200,
    briefMaxTokens: 4000,
    draftMaxTokens: 4000,
    reviewMaxTokens: 1500,
    factCheckMaxTokens: 1500,
    proofMaxTokens: 4000,
    draftPresetId: null,
    reviewPresetId: null,
    factCheckPresetId: null,
    proofPresetId: null,
    draftPreset: null,
    reviewPreset: null,
    factCheckPreset: null,
    proofPreset: null,
    model: {
      llmConfigId: 1,
      modelName: 'model-a',
      contextWindow: 32000,
    },
    createdAt: 1000,
  } as PipelineExecutionSnapshot;
}

function chapterFor(): Chapter {
  return {
    id: 100,
    project_id: 1,
    position: 0,
    title: '第1章',
    synopsis: 's',
    content: '',
    status: 'draft',
    summary_json: null,
    created_at: 't',
    updated_at: 't',
  };
}

async function seedBaseData(): Promise<void> {
  const db = await openDatabase();
  await execute(
    db,
    `INSERT INTO projects (id, name, mode, created_at, updated_at)
     VALUES (1, 'p', 'outline', 't', 't')`,
  );
  await execute(
    db,
    `INSERT INTO llm_config
       (id, name, base_url, api_key, model_name, is_active, provider_type,
        context_window, max_output_tokens)
     VALUES (1, 'm', 'http://127.0.0.1:9/v1', 'k', 'model-a', 1,
             'openai_compatible', 32000, 4000)`,
  );
}

async function seedFrozenTaskWithCorruptHash(): Promise<string> {
  await seedBaseData();
  const frozen = serializePipelineTaskContext({
    draftContext: baseSnapshot(),
    execution: baseExecution(),
  });
  const taskId = 'task-corrupt-frozen';
  const now = Date.now();
  await savePipelineTask({
    id: taskId,
    targetType: 'chapter',
    targetId: 100,
    status: 'interrupted',
    stageResults: [],
    finalText: null,
    error: null,
    pipelineContextJson: frozen.pipelineContextJson,
    pipelineContextVersion: frozen.pipelineContextVersion,
    // 损坏的 integrity hash：parse 必须 fail-closed。
    pipelineContextHash: 'deadbeefdeadbeefdeadbeefdeadbeef',
    outlineWorkflowVersion: CURRENT_OUTLINE_WORKFLOW_VERSION,
    contextBudgetVersion: CURRENT_CONTEXT_BUDGET_VERSION,
    createdAt: now - 100_000,
    updatedAt: now,
    resolvedAt: null,
  });
  usePipelineTaskStore.getState().registerPersistedTask({
    id: taskId,
    targetType: 'chapter',
    targetId: 100,
    status: 'interrupted',
    stageResults: [],
    finalText: null,
    error: null,
    pipelineContextJson: frozen.pipelineContextJson,
    pipelineContextVersion: frozen.pipelineContextVersion,
    pipelineContextHash: 'deadbeefdeadbeefdeadbeefdeadbeef',
    outlineWorkflowVersion: CURRENT_OUTLINE_WORKFLOW_VERSION,
    contextBudgetVersion: CURRENT_CONTEXT_BUDGET_VERSION,
    createdAt: now - 100_000,
    updatedAt: now,
    resolvedAt: null,
    resolvedAction: null,
  });
  return taskId;
}

describe('Stability Phase 3: 冻结信封解析失败必须 fail-closed', () => {
  jest.setTimeout(60_000);

  it('corrupt frozen envelope → 显式 SNAPSHOT_PARSE_FAILED，不回退实时数据', async () => {
    await resetDb();
    const taskId = await seedFrozenTaskWithCorruptHash();
    mockCallLLMResult.mockClear();

    await resumePipeline(taskId, chapterFor());

    const row = (await one(
      `SELECT status, error, pipeline_context_hash FROM pipeline_tasks WHERE id = ?`,
      [taskId],
    )) as any;
    // 任务必须显式失败，且错误信息指向快照解析，而不是静默重冻结。
    expect(String(row.status)).toBe('failed');
    expect(String(row.error)).toContain('冻结上下文解析失败');
    // 损坏的信封必须原样保留（没有被 live 数据重写）。
    expect(String(row.pipeline_context_hash)).toBe(
      'deadbeefdeadbeefdeadbeefdeadbeef',
    );
    // 任何阶段都不得发起 LLM 调用。
    expect(mockCallLLMResult).not.toHaveBeenCalled();
  });
});
