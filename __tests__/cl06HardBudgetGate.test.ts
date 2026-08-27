/**
 * CL-06: 批次预算真实硬门禁（修复前稳定失败测试）。
 *
 * 修复前 `assertBatchBudgetAvailable` 只检查 `used >= cap`（不含 upcoming
 * 请求），且 used_* 只在整章 Adoption 后由 setBatchUsageFromRuns 更新。
 * 后果：
 *   - 单次请求的 input/output 可能直接打爆 cap 而不被拦截；
 *   - 进行中的 attempts 不计入，跨章/跨重试累计滞后。
 *
 * 本测试驱动真实 reconcilePipelineTask（真实 SQLite + 真实仓储），只 mock
 * LLM 出口，证明：
 *   1. used + estimatedInput > maxInput → 请求前抛 BatchBudgetExceededError，
 *      且 pipeline_stage_attempts 无任何行（不产生账单）；
 *   2. attempt 失败后 used_llm_calls 实时反映（不等 Adoption）；
 *   3. used + 1 > maxLlmCalls → 第二次请求前被阻断。
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
import { usePipelineTaskStore } from '../src/store/pipelineTaskStore';
import { reconcilePipelineTask } from '../src/services/pipeline/reconcile';
import { BatchBudgetExceededError } from '../src/services/pipeline/reconcile';
import { LLMRequestError } from '../src/services/llm/requestPolicy';
import { savePipelineTask } from '../src/data/repositories/pipelineTaskRepository';
import {
  createBatch,
  createBatchItem,
  createItemRun,
  updateBatchStatus,
} from '../src/data/repositories/multiChapterBatchRepository';
import type { Chapter } from '../src/types/novel';
let mockCallLLMResult: jest.Mock = jest.fn();
let testDb: InMemorySqliteDb | null = null;

async function resetDb() {
  __resetForTest();
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

async function seedBaseData(): Promise<number> {
  await execute(
    await openDatabase(),
    `INSERT INTO settings (key, value) VALUES ('pipeline_mode', 'noReview')`,
  );
  await execute(
    await openDatabase(),
    `INSERT INTO llm_config
       (id, name, base_url, api_key, model_name, is_active, provider_type,
        context_window, max_output_tokens)
     VALUES (1, 'm', 'http://127.0.0.1:9/v1', 'k', 'mm', 1,
             'openai_compatible', 8000, 4000)`,
  );
  await execute(
    await openDatabase(),
    `INSERT INTO projects (id, name, mode, created_at, updated_at)
     VALUES (1, 'p', 'outline', 't', 't')`,
  );
  const r = await execute(
    await openDatabase(),
    `INSERT INTO chapters (project_id, position, title, synopsis, content, status, created_at, updated_at)
     VALUES (1, 0, '第1章', '梗概', '', 'draft', 't', 't')`,
  );
  return r.insertId as number;
}

async function seedBatch(budget: {
  maxLlmCalls?: number | null;
  maxInputTokens?: number | null;
  maxOutputTokens?: number | null;
}) {
  await createBatch({
    id: 'b1',
    projectId: 1,
    sourcePrompt: 's',
    chapterCount: 1,
    targetWordsPerChapter: 3000,
    pipelineMode: 'full',
    budget,
  });
  await createBatchItem({
    batchId: 'b1',
    ordinal: 1,
    title: '第1章',
    synopsis: 's',
    keyBeatsJson: '[]',
    targetWords: 3000,
  });
  await updateBatchStatus('b1', 'ready');
}

async function registerTask(taskId: string, chapterId: number) {
  const now = Date.now();
  usePipelineTaskStore.getState().registerPersistedTask({
    id: taskId,
    targetType: 'chapter',
    targetId: chapterId,
    status: 'idle',
    stageResults: [],
    finalText: null,
    error: null,
    inputFingerprint: null,
    pipelineContextJson: null,
    pipelineContextVersion: null,
    pipelineContextHash: null,
    outlineWorkflowVersion: 4,
    contextBudgetVersion: 7,
    pipelineTopologyVersion: 2,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    resolvedAction: null,
  });
  await savePipelineTask({
    id: taskId,
    targetType: 'chapter',
    targetId: chapterId,
    status: 'idle',
    stageResults: [],
    finalText: null,
    error: null,
    outlineWorkflowVersion: 4,
    contextBudgetVersion: 7,
    pipelineTopologyVersion: 2,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
  });
}

function chapterFor(chapterId: number): Chapter {
  return {
    id: chapterId,
    project_id: 1,
    position: 0,
    title: '第1章',
    synopsis: '梗概',
    content: '',
    status: 'draft',
    summary_json: null,
    created_at: 't',
    updated_at: 't',
  };
}

async function attemptCount(): Promise<number> {
  const rows = await all(`SELECT COUNT(*) AS c FROM pipeline_stage_attempts`);
  return Number(rows[0].c ?? 0);
}

async function waitForPersistedRetry(taskId: string): Promise<void> {
  const row = await one<{ next_retry_at: number | null }>(
    `SELECT next_retry_at
       FROM pipeline_stage_attempts
      WHERE pipeline_task_id = ?
      ORDER BY attempt_no DESC
      LIMIT 1`,
    [taskId],
  );
  const nextRetryAt = Number(row?.next_retry_at ?? 0);
  const remainingMs = nextRetryAt - Date.now();
  if (remainingMs > 0) {
    // The production retry schedule is intentionally jittered.  Wait for the
    // persisted deadline instead of racing a second reconcile against it.
    await new Promise<void>(resolve => {
      setTimeout(resolve, remainingMs + 25);
    });
  }
}

describe('CL-06: 真实硬门禁 used + upcoming <= cap', () => {
  jest.setTimeout(60_000);

  it('estimatedInput + used > maxInput → 请求前阻断，且无 attempt 行（不产生账单）', async () => {
    await resetDb();
    const chapterId = await seedBaseData();
    await seedBatch({ maxInputTokens: 200, maxOutputTokens: 100_000 });
    const taskId = 't-budget-1';
    await registerTask(taskId, chapterId);
    const chapter = chapterFor(chapterId);

    mockCallLLMResult = jest.fn().mockImplementation(async () => ({
      text: '正文',
      inputTokens: 100,
      outputTokens: 100,
      totalTokens: 200,
      emptyReason: null,
    }));

    // 真实 reconcile：draft 编译（estimatedInput 来自编译结果，通常远超
    // 500）→ gate 必须在使用前拦截。
    let caught: any = null;
    try {
      await reconcilePipelineTask(taskId, chapter, {
        batchBudgetGate: { batchId: 'b1' },
      });
    } catch (e: any) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BatchBudgetExceededError);
    expect(caught.cap).toBe('input');
    // 阻断发生在请求之前 —— 不产生任何 attempt / 账单。
    expect(await attemptCount()).toBe(0);
    expect(mockCallLLMResult).not.toHaveBeenCalled();
  });

  it('attempt 失败后 used_llm_calls 实时反映（不等 Adoption）', async () => {
    await resetDb();
    const chapterId = await seedBaseData();
    await seedBatch({ maxLlmCalls: 5, maxOutputTokens: 100_000 });
    const taskId = 't-budget-2';
    await registerTask(taskId, chapterId);
    const chapter = chapterFor(chapterId);

    // 真实批次绑定：item_runs 行让 setBatchUsageFromRuns 能聚合到本 task。
    await createItemRun({
      batchId: 'b1',
      ordinal: 1,
      runNo: 1,
      pipelineTaskId: taskId,
      llmConfigSnapshotJson: '{}',
      reason: 'batch_start',
    });

    // 第一次抛 safe_retry；第二次成功前检查 used 已实时入账。
    let checkedUsage = false;
    mockCallLLMResult = jest
      .fn()
      .mockImplementationOnce(async () => {
        throw new LLMRequestError('transient', 'transient', undefined, {
          httpStatus: 503,
          retryAfterMs: 0,
          failureClass: 'safe_retry',
          requestMayHaveExecuted: false,
        });
      })
      .mockImplementationOnce(async () => {
        // 第二次请求发起时：第一次 attempt 已终态 → used 必须已入账。
        const row = await one(
          `SELECT used_llm_calls, used_input_tokens FROM multi_chapter_batches WHERE id = 'b1'`,
        );
        checkedUsage = true;
        expect(Number(row?.used_llm_calls ?? 0)).toBe(1);
        // This synthetic provider failure explicitly declares
        // requestMayHaveExecuted=false, so no input usage is billable for
        // attempt 1 even though the call itself is counted.
        expect(Number(row?.used_input_tokens ?? 0)).toBe(0);
        return {
          text: '正文',
          inputTokens: 100,
          outputTokens: 100,
          totalTokens: 200,
          emptyReason: null,
        };
      });

    await reconcilePipelineTask(taskId, chapter, {
      batchBudgetGate: { batchId: 'b1' },
    });
    await waitForPersistedRetry(taskId);
    await reconcilePipelineTask(taskId, chapter, {
      batchBudgetGate: { batchId: 'b1' },
    });

    expect(checkedUsage).toBe(true);
    const final = await one(
      `SELECT used_llm_calls FROM multi_chapter_batches WHERE id = 'b1'`,
    );
    expect(Number(final?.used_llm_calls ?? 0)).toBe(2);
  });

  it('used + 1 > maxLlmCalls → 第二次请求前被阻断', async () => {
    await resetDb();
    const chapterId = await seedBaseData();
    await seedBatch({ maxLlmCalls: 1, maxOutputTokens: 100_000 });
    const taskId = 't-budget-3';
    await registerTask(taskId, chapterId);
    const chapter = chapterFor(chapterId);
    // 真实批次绑定：item_runs 行让 used 聚合能覆盖本 task。
    await createItemRun({
      batchId: 'b1',
      ordinal: 1,
      runNo: 1,
      pipelineTaskId: taskId,
      llmConfigSnapshotJson: '{}',
      reason: 'batch_start',
    });

    // 第一次请求抛 safe_retry（attempt 1，used 0 + 1 <= 1 放行）；
    // 第二次重试请求前 used 已实时入账 =1 → 1 + 1 > 1 → 调用数门禁阻断。
    mockCallLLMResult = jest.fn().mockImplementation(async () => {
      throw new LLMRequestError('transient', 'transient', undefined, {
        httpStatus: 503,
        retryAfterMs: 0,
        failureClass: 'safe_retry',
        requestMayHaveExecuted: false,
      });
    });

    // 第一次 reconcile：attempt 1 失败（safe_to_retry）。
    await reconcilePipelineTask(taskId, chapter, {
      batchBudgetGate: { batchId: 'b1' },
    });
    expect(mockCallLLMResult).toHaveBeenCalledTimes(1);

    // 第二次 reconcile（重试）：used(1) + 1 > maxLlmCalls(1) → 请求前阻断。
    await waitForPersistedRetry(taskId);
    let caught: any = null;
    try {
      await reconcilePipelineTask(taskId, chapter, {
        batchBudgetGate: { batchId: 'b1' },
      });
    } catch (e: any) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BatchBudgetExceededError);
    expect(caught.cap).toBe('calls');
    // 阻断发生在请求之前 —— LLM 未再被调用，attempt 未新增。
    expect(mockCallLLMResult).toHaveBeenCalledTimes(1);
    expect(await attemptCount()).toBe(1);
  });
});
