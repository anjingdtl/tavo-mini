/**
 * F3-01: Batch resume 必须保留 frozen pipeline context（修复前稳定失败测试）。
 *
 * 生产缺陷路径（multiChapterBatchStore.resume → savePipelineTask 全量 UPSERT）：
 *   - 原 task 已拥有 frozen execution/context（draft/review/factCheck succeeded）
 *   - proof failed → batch paused_timeout_unknown
 *   - 用户"确认后继续" → resume()
 *   - savePipelineTask 未传 input_fingerprint / pipeline_context_json /
 *     pipeline_context_version / pipeline_context_hash → 全量 UPSERT 把这些
 *     字段写成 NULL
 *   - task → interrupted；Pipeline 状态机发现无 frozen snapshot →
 *     TASK_NOT_RECOVERABLE → 用户已付费的前三阶段无法复用
 *
 * 本测试使用真实 sql.js SQLite + 真实 batch store + 真实 batch/pipeline
 * 状态机 + 真实仓储，只替换最外层 LLM 网络出口 callLLMResult。
 * 不 mock：store.resume / savePipelineTask / determineNextBatchAction /
 * reconcileMultiChapterBatch / resumePipeline / reconcilePipelineTask /
 * checkpoint 持久化。
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
import { all, one } from '../src/data/connection/query';
import {
  createBatch,
  createBatchItem,
  createBatchChapterForItem,
  updateBatchStatus,
  getBatchById,
  getBatchItems,
} from '../src/data/repositories/multiChapterBatchRepository';
import { savePipelineTask } from '../src/data/repositories/pipelineTaskRepository';
import { resetFailedStageCheckpointsForResume } from '../src/data/repositories/pipelineStageCheckpointRepository';
import {
  useMultiChapterBatchStore,
  resetBatchInstanceId,
} from '../src/store/multiChapterBatchStore';
import { usePipelineTaskStore } from '../src/store/pipelineTaskStore';
import { serializePipelineTaskContext } from '../src/services/pipelineTaskContext';
import type { PipelineContextSnapshot } from '../src/types/pipelineContext';
import type { PipelineExecutionSnapshot } from '../src/types/pipelineExecution';
import { resumePipeline } from '../src/services/pipelineRunner';
import type { Chapter } from '../src/types/novel';
import {
  CURRENT_CONTEXT_BUDGET_VERSION,
  CURRENT_OUTLINE_WORKFLOW_VERSION,
} from '../src/services/pipeline/outlineWorkflowVersion';

let mockCallLLMResult: jest.Mock = jest.fn();

let testDb: InMemorySqliteDb | null = null;

async function resetDb() {
  __resetForTest();
  usePipelineTaskStore.setState({ tasks: [] });
  useMultiChapterBatchStore.setState({
    batch: null,
    items: [],
    plan: null,
    loading: false,
    error: null,
    reconciling: false,
    lastMessage: null,
    lastStage: null,
  });
  resetBatchInstanceId();
  testDb = await createCanonInMemoryDb();
  __setDatabaseForTest(testDb as any);
}

afterEach(async () => {
  __resetForTest();
  resetBatchInstanceId();
  if (testDb) {
    try {
      testDb.close();
    } catch {
      /* ignore */
    }
    testDb = null;
  }
});

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
    projectId: 1,
    chapterId: 100,
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
    outlineWorkflowVersion: CURRENT_OUTLINE_WORKFLOW_VERSION,
    contextBudgetVersion: CURRENT_CONTEXT_BUDGET_VERSION,
    finalReviserReasoningPolicyVersion: 3,
    reasoningEffort: 'low',
    reasoningProfileVersion: 5,
    requestedReasoningTier: 'low',
    stageReasoning: {
      draft: {
        stage: 'draft',
        requestedTier: 'low',
        effectiveTier: 'low',
        thinking: 'enabled',
        effort: 'low',
      },
      review: {
        stage: 'review',
        requestedTier: 'low',
        effectiveTier: 'low',
        thinking: 'enabled',
        effort: 'low',
      },
      factCheck: {
        stage: 'factCheck',
        requestedTier: 'low',
        effectiveTier: 'low',
        thinking: 'enabled',
        effort: 'low',
      },
      brief: {
        stage: 'brief',
        requestedTier: 'low',
        effectiveTier: 'low',
        thinking: 'enabled',
        effort: 'low',
      },
      proof: {
        stage: 'proof',
        requestedTier: 'low',
        effectiveTier: 'low',
        thinking: 'enabled',
        effort: 'low',
      },
    },
    briefPolicyVersion: 4,
    briefVisibleOutputFloor: 1200,
    briefReasoningHeadroom: 1200,
    briefMaxTokens: 4000,
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
      llmConfigId: 1,
      name: 'm',
      provider: 'openai_compatible',
      modelName: 'model-a',
      url: 'http://127.0.0.1:9/v1/chat/completions',
      contextWindow: 32000,
      maxOutputTokens: 4000,
      allowInsecureLanHttp: true,
    },
    createdAt: 1000,
    ...overrides,
  };
}

async function seedBaseData(): Promise<{
  projectId: number;
  chapterId: number;
}> {
  await execute(
    await openDatabase(),
    `INSERT INTO projects (id, name, mode, created_at, updated_at)
     VALUES (1, 'p', 'outline', 't', 't')`,
  );
  await execute(
    await openDatabase(),
    `INSERT INTO llm_config
       (id, name, base_url, api_key, model_name, is_active, provider_type,
        context_window, max_output_tokens)
     VALUES (1, 'm', 'http://127.0.0.1:9/v1', 'k', 'model-a', 1,
             'openai_compatible', 32000, 4000)`,
  );
  return { projectId: 1, chapterId: 100 };
}

/** 完整有效 frozen snapshot（用生产 serializer 生成，hash 天然匹配）。 */
function frozenContext(chapterId: number) {
  return serializePipelineTaskContext({
    draftContext: baseSnapshot({ projectId: 1, chapterId }),
    auditContext: baseSnapshot({ projectId: 1, chapterId, characterText: 'char+audit' }),
    execution: baseExecution(),
    frozenDraftRequest: {
      messages: [
        { role: 'system', content: 'draft system' },
        { role: 'user', content: 'draft user' },
      ],
      estimatedInputTokens: 100,
      reservedOutputTokens: 4000,
      safetyMargin: 100,
      contextWindow: 32000,
      allocations: [],
      requestFingerprint: 'fp-frozen-draft',
      chapterTitle: '第1章',
      prevEnding: '',
      userPrompt: 's',
    },
    createdAt: 5000,
  });
}

function currentPipelineResult(messages: unknown[], config: any) {
  switch (config?.scenario) {
    case 'pipeline_draft':
      return {
        text: '当前统一流程初稿正文。',
        inputTokens: 100,
        outputTokens: 300,
        totalTokens: 400,
        emptyReason: null,
      };
    case 'pipeline_review':
      return {
        text: JSON.stringify({
          verdict: 'pass',
          checked: [
            'opening_continuity',
            'outline_execution',
            'character',
            'prose',
            'ending_boundary',
          ],
          findings: [],
          preserve: [],
          ending: '',
        }),
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
      };
    case 'pipeline_factcheck':
      {
        const system = String(
          (messages[0] as { content?: unknown } | undefined)?.content || '',
        );
        const receiptMatch = system.match(
          /本次必须写入 checked 的收据：(\[[^\n]*\])/,
        );
        const checked = receiptMatch ? JSON.parse(receiptMatch[1]) : [];
      return {
        text: JSON.stringify({
          verdict: checked.length ? 'pass' : 'not_applicable',
          checked,
          findings: [],
          preserve: [],
        }),
        inputTokens: 100,
        outputTokens: 30,
        totalTokens: 130,
      };
      }
    case 'pipeline_brief':
      return {
        text: JSON.stringify({
          strategy: '保持连续性',
          actions: [],
          preserve: [],
          ending: '',
        }),
        inputTokens: 100,
        outputTokens: 30,
        totalTokens: 130,
      };
    case 'pipeline_proof':
      return {
        text: '当前统一流程终稿正文。',
        inputTokens: 60,
        outputTokens: 400,
        totalTokens: 460,
        emptyReason: null,
      };
    default:
      throw new Error(`unexpected scenario: ${String(config?.scenario)}`);
  }
}

async function seedProofFailedScenario(): Promise<{
  taskId: string;
  chapterId: number;
  frozen: {
    pipelineContextJson: string;
    pipelineContextVersion: number;
    pipelineContextHash: string;
  };
}> {
  await seedBaseData();
  await createBatch({
    id: 'b1',
    projectId: 1,
    sourcePrompt: 's',
    chapterCount: 1,
    targetWordsPerChapter: 3000,
    pipelineMode: 'full',
  });
  await createBatchItem({
    batchId: 'b1',
    ordinal: 1,
    title: '第1章',
    synopsis: 's',
    keyBeatsJson: '[]',
    targetWords: 3000,
  });
  const createdChapterId = await createBatchChapterForItem('b1', 1, {
    projectId: 1,
    position: 0,
    title: '第1章',
    synopsis: 's',
  });
  await updateBatchStatus('b1', 'ready');

  const frozen = frozenContext(createdChapterId);
  const taskId = 'task-proof-failed';
  const now = Date.now();
  await savePipelineTask({
    id: taskId,
    targetType: 'chapter',
    targetId: createdChapterId,
    status: 'failed',
    stageResults: [],
    finalText: null,
    error: '网络错误',
    inputFingerprint: 'fp-original',
    pipelineContextJson: frozen.pipelineContextJson,
    pipelineContextVersion: frozen.pipelineContextVersion,
    pipelineContextHash: frozen.pipelineContextHash,
    outlineWorkflowVersion: CURRENT_OUTLINE_WORKFLOW_VERSION,
    contextBudgetVersion: CURRENT_CONTEXT_BUDGET_VERSION,
    createdAt: now - 100_000,
    updatedAt: now - 10_000,
    resolvedAt: null,
  });

  const db = await openDatabase();
  const cpCols = `(task_id, stage, status, output_text, error_code, error_message,
     input_tokens, output_tokens, total_tokens, duration_ms, attempt_count,
     started_at, completed_at, updated_at)`;
  await execute(
    db,
    `INSERT INTO pipeline_stage_checkpoints ${cpCols}
     VALUES (?, 'draft', 'succeeded', ?, NULL, NULL, ?, ?, ?, 5000, 1, ?, ?, ?)`,
    [
      taskId,
      '初稿正文。',
      500,
      800,
      1300,
      now - 90_000,
      now - 80_000,
      now - 80_000,
    ],
  );
  await execute(
    db,
    `INSERT INTO pipeline_stage_checkpoints ${cpCols}
     VALUES (?, 'review', 'succeeded', ?, NULL, NULL, ?, ?, ?, 3000, 1, ?, ?, ?)`,
    [
      taskId,
      '审阅报告。',
      200,
      100,
      300,
      now - 75_000,
      now - 70_000,
      now - 70_000,
    ],
  );
  await execute(
    db,
    `INSERT INTO pipeline_stage_checkpoints ${cpCols}
     VALUES (?, 'factCheck', 'succeeded', ?, NULL, NULL, ?, ?, ?, 2000, 1, ?, ?, ?)`,
    [
      taskId,
      '核查报告。',
      100,
      50,
      150,
      now - 65_000,
      now - 60_000,
      now - 60_000,
    ],
  );
  await execute(
    db,
    `INSERT INTO pipeline_stage_checkpoints ${cpCols}
     VALUES (?, 'brief', 'succeeded', ?, NULL, NULL, ?, ?, ?, 1500, 1, ?, ?, ?)`,
    [
      taskId,
      JSON.stringify({
        schemaVersion: 4,
        briefPolicyVersion: 4,
        strategy: '保持连续性',
        actions: [],
        preserve: [],
        ending: '',
      }),
      100,
      40,
      140,
      now - 58_000,
      now - 57_000,
      now - 57_000,
    ],
  );
  await execute(
    db,
    `INSERT INTO pipeline_stage_checkpoints ${cpCols}
     VALUES (?, 'proof', 'failed', NULL, 'ERR_NETWORK', '网络错误',
             NULL, NULL, NULL, 1000, 1, ?, ?, ?)`,
    [taskId, now - 55_000, now - 50_000, now - 50_000],
  );

  const attCols = `(id, pipeline_task_id, stage, attempt_no, request_version,
     request_fingerprint, allocation_trace_json, frozen_request_json,
     llm_config_id, llm_config_snapshot_json, client_request_id,
     status, failure_class, error_code, error_message, http_status,
     retry_after_ms, started_at, completed_at, input_tokens, output_tokens, total_tokens)`;
  await execute(
    db,
    `INSERT INTO pipeline_stage_attempts ${attCols}
     VALUES (?, ?, 'draft', 1, 1, 'fp-draft', NULL, NULL, 1, '{}', 'c1',
             'succeeded', NULL, NULL, NULL, NULL, NULL, ?, ?, 500, 800, 1300)`,
    [`${taskId}:draft:1`, taskId, now - 90_000, now - 80_000],
  );
  await execute(
    db,
    `INSERT INTO pipeline_stage_attempts ${attCols}
     VALUES (?, ?, 'review', 1, 1, 'fp-review', NULL, NULL, 1, '{}', 'c2',
             'succeeded', NULL, NULL, NULL, NULL, NULL, ?, ?, 200, 100, 300)`,
    [`${taskId}:review:1`, taskId, now - 75_000, now - 70_000],
  );
  await execute(
    db,
    `INSERT INTO pipeline_stage_attempts ${attCols}
     VALUES (?, ?, 'factCheck', 1, 1, 'fp-factcheck', NULL, NULL, 1, '{}', 'c3',
             'succeeded', NULL, NULL, NULL, NULL, NULL, ?, ?, 100, 50, 150)`,
    [`${taskId}:factCheck:1`, taskId, now - 65_000, now - 60_000],
  );
  await execute(
    db,
    `INSERT INTO pipeline_stage_attempts ${attCols}
     VALUES (?, ?, 'brief', 1, 33, 'fp-brief', NULL, NULL, 1, '{}', 'c4',
             'succeeded', NULL, NULL, NULL, NULL, NULL, ?, ?, 100, 40, 140)`,
    [`${taskId}:brief:1`, taskId, now - 58_000, now - 57_000],
  );
  await execute(
    db,
    `INSERT INTO pipeline_stage_attempts ${attCols}
     VALUES (?, ?, 'proof', 1, 33, 'fp-proof', NULL, NULL, 1, '{}', 'c5',
             'failed', 'fatal', 'ERR_NETWORK', '网络错误', NULL, NULL, ?, ?, NULL, NULL, NULL)`,
    [`${taskId}:proof:1`, taskId, now - 55_000, now - 50_000],
  );

  // 真机 paused 状态：batch paused_timeout_unknown + item outcome_unknown。
  await updateBatchStatus('b1', 'paused_timeout_unknown', {
    errorCode: 'BATCH_LLM_OUTCOME_UNKNOWN',
  });
  await execute(
    db,
    `UPDATE multi_chapter_batch_items
     SET status = 'outcome_unknown', active_pipeline_task_id = ?,
         error_code = 'BATCH_LLM_OUTCOME_UNKNOWN', error_message = '请求可能已执行，结果未知'
     WHERE batch_id = 'b1' AND ordinal = 1`,
    [taskId],
  );
  return { taskId, chapterId: createdChapterId, frozen };
}

async function waitForReconcileDone(timeoutMs = 45_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!useMultiChapterBatchStore.getState().reconciling) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('reconcile 未在超时内结束');
}

async function attemptsFor(taskId: string): Promise<any[]> {
  return all(
    `SELECT * FROM pipeline_stage_attempts
     WHERE pipeline_task_id = ? ORDER BY stage ASC, attempt_no ASC`,
    [taskId],
  );
}

function chapterFor(chapterId: number): Chapter {
  return {
    id: chapterId,
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

describe('F3-01: batch resume 保留 frozen context（proof failed → 继续）', () => {
  jest.setTimeout(90_000);

  it('resume 后同一 task + 同一 frozen context，只重跑 proof，最终 adoption 成功', async () => {
    await resetDb();
    const { taskId, chapterId, frozen } = await seedProofFailedScenario();

    // resume 前快照
    const before = await one(`SELECT * FROM pipeline_tasks WHERE id = ?`, [
      taskId,
    ]);
    expect(before).not.toBeNull();
    const b = before as any;
    const beforeAttempts = await attemptsFor(taskId);

    mockCallLLMResult = jest.fn(async (messages: unknown[], _tokens: number, config: any) =>
      currentPipelineResult(messages, config),
    );

    await useMultiChapterBatchStore.getState().loadBatch('b1');
    await useMultiChapterBatchStore.getState().resume('b1');
    await waitForReconcileDone();

    // ---- Task identity：同一 taskId，禁止创建新 task ----
    const after = await one(`SELECT * FROM pipeline_tasks WHERE id = ?`, [
      taskId,
    ]);
    expect(after).not.toBeNull();
    const a = after as any;
    expect(a.id).toBe(b.id);

    // ---- Frozen Context：resume 前后完全一致 ----
    // finalize 会按生产语义重算 fingerprint（saveDraftBody），因此这里断言
    // resume 本身不得把它清空（修复前为 null）。
    expect(a.input_fingerprint).not.toBeNull();
    // Kernel Final Closure：resume 会对 pre-closure 冻结的信封做一次性
    // Kernel Trace 回填（只增不改）。剥离附加字段后必须与原冻结完全一致。
    const envelopeAfter = JSON.parse(a.pipeline_context_json);
    const frozenDraftContext = { ...envelopeAfter.draftContext };
    delete frozenDraftContext.writingSourceTrace;
    delete frozenDraftContext.writingKernelTrace;
    delete frozenDraftContext.frozenWritingContext;
    expect(JSON.stringify({ ...envelopeAfter, draftContext: frozenDraftContext })).toBe(
      frozen.pipelineContextJson,
    );
    expect(envelopeAfter.draftContext.writingKernelTrace?.freezeFingerprint).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(Number(a.pipeline_context_version)).toBe(
      frozen.pipelineContextVersion,
    );
    // resume 不再清空 stage_results：proof 成功后被正常追加（修复前清成 []）。
    const afterStageResults = JSON.parse(a.stage_results);
    expect(Array.isArray(afterStageResults)).toBe(true);
    expect(
      afterStageResults.some(
        (s: any) => s.stage === 'proof' && s.status === 'success',
      ),
    ).toBe(true);
    expect(a.created_at).toBe(b.created_at);

    // ---- 成功 stage 不重复执行：attempt 计数不变，proof 恰好 +1 ----
    const afterAttempts = await attemptsFor(taskId);
    const count = (stage: string, rows: any[]) =>
      rows.filter(a => a.stage === stage).length;
    expect(count('draft', afterAttempts)).toBe(count('draft', beforeAttempts));
    expect(count('review', afterAttempts)).toBe(
      count('review', beforeAttempts),
    );
    expect(count('factCheck', afterAttempts)).toBe(
      count('factCheck', beforeAttempts),
    );
    expect(count('proof', afterAttempts)).toBe(
      count('proof', beforeAttempts) + 1,
    );
    const proofSucceeded = afterAttempts.filter(
      a => a.stage === 'proof' && a.status === 'succeeded',
    );
    expect(proofSucceeded).toHaveLength(1);

    // ---- Token 防重复计费：前三个 stage 用量不得增加 ----
    const sumTokens = (stage: string, rows: any[]) =>
      rows
        .filter(a => a.stage === stage)
        .reduce((acc, a) => acc + (a.total_tokens || 0), 0);
    expect(sumTokens('draft', afterAttempts)).toBe(
      sumTokens('draft', beforeAttempts),
    );
    expect(sumTokens('review', afterAttempts)).toBe(
      sumTokens('review', beforeAttempts),
    );
    expect(sumTokens('factCheck', afterAttempts)).toBe(
      sumTokens('factCheck', beforeAttempts),
    );
    // proof 只多一次恢复 attempt
    expect(sumTokens('proof', afterAttempts)).toBe(
      sumTokens('proof', beforeAttempts) + 460,
    );

    // ---- LLM HTTP 调用数量 = 1（只 proof）----
    expect(mockCallLLMResult).toHaveBeenCalledTimes(1);

    // ---- 最终一致性 ----
    expect(String(a.status)).toBe('completed');
    expect(a.resolved_action).toBe('accept');
    expect(String(a.final_text)).toContain('终稿正文');

    const batch = await getBatchById('b1');
    expect(batch?.status).toBe('completed');
    const items = await getBatchItems('b1');
    expect(items[0].status).toBe('succeeded');
    expect(items[0].adoptedRevisionId).not.toBeNull();
    expect(items[0].adoptionFingerprint).not.toBeNull();

    const chapter = await one(`SELECT * FROM chapters WHERE id = ?`, [
      chapterId,
    ]);
    expect(chapter).not.toBeNull();
    expect(String((chapter as any).content)).toContain('终稿正文');
    const revision = await one(`SELECT * FROM content_revisions WHERE id = ?`, [
      items[0].adoptedRevisionId,
    ]);
    expect(revision).not.toBeNull();
    expect((revision as any).source).toBe('pipeline');
  });
});

describe('F3-01: draft 首个失败（无 succeeded stage）路径不受影响', () => {
  jest.setTimeout(90_000);

  it('batch resume：无成功 checkpoint → 解绑创建全新 run，从 draft 完整重跑并 adoption', async () => {
    await resetDb();
    await seedBaseData();
    await createBatch({
      id: 'b2',
      projectId: 1,
      sourcePrompt: 's',
      chapterCount: 1,
      targetWordsPerChapter: 3000,
      pipelineMode: 'full',
    });
    await createBatchItem({
      batchId: 'b2',
      ordinal: 1,
      title: '第1章',
      synopsis: 's',
      keyBeatsJson: '[]',
      targetWords: 3000,
    });
    const createdChapterId = await createBatchChapterForItem('b2', 1, {
      projectId: 1,
      position: 0,
      title: '第1章',
      synopsis: 's',
    });

    const frozen = frozenContext(createdChapterId);
    const taskId = 'task-draft-only-failed';
    const now = Date.now();
    await savePipelineTask({
      id: taskId,
      targetType: 'chapter',
      targetId: createdChapterId,
      status: 'failed',
      stageResults: [],
      finalText: null,
      error: '初稿生成失败',
      inputFingerprint: 'fp-original',
      pipelineContextJson: frozen.pipelineContextJson,
      pipelineContextVersion: frozen.pipelineContextVersion,
      pipelineContextHash: frozen.pipelineContextHash,
      outlineWorkflowVersion: CURRENT_OUTLINE_WORKFLOW_VERSION,
      contextBudgetVersion: CURRENT_CONTEXT_BUDGET_VERSION,
      createdAt: now - 100_000,
      updatedAt: now - 10_000,
      resolvedAt: null,
    });
    const db = await openDatabase();
    const cpCols = `(task_id, stage, status, output_text, error_code, error_message,
       input_tokens, output_tokens, total_tokens, duration_ms, attempt_count,
       started_at, completed_at, updated_at)`;
    await execute(
      db,
      `INSERT INTO pipeline_stage_checkpoints ${cpCols}
       VALUES (?, 'draft', 'failed', NULL, 'ERR_NETWORK', '初稿网络失败',
               NULL, NULL, NULL, 500, 1, ?, ?, ?)`,
      [taskId, now - 55_000, now - 50_000, now - 50_000],
    );
    for (const stage of ['review', 'factCheck', 'brief', 'proof']) {
      await execute(
        db,
        `INSERT INTO pipeline_stage_checkpoints ${cpCols}
         VALUES (?, ?, 'pending', NULL, NULL, NULL,
                 NULL, NULL, NULL, NULL, 0, NULL, NULL, ?)`,
        [taskId, stage, now],
      );
    }
    const attCols = `(id, pipeline_task_id, stage, attempt_no, request_version,
       request_fingerprint, allocation_trace_json, frozen_request_json,
       llm_config_id, llm_config_snapshot_json, client_request_id,
       status, failure_class, error_code, error_message, http_status,
       retry_after_ms, started_at, completed_at, input_tokens, output_tokens, total_tokens)`;
    await execute(
      db,
      `INSERT INTO pipeline_stage_attempts ${attCols}
       VALUES (?, ?, 'draft', 1, 1, 'fp-draft', NULL, NULL, 1, '{}', 'c1',
               'failed', 'fatal', 'ERR_NETWORK', '初稿网络失败', NULL, NULL, ?, ?, NULL, NULL, NULL)`,
      [`${taskId}:draft:1`, taskId, now - 55_000, now - 50_000],
    );
    await updateBatchStatus('b2', 'paused_timeout_unknown', {
      errorCode: 'BATCH_LLM_OUTCOME_UNKNOWN',
    });
    await execute(
      db,
      `UPDATE multi_chapter_batch_items
       SET status = 'outcome_unknown', active_pipeline_task_id = ?,
           error_code = 'BATCH_LLM_OUTCOME_UNKNOWN', error_message = '初稿生成失败'
       WHERE batch_id = 'b2' AND ordinal = 1`,
      [taskId],
    );

    mockCallLLMResult = jest.fn(async (messages: unknown[], _tokens: number, config: any) =>
      currentPipelineResult(messages, config),
    );

    await useMultiChapterBatchStore.getState().loadBatch('b2');
    await useMultiChapterBatchStore.getState().resume('b2');
    await waitForReconcileDone();

    // 无成功 checkpoint → 解绑旧 task，创建新 run；新 task 从 draft 完整跑通。
    const items = await getBatchItems('b2');
    expect(items[0].status).toBe('succeeded');
    expect(items[0].adoptedRevisionId).not.toBeNull();
    expect(items[0].activePipelineTaskId).not.toBe(taskId);

    const newTask = await one(`SELECT * FROM pipeline_tasks WHERE id = ?`, [
      items[0].activePipelineTaskId,
    ]);
    expect(newTask).not.toBeNull();
    expect(String((newTask as any).status)).toBe('completed');
    // New batch (created without topology override) freezes compact(2)
    // (二 Phase §6): the fresh run is draft→review→factCheck → local finalize.
    // No proof node → 3 logical LLM calls instead of the legacy 4.
    expect(mockCallLLMResult).toHaveBeenCalledTimes(3);

    const oldTask = await one(`SELECT * FROM pipeline_tasks WHERE id = ?`, [
      taskId,
    ]);
    // 旧 task 的 frozen context 原样保留（历史审计不丢）。
    expect(oldTask).not.toBeNull();
    expect((oldTask as any).pipeline_context_json).toBe(
      frozen.pipelineContextJson,
    );
    expect((oldTask as any).pipeline_context_hash).toBe(
      frozen.pipelineContextHash,
    );

    const batch = await getBatchById('b2');
    expect(batch?.status).toBe('completed');
  });

  it('结果页"重新尝试"路径：同一 task 从 draft 重跑，frozen context 保留', async () => {
    await resetDb();
    const { chapterId } = await seedBaseData();
    const frozen = frozenContext(chapterId);
    const taskId = 'task-draft-retry-same';
    const now = Date.now();
    await savePipelineTask({
      id: taskId,
      targetType: 'chapter',
      targetId: chapterId,
      status: 'failed',
      stageResults: [],
      finalText: null,
      error: '初稿生成失败',
      inputFingerprint: 'fp-original',
      pipelineContextJson: frozen.pipelineContextJson,
      pipelineContextVersion: frozen.pipelineContextVersion,
      pipelineContextHash: frozen.pipelineContextHash,
      outlineWorkflowVersion: CURRENT_OUTLINE_WORKFLOW_VERSION,
      contextBudgetVersion: CURRENT_CONTEXT_BUDGET_VERSION,
      createdAt: now - 100_000,
      updatedAt: now - 10_000,
      resolvedAt: null,
    });
    const db = await openDatabase();
    const cpCols = `(task_id, stage, status, output_text, error_code, error_message,
       input_tokens, output_tokens, total_tokens, duration_ms, attempt_count,
       started_at, completed_at, updated_at)`;
    await execute(
      db,
      `INSERT INTO pipeline_stage_checkpoints ${cpCols}
       VALUES (?, 'draft', 'failed', NULL, 'ERR_NETWORK', '初稿网络失败',
               NULL, NULL, NULL, 500, 1, ?, ?, ?)`,
      [taskId, now - 55_000, now - 50_000, now - 50_000],
    );
    const attCols = `(id, pipeline_task_id, stage, attempt_no, request_version,
       request_fingerprint, allocation_trace_json, frozen_request_json,
       llm_config_id, llm_config_snapshot_json, client_request_id,
       status, failure_class, error_code, error_message, http_status,
       retry_after_ms, started_at, completed_at, input_tokens, output_tokens, total_tokens)`;
    await execute(
      db,
      `INSERT INTO pipeline_stage_attempts ${attCols}
       VALUES (?, ?, 'draft', 1, 1, 'fp-draft', NULL, NULL, 1, '{}', 'c1',
               'failed', 'fatal', 'ERR_NETWORK', '初稿网络失败', NULL, NULL, ?, ?, NULL, NULL, NULL)`,
      [`${taskId}:draft:1`, taskId, now - 55_000, now - 50_000],
    );

    mockCallLLMResult = jest.fn(async (messages: unknown[], _tokens: number, config: any) =>
      currentPipelineResult(messages, config),
    );

    // PipelineResultScreen.handleResumeFailed 的生产路径：
    // resetFailedStageCheckpointsForResume + 裸 SQL 只改 status +
    // registerPersistedTask（保留 context 字段）+ resumePipeline。
    await resetFailedStageCheckpointsForResume(taskId);
    await execute(
      await openDatabase(),
      `UPDATE pipeline_tasks SET status = 'interrupted', updated_at = ? WHERE id = ?`,
      [Date.now(), taskId],
    );
    usePipelineTaskStore.getState().registerPersistedTask({
      id: taskId,
      targetType: 'chapter',
      targetId: chapterId,
      status: 'interrupted',
      stageResults: [],
      finalText: null,
      error: null,
      inputFingerprint: 'fp-original',
      pipelineContextJson: frozen.pipelineContextJson,
      pipelineContextVersion: frozen.pipelineContextVersion,
      pipelineContextHash: frozen.pipelineContextHash,
      outlineWorkflowVersion: CURRENT_OUTLINE_WORKFLOW_VERSION,
      contextBudgetVersion: CURRENT_CONTEXT_BUDGET_VERSION,
      createdAt: now - 100_000,
      updatedAt: Date.now(),
      resolvedAt: null,
      resolvedAction: null,
    });
    await resumePipeline(taskId, chapterFor(chapterId));

    const task = await one(`SELECT * FROM pipeline_tasks WHERE id = ?`, [
      taskId,
    ]);
    expect(task).not.toBeNull();
    const t = task as any;
    expect(String(t.status)).toBe('completed');
    expect(t.pipeline_context_json).toBe(frozen.pipelineContextJson);
    expect(t.pipeline_context_hash).toBe(frozen.pipelineContextHash);
    // finalize 按生产语义重算 fingerprint；resume 本身不得清空它。
    expect(t.input_fingerprint).not.toBeNull();
    expect(mockCallLLMResult).toHaveBeenCalledTimes(4);

    const attempts = await attemptsFor(taskId);
    const succeeded = attempts.filter(a => a.status === 'succeeded');
    expect(succeeded).toHaveLength(5);
    expect(succeeded.map(a => a.stage)).toEqual([
      'brief',
      'draft',
      'factCheck',
      'proof',
      'review',
    ]);
  });
});
