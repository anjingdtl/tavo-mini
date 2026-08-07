/**
 * CL-01: safe_retry 真实生产链路（修复前稳定失败测试）。
 *
 * 与既有 BN-01 测试不同，本测试**不 mock runner、不手工写 attempt/checkpoint**，
 * 而是驱动真实的 `reconcilePipelineTask`（真实 in-memory SQLite + 真实仓储 +
 * 真实 pipelineTaskStore），只替换唯一的 LLM 网络出口 `callLLMResult`：
 *
 *   LLMRequestError(safe_retry)
 *   → runStageAttempt（真实：写 pipeline_stage_attempts=safe_to_retry + nextRetryAt）
 *   → persistStage（真实：checkpoint draft=failed）
 *   → 再次 reconcile（resume）
 *   → retry disposition 必须被消费（不得先被 STAGE_FAILED 阻断）
 *   → checkpoint 重置 pending → 重跑 draft → 成功 → 任务 completed
 *
 * 修复前：第二次 reconcile 被 `determineNextPipelineAction` 的
 * blocked(STAGE_FAILED) 提前阻断，任务永远 failed，自动重试不可达。
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
import { all } from '../src/data/connection/query';
import { usePipelineTaskStore } from '../src/store/pipelineTaskStore';
import { reconcilePipelineTask } from '../src/services/pipeline/reconcile';
import {
  determineRetryDisposition,
} from '../src/services/pipeline/determineNextPipelineAction';
import { LLMRequestError } from '../src/services/llm/requestPolicy';
import { savePipelineTask } from '../src/data/repositories/pipelineTaskRepository';
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
      // ignore
    }
    testDb = null;
  }
});

async function seedBaseData(): Promise<{ chapterId: number }> {
  // 空库直接跑 noReview 流水线：draft → finalize_from_draft → complete。
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
  const chapterResult = await execute(
    await openDatabase(),
    `INSERT INTO chapters (project_id, position, title, synopsis, content, status, created_at, updated_at)
     VALUES (1, 0, '第1章', '梗概', '', 'draft', 't', 't')`,
  );
  return { chapterId: chapterResult.insertId as number };
}

async function registerTask(
  taskId: string,
  chapterId: number,
  status: string,
): Promise<void> {
  const now = Date.now();
  // 生产路径：pipeline_tasks 行先入库（store.createTask 的事务），再注册内存。
  // 不写入真实行会导致 checkpoint 的 FK 约束失败。
  usePipelineTaskStore.getState().registerPersistedTask({
    id: taskId,
    targetType: 'chapter',
    targetId: chapterId,
    status: status as any,
    stageResults: [],
    finalText: null,
    error: null,
    inputFingerprint: null,
    pipelineContextJson: null,
    pipelineContextVersion: null,
    pipelineContextHash: null,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    resolvedAction: null,
  });
  await savePipelineTask({
    id: taskId,
    targetType: 'chapter',
    targetId: chapterId,
    status,
    stageResults: [],
    finalText: null,
    error: null,
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

async function attemptsFor(taskId: string): Promise<any[]> {
  return all(
    `SELECT * FROM pipeline_stage_attempts
     WHERE pipeline_task_id = ? ORDER BY attempt_no ASC`,
    [taskId],
  );
}

describe('CL-01: safe_retry 真实 reconcile 链路（不 mock 状态机）', () => {
  jest.setTimeout(60_000);

  it('safe_retry 失败后 resume 必须自动重试并成功（不被 STAGE_FAILED 阻断）', async () => {
    await resetDb();
    const { chapterId } = await seedBaseData();
    const taskId = 't-cl01';
    await registerTask(taskId, chapterId, 'idle');
    const chapter = chapterFor(chapterId);

    // 第一次 LLM 调用抛 safe_retry，之后返回正常正文。
    mockCallLLMResult = jest
      .fn()
      .mockImplementationOnce(async () => {
        throw new LLMRequestError('transient 503', 'transient', undefined, {
          httpStatus: 503,
          retryAfterMs: 0,
          failureClass: 'safe_retry',
          requestMayHaveExecuted: false,
        });
      })
      .mockImplementationOnce(async () => ({
        text: '第一章正文。',
        inputTokens: 100,
        outputTokens: 200,
        totalTokens: 300,
        emptyReason: null,
      }));

    // 第一次 reconcile：真实链路写出 attempt=safe_to_retry + checkpoint=failed。
    await reconcilePipelineTask(taskId, chapter);

    let attempts = await attemptsFor(taskId);
    expect(attempts.length).toBe(1);
    expect(attempts[0].status).toBe('safe_to_retry');
    expect(attempts[0].failure_class).toBe('safe_retry');

    const checkpointRows = await all(
      `SELECT * FROM pipeline_stage_checkpoints WHERE task_id = ? AND stage = 'draft'`,
      [taskId],
    );
    expect(checkpointRows[0].status).toBe('failed');

    let taskRow = await all(
      `SELECT * FROM pipeline_tasks WHERE id = ?`,
      [taskId],
    );
    expect(taskRow[0].status).toBe('failed');

    // 第二次 reconcile（resume）：retry disposition 必须先于 STAGE_FAILED 消费。
    // 修复前：任务仍 failed，checkpoint 仍 failed —— 自动重试被阻断。
    await reconcilePipelineTask(taskId, chapter);

    taskRow = await all(`SELECT * FROM pipeline_tasks WHERE id = ?`, [taskId]);
    expect(taskRow[0].status).toBe('completed');

    attempts = await attemptsFor(taskId);
    const succeeded = attempts.filter(a => a.status === 'succeeded');
    expect(succeeded.length).toBe(1);
    // 重试必须复用同一 frozen request fingerprint（不重新编译上下文）。
    expect(attempts[1].request_fingerprint).toBe(attempts[0].request_fingerprint);

    const draftCheckpoint = await all(
      `SELECT * FROM pipeline_stage_checkpoints WHERE task_id = ? AND stage = 'draft'`,
      [taskId],
    );
    expect(draftCheckpoint[0].status).toBe('succeeded');
  });

  it('outcome_unknown 不自动重试：任务失败并给出确认提示', async () => {
    await resetDb();
    const { chapterId } = await seedBaseData();
    const taskId = 't-cl01-unknown';
    await registerTask(taskId, chapterId, 'idle');
    const chapter = chapterFor(chapterId);

    mockCallLLMResult = jest.fn().mockImplementation(async () => {
      throw new LLMRequestError('timeout', 'timeout', undefined, {
        failureClass: 'outcome_unknown',
        requestMayHaveExecuted: true,
      });
    });

    await reconcilePipelineTask(taskId, chapter);

    // 第一次失败后 resume：outcome_unknown → manual_confirm，不得自动重试。
    await reconcilePipelineTask(taskId, chapter);

    const taskRow = await all(
      `SELECT * FROM pipeline_tasks WHERE id = ?`,
      [taskId],
    );
    expect(taskRow[0].status).toBe('failed');
    expect(String(taskRow[0].error)).toContain('结果未知');

    const attempts = await attemptsFor(taskId);
    expect(attempts.length).toBe(1);
    expect(attempts[0].status).toBe('outcome_unknown');
    // 没有第二个 attempt —— 绝不自动重试未知结果。
  });
});

describe('determineRetryDisposition（纯函数全分支）', () => {
  const now = Date.now();

  it('safe_to_retry 未到期 → wait_retry', () => {
    expect(
      determineRetryDisposition({
        status: 'safe_to_retry',
        failureClass: 'safe_retry',
        attemptNo: 1,
        nextRetryAt: now + 30_000,
      }),
    ).toEqual({ kind: 'wait_retry', retryAt: now + 30_000 });
  });

  it('safe_to_retry 已到期且未超限 → retry_now', () => {
    expect(
      determineRetryDisposition({
        status: 'safe_to_retry',
        failureClass: 'rate_limit',
        attemptNo: 2,
        nextRetryAt: now - 1000,
      }),
    ).toEqual({ kind: 'retry_now' });
  });

  it('safe_to_retry 超过最大重试次数 → manual_pause', () => {
    const d = determineRetryDisposition({
      status: 'safe_to_retry',
      failureClass: 'safe_retry',
      attemptNo: 4,
      nextRetryAt: now - 1000,
    });
    expect(d.kind).toBe('manual_pause');
  });

  it('outcome_unknown → manual_confirm（绝不自动重试）', () => {
    expect(
      determineRetryDisposition({
        status: 'outcome_unknown',
        failureClass: 'outcome_unknown',
        attemptNo: 1,
        nextRetryAt: null,
      }).kind,
    ).toBe('manual_confirm');
  });

  it('其他失败 → fail（保持原 STAGE_FAILED 语义）', () => {
    expect(
      determineRetryDisposition({
        status: 'failed',
        failureClass: 'fatal',
        attemptNo: 1,
        nextRetryAt: null,
      }),
    ).toEqual({ kind: 'fail' });
  });
});
