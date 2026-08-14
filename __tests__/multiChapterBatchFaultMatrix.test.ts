/**
 * Phase 9: multi-chapter batch fault matrix.
 * Covers crash points (task insert / chapter insert), completed-but-unadopted
 * recovery, body-written-but-item-not-succeeded, last-chapter-without-
 * complete, concurrent reconcile (lease), project-tail drift, deleted batch
 * chapter, N=10 batches, retry exhaustion, cold-start waiting retry, and
 * foreign-key integrity.
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
} from '../src/data/repositories/multiChapterBatchRepository';
import { savePipelineTask } from '../src/data/repositories/pipelineTaskRepository';
import { getChaptersByProject, getChapterById } from '../src/data/repositories/projectRepository';
import { getStageCheckpoints } from '../src/data/repositories/pipelineStageCheckpointRepository';
import { reconcileMultiChapterBatch } from '../src/services/multiChapterBatch/reconcileMultiChapterBatch';
import { determineNextBatchAction } from '../src/services/multiChapterBatch/determineNextBatchAction';
import { MultiChapterBatchError } from '../src/services/multiChapterBatch/errors';
import { claimBatchLease } from '../src/data/repositories/multiChapterBatchRepository';
import { createStageAttempt, updateStageAttempt } from '../src/data/repositories/pipelineStageAttemptRepository';
import {
  CURRENT_CONTEXT_BUDGET_VERSION,
  CURRENT_OUTLINE_WORKFLOW_VERSION,
} from '../src/services/pipeline/outlineWorkflowVersion';

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
    outlineWorkflowVersion: CURRENT_OUTLINE_WORKFLOW_VERSION,
    contextBudgetVersion: CURRENT_CONTEXT_BUDGET_VERSION,
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
  // Production path freezes the tail anchor in saveEditedPlan (RB-3); the
  // fixture must NOT hand-set startPosition — drift tests freeze it below
  // through the same repository call the production path uses.
  await updateBatchStatus(batchId, 'ready');
}

/** Freeze the tail anchor exactly like the production saveEditedPlan path. */
async function freezeTailAnchor(batchId: string, startPosition: number) {
  const chapters = await getChaptersByProject(1);
  const tail =
    chapters.length > 0
      ? chapters.reduce((max, c) =>
          Number(c.position) >= Number(max.position) ? c : max,
        )
      : null;
  await updateBatchStatus(batchId, 'ready', {
    startPosition,
    expectedTailChapterId: tail?.id ?? null,
  });
}

/** Runner that completes every task it is handed. */
function completingRunner() {
  const calls: string[] = [];
  return {
    run: async (taskId: string) => {
      calls.push(taskId);
      await savePipelineTask({
        id: taskId,
        targetType: 'chapter',
        targetId: 0,
        status: 'completed',
        stageResults: [
          { stage: 'draft', status: 'success', text: `正文-${taskId}`, tokens: { input: 1, output: 2, total: 3 } },
        ],
        finalText: `正文-${taskId}`,
        error: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        resolvedAt: null,
      });
    },
    calls,
  };
}

describe('crash-point recovery', () => {
  it('persists a pause state when the chapter pipeline throws (UI stays in sync)', async () => {
    await resetDb();
    await seedProject();
    await seedBatch('b1', 1);
    const failingRunner = {
      run: async (taskId: string) => {
        // 模拟单章 pipeline 失败：真实 runner 会先落库 task failed 再抛错。
        await savePipelineTask({
          id: taskId,
          targetType: 'chapter',
          targetId: 0,
          status: 'failed',
          stageResults: [],
          finalText: null,
          error: '模拟网络失败',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          resolvedAt: null,
        });
        throw new Error('模拟网络失败');
      },
    };
    await reconcileMultiChapterBatch('b1', {
      owner: 'o1',
      runPipeline: failingRunner.run as any,
    });
    // 状态机必须把失败落库：批次暂停，而非停留在 running_pipeline。
    const batch = await getBatchById('b1');
    expect(batch?.status).toBe('paused_timeout_unknown');
    const item = (await getBatchItems('b1'))[0];
    expect(item.status).toBe('outcome_unknown');
  });

  it('resumes with a NEW run after a user-confirmed retry (no deadlock)', async () => {
    await resetDb();
    await seedProject();
    await seedBatch('b1', 1);
    let failOnce = true;
    const flakyRunner = {
      run: async (taskId: string) => {
        if (failOnce) {
          failOnce = false;
          await savePipelineTask({
            id: taskId,
            targetType: 'chapter',
            targetId: 0,
            status: 'failed',
            stageResults: [],
            finalText: null,
            error: '第一次失败',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            resolvedAt: null,
          });
          throw new Error('第一次失败');
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
              text: '第二次成功正文',
              tokens: { input: 1, output: 2, total: 3 },
            },
          ],
          finalText: '第二次成功正文',
          error: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          resolvedAt: null,
        });
      },
    };
    // 第一次 reconcile：pipeline 失败 → 暂停落库。
    await reconcileMultiChapterBatch('b1', {
      owner: 'o1',
      runPipeline: flakyRunner.run as any,
    });
    const paused = await getBatchById('b1');
    expect(paused?.status).toBe('paused_timeout_unknown');
    const pausedItem = (await getBatchItems('b1'))[0];
    const oldTaskId = pausedItem.activePipelineTaskId;
    expect(oldTaskId).toBeTruthy();

    // 用户确认继续：解绑失败任务 + 批次回到 running（等价 store.resume）。
    await updateBatchItem('b1', 1, {
      status: 'running_pipeline',
      activePipelineTaskId: null,
      errorCode: null,
      errorMessage: null,
    });
    await updateBatchStatus('b1', 'running');

    // 第二次 reconcile：创建新 run 并成功完成。
    await reconcileMultiChapterBatch('b1', {
      owner: 'o1',
      runPipeline: flakyRunner.run as any,
    });
    const done = await getBatchById('b1');
    expect(done?.status).toBe('completed');
    const doneItem = (await getBatchItems('b1'))[0];
    // 新任务替代旧任务（旧 attempt 历史保留在 item_runs）。
    expect(doneItem.activePipelineTaskId).not.toBe(oldTaskId);
    const chapter = await getChapterById(doneItem.chapterId!);
    expect(chapter?.content).toBe('第二次成功正文');
  });

  it('creates chapters with the independent plan synopsis (not the batch digest)', async () => {
    await resetDb();
    await seedProject();
    await seedBatch('b1', 1);
    const chapterId = await createBatchChapterForItem('b1', 1, {
      projectId: 1,
      position: 0,
      title: 't',
      synopsis: '独立的本章摘要',
      summaryJson: JSON.stringify({ batch_instruction: '【批次总目标】xx' }),
    });
    const chapter = await getChapterById(chapterId);
    expect(chapter?.synopsis).toBe('独立的本章摘要');
    const meta =
      typeof chapter?.summary_json === 'string'
        ? JSON.parse(chapter.summary_json)
        : chapter?.summary_json || {};
    expect(meta.batch_instruction).toContain('批次总目标');
  });

  it('recovers a task created but never run (task INSERT committed, checkpoints pending)', async () => {
    await resetDb();
    await seedProject();
    await seedBatch('b1', 1);
    // Simulate crash after task creation (item bound, task idle).
    const chapterId = await createBatchChapterForItem('b1', 1, {
      projectId: 1,
      position: 0,
      title: 't',
      synopsis: 's',
    });
    const now = Date.now();
    await createPipelineTaskForBatchItem({
      batchId: 'b1',
      ordinal: 1,
      chapterId,
      task: {
        id: 'orphan-task',
        targetType: 'chapter',
        targetId: chapterId,
        status: 'idle',
        stageResults: [],
        finalText: null,
        error: null,
        outlineWorkflowVersion: CURRENT_OUTLINE_WORKFLOW_VERSION,
        contextBudgetVersion: CURRENT_CONTEXT_BUDGET_VERSION,
        createdAt: now,
        updatedAt: now,
        resolvedAt: null,
      },
      stages: ['draft', 'review', 'factCheck', 'brief', 'proof'],
      runNo: 1,
      llmConfigSnapshotJson: '{}',
      reason: 'batch_start',
    });
    const runner = completingRunner();
    await reconcileMultiChapterBatch('b1', { owner: 'o1', runPipeline: runner.run as any });
    const batch = await getBatchById('b1');
    expect(batch?.status).toBe('completed');
    // The orphan task was resumed, not duplicated.
    const checkpoints = await getStageCheckpoints('orphan-task');
    expect(checkpoints).toHaveLength(5);
    expect((await getChaptersByProject(1)).length).toBe(1);
  });

  it('recovers a completed task that was never adopted', async () => {
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
    await createPipelineTaskForBatchItem({
      batchId: 'b1',
      ordinal: 1,
      chapterId,
      task: {
        id: 'done-task',
        targetType: 'chapter',
        targetId: chapterId,
        status: 'completed',
        stageResults: [],
        finalText: '已完成的正文',
        error: null,
        outlineWorkflowVersion: CURRENT_OUTLINE_WORKFLOW_VERSION,
        contextBudgetVersion: CURRENT_CONTEXT_BUDGET_VERSION,
        createdAt: now,
        updatedAt: now,
        resolvedAt: null,
      },
      stages: ['draft', 'review', 'factCheck', 'brief', 'proof'],
      runNo: 1,
      llmConfigSnapshotJson: '{}',
      reason: 'batch_start',
    });
    const runner = completingRunner();
    await reconcileMultiChapterBatch('b1', { owner: 'o1', runPipeline: runner.run as any });
    const batch = await getBatchById('b1');
    expect(batch?.status).toBe('completed');
    // The completed body was adopted, NOT regenerated.
    expect(runner.calls).toHaveLength(0);
    const chapter = await getChapterById(chapterId);
    expect(chapter?.content).toBe('已完成的正文');
  });

  it('recovers a body-written-but-item-not-succeeded state (verify adoption)', async () => {
    await resetDb();
    await seedProject();
    await seedBatch('b1', 1);
    const chapterId = await createBatchChapterForItem('b1', 1, {
      projectId: 1,
      position: 0,
      title: 't',
      synopsis: 's',
    });
    // Body already written + fingerprint persisted, but commit never ran.
    await updateChapterContent(chapterId, '正文已写入');
    await updateBatchItem('b1', 1, {
      status: 'adopting',
      adoptionFingerprint: 'fp-abc',
      adoptedRevisionId: null,
      completionQuality: 'full_pipeline',
    });
    const runner = completingRunner();
    await reconcileMultiChapterBatch('b1', { owner: 'o1', runPipeline: runner.run as any });
    const batch = await getBatchById('b1');
    expect(batch?.status).toBe('completed');
    expect(batch?.completedCount).toBe(1);
    const item = (await getBatchItems('b1'))[0];
    expect(item.status).toBe('succeeded');
  });
});

describe('tail drift & deleted chapters', () => {
  it('pauses when the project tail changes after start', async () => {
    await resetDb();
    await seedProject();
    await seedBatch('b1', 2);
    // Production saveEditedPlan freezes the anchor when the plan is saved.
    await freezeTailAnchor('b1', -1);
    // User inserted an extra chapter after the batch started (tail moved).
    await execute(
      await openDatabase(),
      `INSERT INTO chapters (project_id, position, title, synopsis, content, status, created_at, updated_at)
       VALUES (1, 0, '用户新章节', '', '', 'draft', 't', 't')`,
      [],
    );
    const runner = completingRunner();
    await reconcileMultiChapterBatch('b1', { owner: 'o1', runPipeline: runner.run as any });
    const batch = await getBatchById('b1');
    expect(batch?.status).toBe('paused_project_changed');
    expect((await getChaptersByProject(1)).length).toBe(1); // nothing appended
  });

  it('pauses when the batch chapter was deleted by the user', async () => {
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
    await createPipelineTaskForBatchItem({
      batchId: 'b1',
      ordinal: 1,
      chapterId,
      task: {
        id: 't-del',
        targetType: 'chapter',
        targetId: chapterId,
        status: 'idle',
        stageResults: [],
        finalText: null,
        error: null,
        outlineWorkflowVersion: CURRENT_OUTLINE_WORKFLOW_VERSION,
        contextBudgetVersion: CURRENT_CONTEXT_BUDGET_VERSION,
        createdAt: now,
        updatedAt: now,
        resolvedAt: null,
      },
      stages: ['draft', 'review', 'factCheck', 'brief', 'proof'],
      runNo: 1,
      llmConfigSnapshotJson: '{}',
      reason: 'batch_start',
    });
    // User deletes the chapter (FK sets item.chapter_id null).
    await execute(await openDatabase(), 'DELETE FROM chapters WHERE id = ?', [chapterId]);
    const runner = completingRunner();
    await reconcileMultiChapterBatch('b1', { owner: 'o1', runPipeline: runner.run as any });
    const batch = await getBatchById('b1');
    expect(batch?.status).toBe('paused_project_changed');
  });
});

describe('concurrency & lease', () => {
  it('fails closed on concurrent reconcile (lease held by another owner)', async () => {
    await resetDb();
    await seedProject();
    await seedBatch('b1', 2);
    const row = await getBatchById('b1');
    await claimBatchLease('b1', 'other', 60_000, row!.rowVersion);
    const runner = completingRunner();
    await expect(
      reconcileMultiChapterBatch('b1', { owner: 'me', runPipeline: runner.run as any }),
    ).rejects.toThrow(MultiChapterBatchError);
  });
});

describe('batch scale & terminal flow', () => {
  it('completes an N=10 batch serially', async () => {
    await resetDb();
    await seedProject();
    await seedBatch('b10', 10);
    const runner = completingRunner();
    await reconcileMultiChapterBatch('b10', {
      owner: 'o1',
      runPipeline: runner.run as any,
    });
    const batch = await getBatchById('b10');
    expect(batch?.status).toBe('completed');
    expect(batch?.completedCount).toBe(10);
    expect((await getChaptersByProject(1)).length).toBe(10);
    expect(runner.calls).toHaveLength(10);
    // Serial: each task ran exactly once.
    expect(new Set(runner.calls).size).toBe(10);
  });

  it('no-ops on an already completed batch', async () => {
    await resetDb();
    await seedProject();
    await seedBatch('b1', 1);
    const runner = completingRunner();
    await reconcileMultiChapterBatch('b1', { owner: 'o1', runPipeline: runner.run as any });
    const first = runner.calls.length;
    await reconcileMultiChapterBatch('b1', { owner: 'o2', runPipeline: runner.run as any });
    expect(runner.calls.length).toBe(first);
  });
});

describe('retry exhaustion & cold-start waiting', () => {
  it('pauses when auto-retry is exhausted (attemptNo > 3)', async () => {
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
    await createPipelineTaskForBatchItem({
      batchId: 'b1',
      ordinal: 1,
      chapterId,
      task: {
        id: 't-retry',
        targetType: 'chapter',
        targetId: chapterId,
        status: 'failed',
        stageResults: [],
        finalText: null,
        error: 'boom',
        outlineWorkflowVersion: CURRENT_OUTLINE_WORKFLOW_VERSION,
        contextBudgetVersion: CURRENT_CONTEXT_BUDGET_VERSION,
        createdAt: now,
        updatedAt: now,
        resolvedAt: null,
      },
      stages: ['draft', 'review', 'factCheck', 'brief', 'proof'],
      runNo: 1,
      llmConfigSnapshotJson: '{}',
      reason: 'batch_start',
    });
    // Attempt 4 (past MAX_AUTO_RETRY_ATTEMPTS=3) failed with safe_retry.
    await createStageAttempt({
      id: 't-retry:draft:4',
      pipelineTaskId: 't-retry',
      stage: 'draft',
      attemptNo: 4,
      requestFingerprint: 'f',
      llmConfigSnapshotJson: '{}',
      clientRequestId: 'c',
    });
    await updateStageAttempt({
      id: 't-retry:draft:4',
      status: 'safe_to_retry',
      failureClass: 'safe_retry',
      nextRetryAt: Date.now() - 1000,
      completedAt: Date.now(),
    });
    const runner = completingRunner();
    await reconcileMultiChapterBatch('b1', { owner: 'o1', runPipeline: runner.run as any });
    const batch = await getBatchById('b1');
    expect(batch?.status).toBe('paused_timeout_unknown');
    expect(runner.calls).toHaveLength(0);
  });

  it('decides wait_until from the persisted next_retry_at (cold start safe)', () => {
    const future = Date.now() + 120_000;
    const action = determineNextBatchAction({
      batch: {
        id: 'b1',
        projectId: 1,
        status: 'running',
        sourcePrompt: 's',
        chapterCount: 2,
        targetWordsPerChapter: 3000,
        pipelineMode: 'full',
        plannerOutputJson: null,
        plannerHash: 'h',
        plannerRequestJson: null,
        plannerRequestFingerprint: null,
        startPosition: -1,
        expectedTailChapterId: null,
        currentOrdinal: 1,
        completedCount: 0,
        activeItemOrdinal: 1,
        maxLlmCalls: null,
        maxInputTokens: null,
        maxOutputTokens: null,
        usedLlmCalls: 0,
        usedInputTokens: 0,
        usedOutputTokens: 0,
        outlineWorkflowVersion: CURRENT_OUTLINE_WORKFLOW_VERSION,
        contextBudgetVersion: CURRENT_CONTEXT_BUDGET_VERSION,
        writingMode: 'outline',
        continuationAnchorJson: null,
        continuationExecutionPolicyJson: null,
        pauseReason: null,
        errorCode: null,
        errorMessage: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        rowVersion: 0,
        createdAt: 0,
        updatedAt: 0,
        startedAt: null,
        completedAt: null,
        cancelledAt: null,
      },
      items: [
        {
          batchId: 'b1',
          ordinal: 1,
          title: 't',
          synopsis: 's',
          keyBeatsJson: '[]',
          carryIn: null,
          carryOut: null,
          targetWords: 3000,
          status: 'waiting_retry',
          chapterId: 10,
          activePipelineTaskId: 't1',
          activeContinuationRunId: null,
          activeRunNo: 1,
          completionQuality: null,
          adoptionFingerprint: null,
          adoptedRevisionId: null,
          retryCount: 1,
          nextRetryAt: future,
          errorCode: null,
          errorMessage: null,
          createdAt: 0,
          updatedAt: 0,
          completedAt: null,
        },
      ],
    });
    expect(action.type).toBe('wait_until');
  });
});

describe('foreign key integrity', () => {
  it('passes foreign_key_check with batch rows', async () => {
    await resetDb();
    await seedProject();
    await seedBatch('b1', 2);
    const rows = await execute(await openDatabase(), 'PRAGMA foreign_key_check');
    expect(rows.rows?.length ?? 0).toBe(0);
  });

  it('cascades item runs when the batch is deleted', async () => {
    await resetDb();
    await seedProject();
    await seedBatch('b1', 1);
    await execute(await openDatabase(), 'DELETE FROM multi_chapter_batches WHERE id = ?', ['b1']);
    const items = await getBatchItems('b1');
    expect(items).toHaveLength(0);
  });
});

/** Helper: write chapter content directly (simulating a prior adopt). */
async function updateChapterContent(chapterId: number, content: string): Promise<void> {
  await execute(
    await openDatabase(),
    `UPDATE chapters SET content = ?, updated_at = 't' WHERE id = ?`,
    [content, chapterId],
  );
}
