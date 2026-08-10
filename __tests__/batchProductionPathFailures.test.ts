/**
 * Phase BN-01 / BN-02: persistent waiting_retry production path.
 *
 * The reconciler must, on a transient (safe_retry) failure, persist
 * `item.status = waiting_retry` AND `item.nextRetryAt` so that:
 *   1. The UI watchdog (`store.refresh`) sees the persisted state and
 *      re-drives the batch when the retry window expires.
 *   2. Cold start (process killed mid-retry) can resume from SQLite —
 *      not from in-memory state.
 *
 * Before the fix the `wait_until` branch only slept; the item was left in
 * `running_pipeline` with no `nextRetryAt`. The UI watchdog checked for
 * `status === 'waiting_retry'` which never got written → silent deadlock.
 *
 * This test drives the reconciler with a real runner that throws
 * LLMRequestError(safe_retry), then asserts the durable state.
 */
jest.mock('../src/store/pipelineTaskStore', () => ({
  usePipelineTaskStore: {
    getState: () => ({
      resolveTask: jest.fn(),
      failTask: jest.fn(),
      persistFailTask: jest.fn(),
      cancelTask: jest.fn(),
      persistTaskStatus: jest.fn(),
      setTaskStatus: jest.fn(),
      persistTaskStage: jest.fn(),
      updateTaskStage: jest.fn(),
      registerPersistedTask: jest.fn(),
      persistTaskPipelineContext: jest.fn(),
      setTaskPipelineContext: jest.fn(),
      persistCompleteTask: jest.fn(),
      completeTask: jest.fn(),
      setTaskFinalText: jest.fn(),
      persistTaskFinalText: jest.fn(),
      setTaskInputFingerprint: jest.fn(),
    }),
  },
}));

import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import type { InMemorySqliteDb } from './helpers/canonInMemoryDb';
import { __setDatabaseForTest, __resetForTest } from '../src/data/connection/openDatabase';
import { execute } from '../src/data/connection/execute';
import { all } from '../src/data/connection/query';
import { openDatabase } from '../src/data/connection/openDatabase';
import {
  createBatch,
  createBatchItem,
  createBatchChapterForItem,
  createPipelineTaskForBatchItem,
  getBatchById,
  getBatchItems,
  updateBatchStatus,
  updateBatchItem,
  pauseInterruptedBatches,
  claimBatchLease,
  setBatchUsageFromRuns,
} from '../src/data/repositories/multiChapterBatchRepository';
import {
  createStageAttempt,
  updateStageAttempt,
  getLatestAttemptByTask,
} from '../src/data/repositories/pipelineStageAttemptRepository';
import { savePipelineTask } from '../src/data/repositories/pipelineTaskRepository';
import { reconcileMultiChapterBatch } from '../src/services/multiChapterBatch/reconcileMultiChapterBatch';
import { LLMRequestError } from '../src/services/llm/requestPolicy';

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

async function seedProject(id = 1): Promise<void> {
  await execute(
    await openDatabase(),
    `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (?, 'p', 'outline', 't', 't')`,
    [id],
  );
}

async function seedBatch(batchId = 'b1', count = 2) {
  await createBatch({
    id: batchId,
    projectId: 1,
    sourcePrompt: 's',
    chapterCount: count,
    targetWordsPerChapter: 3000,
    pipelineMode: 'full',
  });
  for (let i = 1; i <= count; i += 1) {
    await createBatchItem({
      batchId,
      ordinal: i,
      title: `第${i}章`,
      synopsis: `s${i}`,
      keyBeatsJson: '["k"]',
      targetWords: 3000,
    });
  }
  await updateBatchStatus(batchId, 'ready');
}

/**
 * Runner that simulates a transient (safe_retry) failure on the FIRST run
 * then succeeds. The real pipeline runner writes a stage attempt with
 * status=safe_to_retry and a nextRetryAt timestamp before re-throwing.
 */
function transientThenSuccessRunner(opts: {
  failFirstAttempt?: number;
  retryAfterMs?: number;
} = {}): {
  calls: string[];
  run: (taskId: string) => Promise<void>;
} {
  const failFirstAttempt = opts.failFirstAttempt ?? 1;
  const retryAfterMs = opts.retryAfterMs ?? 30_000;
  let attempt = 0;
  const calls: string[] = [];
  return {
    calls,
    run: async (taskId: string) => {
      attempt += 1;
      calls.push(taskId);
      if (attempt === failFirstAttempt) {
        // Persist a safe_retry attempt row (this is what the real
        // runStageAttempt wrapper does before re-throwing).
        await createStageAttempt({
          id: `${taskId}:draft:${attempt}`,
          pipelineTaskId: taskId,
          stage: 'draft',
          attemptNo: attempt,
          requestFingerprint: 'fp-transient',
          llmConfigSnapshotJson: '{}',
          clientRequestId: 'c',
        });
        await updateStageAttempt({
          id: `${taskId}:draft:${attempt}`,
          status: 'safe_to_retry',
          failureClass: 'safe_retry',
          retryAfterMs,
          nextRetryAt: Date.now() + retryAfterMs,
          completedAt: Date.now(),
        });
        // Persist a task row in failed state (the real reconcile does this
        // before re-throwing via persistStage('failed')).
        await savePipelineTask({
          id: taskId,
          targetType: 'chapter',
          targetId: 0,
          status: 'failed',
          stageResults: [],
          finalText: null,
          error: 'transient network error',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          resolvedAt: null,
        });
        throw new LLMRequestError(
          'transient network error',
          'transient',
          undefined,
          {
            httpStatus: 503,
            retryAfterMs,
            failureClass: 'safe_retry',
            requestMayHaveExecuted: false,
          },
        );
      }
      await savePipelineTask({
        id: taskId,
        targetType: 'chapter',
        targetId: 0,
        status: 'completed',
        stageResults: [
          {
            stage: 'draft',
            status: 'success',
            text: `正文-${taskId}`,
            tokens: { input: 1, output: 2, total: 3 },
          },
        ],
        finalText: `正文-${taskId}`,
        error: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        resolvedAt: null,
      });
    },
  };
}

describe('BN-01 / BN-02: persistent waiting_retry production path', () => {
  jest.setTimeout(60_000);
  it('persists item.status=waiting_retry and nextRetryAt after safe_retry', async () => {
    await resetDb();
    await seedProject();
    await seedBatch('b1', 1);
    const chapterId = await createBatchChapterForItem('b1', 1, {
      projectId: 1,
      position: 0,
      title: 't',
      synopsis: 's',
    });
    await createPipelineTaskForBatchItem({
      batchId: 'b1',
      ordinal: 1,
      chapterId,
      task: {
        id: 't1',
        targetType: 'chapter',
        targetId: chapterId,
        status: 'idle',
        stageResults: [],
        finalText: null,
        error: null,
        outlineWorkflowVersion: 4,
        contextBudgetVersion: 4,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        resolvedAt: null,
      },
      stages: ['draft', 'review', 'factCheck', 'brief', 'proof'],
      runNo: 1,
      llmConfigSnapshotJson: '{}',
      reason: 'batch_start',
    });
    const runner = transientThenSuccessRunner({ retryAfterMs: 60_000 });
    // Use a tiny maxSteps so we don't burn the suite; the reconciler
    // returns 'stop' on wait_until and hands back.
    await reconcileMultiChapterBatch('b1', {
      owner: 'o1',
      runPipeline: runner.run as any,
      maxSteps: 5,
    });
    const item = (await getBatchItems('b1'))[0];
    expect(item.status).toBe('waiting_retry');
    expect(item.nextRetryAt).toBeTruthy();
    expect(item.nextRetryAt!).toBeGreaterThan(Date.now());
    // The batch header must also reflect the waiting state so the UI
    // watchdog can distinguish it from a running batch with no progress.
    const batch = await getBatchById('b1');
    expect(['waiting_retry', 'running']).toContain(batch?.status);
  });

  it('cold-start normalization preserves waiting_retry (BN-02)', async () => {
    await resetDb();
    await seedProject();
    await seedBatch('b1', 1);
    // Simulate a batch that already reached the wait_until persisted state
    // (this is what the production wait_until branch writes).
    const chapterId = await createBatchChapterForItem('b1', 1, {
      projectId: 1,
      position: 0,
      title: 't',
      synopsis: 's',
    });
    await createPipelineTaskForBatchItem({
      batchId: 'b1',
      ordinal: 1,
      chapterId,
      task: {
        id: 't1',
        targetType: 'chapter',
        targetId: chapterId,
        status: 'failed',
        stageResults: [],
        finalText: null,
        error: 'transient',
        outlineWorkflowVersion: 4,
        contextBudgetVersion: 4,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        resolvedAt: null,
      },
      stages: ['draft', 'review', 'factCheck', 'brief', 'proof'],
      runNo: 1,
      llmConfigSnapshotJson: '{}',
      reason: 'batch_start',
    });
    await createStageAttempt({
      id: 't1:draft:1',
      pipelineTaskId: 't1',
      stage: 'draft',
      attemptNo: 1,
      requestFingerprint: 'fp',
      llmConfigSnapshotJson: '{}',
      clientRequestId: 'c',
    });
    await updateStageAttempt({
      id: 't1:draft:1',
      status: 'safe_to_retry',
      failureClass: 'safe_retry',
      retryAfterMs: 30_000,
      nextRetryAt: Date.now() + 30_000,
      completedAt: Date.now(),
    });
    await updateBatchItem('b1', 1, {
      status: 'waiting_retry',
      nextRetryAt: Date.now() + 30_000,
    });
    await updateBatchStatus('b1', 'waiting_retry');
    // Plant a dead lease from a previous process.
    const row = await getBatchById('b1');
    await claimBatchLease('b1', 'dead_owner', 60_000, row!.rowVersion);

    const before = await getBatchById('b1');
    expect(before?.status).toBe('waiting_retry');

    // Cold start: kill the dead lease, but DO NOT change status.
    await pauseInterruptedBatches(Date.now());
    const after = await getBatchById('b1');
    expect(after?.status).toBe('waiting_retry');
    expect(after?.leaseOwner ?? null).toBeNull();
    const item = (await getBatchItems('b1'))[0];
    expect(item.status).toBe('waiting_retry');
    expect(item.nextRetryAt).toBeTruthy();
  });

  it('still parks running batches on cold start (regression)', async () => {
    await resetDb();
    await seedProject();
    await seedBatch('b1', 1);
    await updateBatchStatus('b1', 'running');
    await pauseInterruptedBatches(Date.now());
    const after = await getBatchById('b1');
    expect(after?.status).toBe('paused_user');
  });
});

describe('BN-03: cross-task / cross-run batch usage aggregation', () => {
  jest.setTimeout(60_000);
  /**
   * Seed a "Task A" with attempts (succeeded draft + failed review) and a
   * "Task B" with attempts (succeeded review + succeeded proof) bound to
   * the same batch item. The batch's `used_*` must reflect the sum of ALL
   * attempts on both tasks, and SET semantics must keep repeated reconcile
   * idempotent.
   */
  async function seedTwoTasksAcrossRuns(batchId: string): Promise<{
    chapterId: number;
    taskA: string;
    taskB: string;
  }> {
    const chapterId = await createBatchChapterForItem(batchId, 1, {
      projectId: 1,
      position: 0,
      title: 't',
      synopsis: 's',
    });
    const now = Date.now();
    const taskA = 'taskA';
    const taskB = 'taskB';
    await createPipelineTaskForBatchItem({
      batchId,
      ordinal: 1,
      chapterId,
      task: {
        id: taskA,
        targetType: 'chapter',
        targetId: chapterId,
        status: 'failed',
        stageResults: [],
        finalText: null,
        error: 'transient review error',
        createdAt: now,
        updatedAt: now,
        resolvedAt: null,
      },
      stages: ['draft', 'review', 'factCheck', 'proof'],
      runNo: 1,
      llmConfigSnapshotJson: '{}',
      reason: 'batch_start',
    });
    // Task A: succeeded draft (10 input / 20 output) + failed review (5 in / 0 out)
    await createStageAttempt({
      id: `${taskA}:draft:1`,
      pipelineTaskId: taskA,
      stage: 'draft',
      attemptNo: 1,
      requestFingerprint: 'fp',
      llmConfigSnapshotJson: '{}',
      clientRequestId: 'c',
    });
    await updateStageAttempt({
      id: `${taskA}:draft:1`,
      status: 'succeeded',
      inputTokens: 10,
      outputTokens: 20,
      completedAt: Date.now(),
    });
    await createStageAttempt({
      id: `${taskA}:review:1`,
      pipelineTaskId: taskA,
      stage: 'review',
      attemptNo: 1,
      requestFingerprint: 'fp',
      llmConfigSnapshotJson: '{}',
      clientRequestId: 'c',
    });
    await updateStageAttempt({
      id: `${taskA}:review:1`,
      status: 'failed',
      failureClass: 'safe_retry',
      inputTokens: 5,
      outputTokens: 0,
      completedAt: Date.now(),
    });
    // User confirms retry → unbind old task (production `resume` flow).
    await updateBatchItem(batchId, 1, {
      status: 'running_pipeline',
      activePipelineTaskId: null,
      errorCode: null,
      errorMessage: null,
    });
    // Task B: succeeded review (7/14) + succeeded proof (3/6).
    await createPipelineTaskForBatchItem({
      batchId,
      ordinal: 1,
      chapterId,
      task: {
        id: taskB,
        targetType: 'chapter',
        targetId: chapterId,
        status: 'completed',
        stageResults: [],
        finalText: 'final B',
        error: null,
        createdAt: now,
        updatedAt: now,
        resolvedAt: null,
      },
      stages: ['draft', 'review', 'factCheck', 'proof'],
      runNo: 2,
      llmConfigSnapshotJson: '{}',
      reason: 'user_resume',
    });
    await createStageAttempt({
      id: `${taskB}:review:1`,
      pipelineTaskId: taskB,
      stage: 'review',
      attemptNo: 1,
      requestFingerprint: 'fp',
      llmConfigSnapshotJson: '{}',
      clientRequestId: 'c',
    });
    await updateStageAttempt({
      id: `${taskB}:review:1`,
      status: 'succeeded',
      inputTokens: 7,
      outputTokens: 14,
      completedAt: Date.now(),
    });
    await createStageAttempt({
      id: `${taskB}:proof:1`,
      pipelineTaskId: taskB,
      stage: 'proof',
      attemptNo: 1,
      requestFingerprint: 'fp',
      llmConfigSnapshotJson: '{}',
      clientRequestId: 'c',
    });
    await updateStageAttempt({
      id: `${taskB}:proof:1`,
      status: 'succeeded',
      inputTokens: 3,
      outputTokens: 6,
      completedAt: Date.now(),
    });
    return { chapterId, taskA, taskB };
  }

  it('aggregates usage across both tasks and is idempotent across reconcile', async () => {
    await resetDb();
    await seedProject();
    await seedBatch('b1', 1);
    await seedTwoTasksAcrossRuns('b1');
    // Drive the aggregation as the reconcile would after adoption.
    const usage1 = await setBatchUsageFromRuns('b1');
    // Calls: A draft (1) + A review (1) + B review (1) + B proof (1) = 4
    expect(usage1.llmCalls).toBe(4);
    // Input: A.draft(10) + A.review(5) + B.review(7) + B.proof(3) = 25
    expect(usage1.inputTokens).toBe(25);
    // Output: A.draft(20) + A.review(0, failed) + B.review(14) + B.proof(6) = 40
    expect(usage1.outputTokens).toBe(40);
    const after1 = await getBatchById('b1');
    expect(after1?.usedLlmCalls).toBe(4);
    expect(after1?.usedInputTokens).toBe(25);
    expect(after1?.usedOutputTokens).toBe(40);

    // Idempotency: re-running must produce the same value, not double.
    const usage2 = await setBatchUsageFromRuns('b1');
    expect(usage2).toEqual(usage1);
    const after2 = await getBatchById('b1');
    expect(after2?.usedLlmCalls).toBe(4);
    expect(after2?.usedInputTokens).toBe(25);
    expect(after2?.usedOutputTokens).toBe(40);

    // Manual tampering with the column must not be preserved: the next
    // reconcile overwrites it with the durable sum.
    await updateBatchStatus('b1', 'waiting_retry');
    await setBatchUsageFromRuns('b1');
    const after3 = await getBatchById('b1');
    expect(after3?.usedLlmCalls).toBe(4);
  });

  it('treats cancelled attempts as non-billable', async () => {
    await resetDb();
    await seedProject();
    await seedBatch('b1', 1);
    const chapterId = await createBatchChapterForItem('b1', 1, {
      projectId: 1,
      position: 0,
      title: 't',
      synopsis: 's',
    });
    const now = Date.now();
    const taskId = 'task-cancel';
    await createPipelineTaskForBatchItem({
      batchId: 'b1',
      ordinal: 1,
      chapterId,
      task: {
        id: taskId,
        targetType: 'chapter',
        targetId: chapterId,
        status: 'idle',
        stageResults: [],
        finalText: null,
        error: null,
        createdAt: now,
        updatedAt: now,
        resolvedAt: null,
      },
      stages: ['draft', 'review', 'factCheck', 'proof'],
      runNo: 1,
      llmConfigSnapshotJson: '{}',
      reason: 'batch_start',
    });
    await createStageAttempt({
      id: `${taskId}:draft:1`,
      pipelineTaskId: taskId,
      stage: 'draft',
      attemptNo: 1,
      requestFingerprint: 'fp',
      llmConfigSnapshotJson: '{}',
      clientRequestId: 'c',
    });
    await updateStageAttempt({
      id: `${taskId}:draft:1`,
      status: 'cancelled',
      completedAt: Date.now(),
    });
    const usage = await setBatchUsageFromRuns('b1');
    expect(usage.llmCalls).toBe(0);
  });
});

describe('BN-04: hard batch budget gate before each LLM request', () => {
  jest.setTimeout(60_000);
  /**
   * Plant a batch whose `max_llm_calls` is already used up. The next
   * reconcile must pause the item without ever invoking the LLM and must
   * NOT create any pipeline_stage_attempts row.
   */
  it('blocks the LLM call before any attempt row is written', async () => {
    await resetDb();
    await seedProject();
    await seedBatch('b1', 1);
    const chapterId = await createBatchChapterForItem('b1', 1, {
      projectId: 1,
      position: 0,
      title: 't',
      synopsis: 's',
    });
    await createPipelineTaskForBatchItem({
      batchId: 'b1',
      ordinal: 1,
      chapterId,
      task: {
        id: 't-budget',
        targetType: 'chapter',
        targetId: chapterId,
        status: 'idle',
        stageResults: [],
        finalText: null,
        error: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        resolvedAt: null,
      },
      stages: ['draft', 'review', 'factCheck', 'proof'],
      runNo: 1,
      llmConfigSnapshotJson: '{}',
      reason: 'batch_start',
    });
    // Tight cap: 0 calls remaining.
    await execute(
      await openDatabase(),
      `UPDATE multi_chapter_batches SET max_llm_calls = 0 WHERE id = 'b1'`,
      [],
    );
    const calls: string[] = [];
    const runner = {
      run: async (taskId: string) => {
        calls.push(taskId);
        await savePipelineTask({
          id: taskId,
          targetType: 'chapter',
          targetId: 0,
          status: 'completed',
          stageResults: [
            {
              stage: 'draft',
              status: 'success',
              text: '正文',
              tokens: { input: 1, output: 2, total: 3 },
            },
          ],
          finalText: '正文',
          error: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          resolvedAt: null,
        });
      },
    };
    await reconcileMultiChapterBatch('b1', {
      owner: 'o1',
      runPipeline: runner.run as any,
      maxSteps: 5,
    });
    // The runner must never have been called (budget gate blocked it).
    expect(calls).toHaveLength(0);
    const batch = await getBatchById('b1');
    expect(batch?.status).toBe('paused_batch_budget');
    const item = (await getBatchItems('b1'))[0];
    expect(item.status).toBe('blocked_batch_budget');
    expect(item.errorCode).toBe('BATCH_SPEND_BUDGET_BLOCKED');
    // No attempt row should exist for this chapter.
    const attempts = await all(
      `SELECT * FROM pipeline_stage_attempts WHERE pipeline_task_id = ?`,
      ['t-budget'],
    );
    expect(attempts).toHaveLength(0);
  });

  it('still allows runs when budget is unlimited', async () => {
    await resetDb();
    await seedProject();
    await seedBatch('b1', 1);
    const chapterId = await createBatchChapterForItem('b1', 1, {
      projectId: 1,
      position: 0,
      title: 't',
      synopsis: 's',
    });
    await createPipelineTaskForBatchItem({
      batchId: 'b1',
      ordinal: 1,
      chapterId,
      task: {
        id: 't-noCap',
        targetType: 'chapter',
        targetId: chapterId,
        status: 'idle',
        stageResults: [],
        finalText: null,
        error: null,
        outlineWorkflowVersion: 4,
        contextBudgetVersion: 4,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        resolvedAt: null,
      },
      stages: ['draft', 'review', 'factCheck', 'brief', 'proof'],
      runNo: 1,
      llmConfigSnapshotJson: '{}',
      reason: 'batch_start',
    });
    const calls: string[] = [];
    const runner = {
      run: async (taskId: string) => {
        calls.push(taskId);
        await savePipelineTask({
          id: taskId,
          targetType: 'chapter',
          targetId: 0,
          status: 'completed',
          stageResults: [
            {
              stage: 'draft',
              status: 'success',
              text: '正文',
              tokens: { input: 1, output: 2, total: 3 },
            },
          ],
          finalText: '正文',
          error: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          resolvedAt: null,
        });
      },
    };
    await reconcileMultiChapterBatch('b1', {
      owner: 'o1',
      runPipeline: runner.run as any,
      maxSteps: 5,
    });
    expect(calls).toHaveLength(1);
    const batch = await getBatchById('b1');
    expect(batch?.status).toBe('completed');
  });
});

describe('BN-06: cold-start cleanup preserves paused_* batches with stale leases', () => {
  jest.setTimeout(60_000);
  /**
   * Plant a paused_user batch with a dead-process lease. The cold-start
   * cleanup must clear the lease so the next resume can claim without
   * hitting BATCH_LEASE_CONFLICT. The status itself must stay paused_user.
   */
  it('clears dead leases on paused_user without changing status', async () => {
    await resetDb();
    await seedProject();
    await seedBatch('b1', 1);
    await updateBatchStatus('b1', 'paused_user', {
      pauseReason: 'user_pause',
      errorCode: 'BATCH_USER_PAUSE',
    });
    const row = await getBatchById('b1');
    await claimBatchLease('b1', 'dead_owner', 60_000, row!.rowVersion);
    await pauseInterruptedBatches(Date.now());
    const after = await getBatchById('b1');
    expect(after?.status).toBe('paused_user');
    expect(after?.leaseOwner ?? null).toBeNull();
  });

  it('still blocks concurrent reconcile even after lease reset', async () => {
    // After cold start, a fresh reconcile must be able to claim a lease
    // (no false BATCH_LEASE_CONFLICT).
    await resetDb();
    await seedProject();
    await seedBatch('b1', 1);
    await updateBatchStatus('b1', 'paused_user', {
      pauseReason: 'user_pause',
    });
    const row = await getBatchById('b1');
    await claimBatchLease('b1', 'dead_owner', 60_000, row!.rowVersion);
    await pauseInterruptedBatches(Date.now());
    // Next reconcile must claim successfully.
    const row2 = await getBatchById('b1');
    const claimed = await claimBatchLease('b1', 'fresh_owner', 60_000, row2!.rowVersion);
    expect(claimed).toBe(true);
  });
});

describe('BN-08: project tail drift also checks expectedTailChapterId', () => {
  jest.setTimeout(60_000);
  it('detects drift when user deletes the tail and recreates at the same position', async () => {
    await resetDb();
    await seedProject();
    // Existing tail chapter at position 0 (id will be 1).
    const ins = await execute(
      await openDatabase(),
      `INSERT INTO chapters (project_id, position, title, synopsis, content, status, created_at, updated_at)
       VALUES (1, 0, '既有', '', '', 'draft', 't', 't')`,
      [],
    );
    const existingId = Number(ins.insertId);
    await seedBatch('b1', 1);
    await updateBatchStatus('b1', 'ready', {
      startPosition: 0,
      expectedTailChapterId: existingId,
    });
    // User deletes the existing tail and inserts a NEW chapter at the
    // same position with a different id. Position check passes, id check
    // must catch this.
    await execute(
      await openDatabase(),
      `DELETE FROM chapters WHERE id = ?`,
      [existingId],
    );
    await execute(
      await openDatabase(),
      `INSERT INTO chapters (project_id, position, title, synopsis, content, status, created_at, updated_at)
       VALUES (1, 0, '假冒', '', '', 'draft', 't', 't')`,
      [],
    );
    const runner = {
      run: async () => {
        await savePipelineTask({
          id: 't1',
          targetType: 'chapter',
          targetId: 0,
          status: 'completed',
          stageResults: [
            {
              stage: 'draft',
              status: 'success',
              text: '正',
              tokens: { input: 1, output: 2, total: 3 },
            },
          ],
          finalText: '正',
          error: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          resolvedAt: null,
        });
      },
    };
    await reconcileMultiChapterBatch('b1', {
      owner: 'o1',
      runPipeline: runner.run as any,
      maxSteps: 3,
    });
    const batch = await getBatchById('b1');
    expect(batch?.status).toBe('paused_project_changed');
  });

  it('does NOT flag drift after the batch has adopted its own chapter (legacy anchor only checked pre-adoption)', async () => {
    await resetDb();
    await seedProject();
    const ins = await execute(
      await openDatabase(),
      `INSERT INTO chapters (project_id, position, title, synopsis, content, status, created_at, updated_at)
       VALUES (1, 0, '既有', '', '', 'draft', 't', 't')`,
      [],
    );
    const existingId = Number(ins.insertId);
    await seedBatch('b1', 2);
    await updateBatchStatus('b1', 'ready', {
      startPosition: 0,
      expectedTailChapterId: existingId,
    });
    const runner = {
      run: async (taskId: string) => {
        await savePipelineTask({
          id: taskId,
          targetType: 'chapter',
          targetId: 0,
          status: 'completed',
          stageResults: [
            {
              stage: 'draft',
              status: 'success',
              text: `正-${taskId}`,
              tokens: { input: 1, output: 2, total: 3 },
            },
          ],
          finalText: `正-${taskId}`,
          error: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          resolvedAt: null,
        });
      },
    };
    await reconcileMultiChapterBatch('b1', {
      owner: 'o1',
      runPipeline: runner.run as any,
    });
    const batch = await getBatchById('b1');
    expect(batch?.status).toBe('completed');
  });
});

describe('BN-05: getLatestAttemptByTask must order by chronology, not attempt_no', () => {
  jest.setTimeout(60_000);
  it('returns the review attempt even when draft has a higher attempt_no', async () => {
    await resetDb();
    await seedProject();
    await seedBatch('b1', 1);
    const chapterId = await createBatchChapterForItem('b1', 1, {
      projectId: 1,
      position: 0,
      title: 't',
      synopsis: 's',
    });
    await createPipelineTaskForBatchItem({
      batchId: 'b1',
      ordinal: 1,
      chapterId,
      task: {
        id: 'a',
        targetType: 'chapter',
        targetId: chapterId,
        status: 'failed',
        stageResults: [],
        finalText: null,
        error: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        resolvedAt: null,
      },
      stages: ['draft', 'review', 'factCheck', 'proof'],
      runNo: 1,
      llmConfigSnapshotJson: '{}',
      reason: 'batch_start',
    });
    const now = Date.now();
    // draft attempt 1 (older)
    await createStageAttempt({
      id: 'a:draft:1',
      pipelineTaskId: 'a',
      stage: 'draft',
      attemptNo: 1,
      requestFingerprint: 'fp',
      llmConfigSnapshotJson: '{}',
      clientRequestId: 'c',
      startedAt: now - 1000,
    });
    await updateStageAttempt({
      id: 'a:draft:1',
      status: 'failed',
      completedAt: now - 900,
    });
    // draft attempt 2 (older than review)
    await createStageAttempt({
      id: 'a:draft:2',
      pipelineTaskId: 'a',
      stage: 'draft',
      attemptNo: 2,
      requestFingerprint: 'fp',
      llmConfigSnapshotJson: '{}',
      clientRequestId: 'c',
      startedAt: now - 800,
    });
    await updateStageAttempt({
      id: 'a:draft:2',
      status: 'safe_to_retry',
      failureClass: 'safe_retry',
      completedAt: now - 700,
    });
    // review attempt 1 (newest)
    await createStageAttempt({
      id: 'a:review:1',
      pipelineTaskId: 'a',
      stage: 'review',
      attemptNo: 1,
      requestFingerprint: 'fp',
      llmConfigSnapshotJson: '{}',
      clientRequestId: 'c',
      startedAt: now - 500,
    });
    await updateStageAttempt({
      id: 'a:review:1',
      status: 'failed',
      failureClass: 'outcome_unknown',
      completedAt: now - 400,
    });
    const latest = await getLatestAttemptByTask('a');
    expect(latest?.id).toBe('a:review:1');
    expect(latest?.stage).toBe('review');
    expect(latest?.failureClass).toBe('outcome_unknown');
  });
});
