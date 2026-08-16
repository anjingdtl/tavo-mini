/**
 * P1 recovery regression tests (audit 2026-08-06).
 *
 *   RB-5  cold-start: batches left `running` by a killed process are parked
 *         into a recoverable pause (never "running with nobody driving").
 *   RB-6  pause interrupts the in-flight chapter request (no model calls
 *         after the user pressed pause).
 *   RB-7  the reconciler renews the lease on every state-machine step, so a
 *         long chapter run cannot silently let a second owner in.
 */
jest.mock('../src/services/multiChapterBatch/reconcileMultiChapterBatch', () => {
  const actual = jest.requireActual(
    '../src/services/multiChapterBatch/reconcileMultiChapterBatch',
  );
  return {
    ...actual,
  };
});

jest.mock('../src/services/pipelineRunner', () => {
  const actual = jest.requireActual('../src/services/pipelineRunner');
  return {
    ...actual,
    interruptPipelineTask: jest.fn(),
  };
});

jest.mock('../src/native/PipelineForegroundModule', () => ({
  PipelineForeground: {
    start: jest.fn(() => Promise.resolve()),
    updateProgress: jest.fn(() => Promise.resolve()),
    notifyComplete: jest.fn(() => Promise.resolve()),
    notifyFailed: jest.fn(() => Promise.resolve()),
    stop: jest.fn(() => Promise.resolve()),
  },
}));

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
  updateBatchStatus,
  getBatchById,
  pauseInterruptedBatches,
} from '../src/data/repositories/multiChapterBatchRepository';
import { savePipelineTask } from '../src/data/repositories/pipelineTaskRepository';
import { getChapterById } from '../src/data/repositories/projectRepository';
import { reconcileMultiChapterBatch } from '../src/services/multiChapterBatch/reconcileMultiChapterBatch';
import { useMultiChapterBatchStore, resetBatchInstanceId } from '../src/store/multiChapterBatchStore';
import { interruptPipelineTask } from '../src/services/pipelineRunner';

const mockInterrupt = interruptPipelineTask as jest.Mock;

let testDb: InMemorySqliteDb | null = null;

async function resetDb() {
  __resetForTest();
  testDb = await createCanonInMemoryDb();
  __setDatabaseForTest(testDb as any);
}

afterEach(async () => {
  __resetForTest();
  mockInterrupt.mockClear();
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

async function seedRunningBatch(batchId: string, count = 1) {
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

// ---------------------------------------------------------------------------
// RB-5: cold-start parks orphaned running batches
// ---------------------------------------------------------------------------
describe('RB-5 cold-start batch normalization', () => {
  it('parks running batches whose lease has expired into paused_user', async () => {
    await resetDb();
    await seedProject();
    await seedRunningBatch('b1');
    // Simulate a process killed mid-run: status running, lease expired.
    await execute(
      await openDatabase(),
      `UPDATE multi_chapter_batches SET status = 'running',
         lease_owner = 'dead-owner', lease_expires_at = ?, updated_at = ? WHERE id = 'b1'`,
      [Date.now() - 60_000, Date.now()],
    );

    const marked = await pauseInterruptedBatches();

    expect(marked).toBe(1);
    const batch = await getBatchById('b1');
    expect(batch?.status).toBe('paused_user');
    expect(batch?.errorCode).toBe('BATCH_INTERRUPTED');
  });

  it('parks a running batch even on a FAST restart (lease not yet expired)', async () => {
    await resetDb();
    await seedProject();
    await seedRunningBatch('b2');
    // Fast restart: the dead process still holds a live lease. A cold start
    // must still park the batch — otherwise the UI shows a preview page and
    // 开始批量写作 fails with BATCH_LEASE_CONFLICT (线程被占用).
    await execute(
      await openDatabase(),
      `UPDATE multi_chapter_batches SET status = 'running',
         lease_owner = 'dead-owner', lease_expires_at = ?, updated_at = ? WHERE id = 'b2'`,
      [Date.now() + 60_000, Date.now()],
    );

    const marked = await pauseInterruptedBatches();

    expect(marked).toBe(1);
    const batch = await getBatchById('b2');
    expect(batch?.status).toBe('paused_user');
    // The dead lease MUST be cleared so the user can resume.
    expect(batch?.leaseOwner).toBeNull();
    expect(batch?.leaseExpiresAt).toBeNull();
  });

  it('parks a READY batch that already started (chapter created) instead of showing the start form', async () => {
    await resetDb();
    await seedProject();
    await seedRunningBatch('b3');
    // The user pressed 开始批量写作, the reconciler created chapter 1 and
    // claimed the lease, then the app was killed. Batch status is still
    // 'ready' (only adoption flips it to running), items show execution.
    const result = await execute(
      await openDatabase(),
      `INSERT INTO chapters (project_id, position, title, synopsis, content, status, created_at, updated_at)
       VALUES (1, 0, '第1章', 's1', '', 'planned', 't', 't')`,
      [],
    );
    await execute(
      await openDatabase(),
      `UPDATE multi_chapter_batch_items
       SET chapter_id = ?, status = 'chapter_ready'
       WHERE batch_id = 'b3' AND ordinal = 1`,
      [result.insertId],
    );
    await execute(
      await openDatabase(),
      `UPDATE multi_chapter_batches SET
         lease_owner = 'dead-owner', lease_expires_at = ?, updated_at = ? WHERE id = 'b3'`,
      [Date.now() + 60_000, Date.now()],
    );

    const marked = await pauseInterruptedBatches();

    expect(marked).toBe(1);
    const batch = await getBatchById('b3');
    // Recoverable pause — the batch screen shows 确认后继续, NOT the preview
    // page with a 开始批量写作 button that would fail with 线程被占用.
    expect(batch?.status).toBe('paused_user');
    expect(batch?.leaseOwner).toBeNull();
  });

  it('does NOT touch a pristine READY batch (plan confirmed, nothing started)', async () => {
    await resetDb();
    await seedProject();
    await seedRunningBatch('b4');
    // No items touched, no lease: a brand-new confirmed plan stays ready.
    const marked = await pauseInterruptedBatches();

    expect(marked).toBe(0);
    const batch = await getBatchById('b4');
    expect(batch?.status).toBe('ready');
  });
});

// ---------------------------------------------------------------------------
// RB-6: pause interrupts the in-flight chapter request
// ---------------------------------------------------------------------------
describe('RB-6 pause interrupts the chapter pipeline', () => {
  it('aborts the active task when the user pauses', async () => {
    await resetDb();
    await seedProject();
    await seedRunningBatch('b3');
    // Attach a fake active task to the current item.
    await execute(
      await openDatabase(),
      `INSERT INTO pipeline_tasks (id, target_type, target_id, status, stage_results, final_text, error, created_at, updated_at)
       VALUES ('task-pause', 'chapter', 1, 'drafting', '[]', NULL, NULL, ?, ?)`,
      [Date.now(), Date.now()],
    );
    await execute(
      await openDatabase(),
      `UPDATE multi_chapter_batch_items
       SET active_pipeline_task_id = 'task-pause', status = 'running_pipeline'
       WHERE batch_id = 'b3' AND ordinal = 1`,
      [],
    );
    await execute(
      await openDatabase(),
      `UPDATE multi_chapter_batches SET status = 'running' WHERE id = 'b3'`,
      [],
    );

    const store = useMultiChapterBatchStore.getState();
    await store.loadBatch('b3');
    await store.pause('b3');

    expect(mockInterrupt).toHaveBeenCalledWith('task-pause');
    const batch = await getBatchById('b3');
    expect(batch?.status).toBe('paused_user');
  });
});

// ---------------------------------------------------------------------------
// RB-9: user scenario — restart after start, then resume CONTINUES the batch
// (the chapter pipeline is never re-run from scratch)
// ---------------------------------------------------------------------------
describe('RB-9 restart then resume continues (no thread-occupied error)', () => {
  it('parks on cold start, then 确认后继续 adopts the already-finished chapter without re-running it', async () => {
    await resetDb();
    await seedProject();
    await seedRunningBatch('b5');
    // User pressed 开始批量写作; the reconciler created chapter 1, bound a
    // completed task, then the app was killed mid-adoption.
    const chapterRes = await execute(
      await openDatabase(),
      `INSERT INTO chapters (project_id, position, title, synopsis, content, status, created_at, updated_at)
       VALUES (1, 0, '第1章', 's1', '', 'planned', 't', 't')`,
      [],
    );
    const chapterId = chapterRes.insertId;
    await execute(
      await openDatabase(),
      `INSERT INTO pipeline_tasks (id, target_type, target_id, status, stage_results, final_text, error, created_at, updated_at)
       VALUES ('b5-task', 'chapter', ?, 'completed', '[]', '第一章正文', NULL, ?, ?)`,
      [chapterId, Date.now(), Date.now()],
    );
    await execute(
      await openDatabase(),
      `UPDATE multi_chapter_batch_items
       SET chapter_id = ?, active_pipeline_task_id = 'b5-task', status = 'running_pipeline'
       WHERE batch_id = 'b5' AND ordinal = 1`,
      [chapterId],
    );
    await execute(
      await openDatabase(),
      `UPDATE multi_chapter_batches SET
         lease_owner = 'dead-owner', lease_expires_at = ?, updated_at = ? WHERE id = 'b5'`,
      [Date.now() + 60_000, Date.now()],
    );

    // Cold start parks the batch (fast restart, lease still live).
    const marked = await pauseInterruptedBatches();
    expect(marked).toBe(1);

    // User re-enters the batch screen → sees 确认后继续 (paused view).
    const store = useMultiChapterBatchStore.getState();
    await store.loadBatch('b5');
    expect(store.batch?.status).toBe('paused_user');

    // 确认后继续 → resume must CONTINUE, never re-run the finished task.
    await store.resume('b5');
    // Wait for the background drive to finish.
    await new Promise(r => setTimeout(r, 80));

    const chapter = await getChapterById(chapterId);
    expect(chapter?.content).toBe('第一章正文');
    const batch = await getBatchById('b5');
    expect(batch?.status).toBe('completed');
    expect(batch?.completedCount).toBe(1);
    expect(batch?.leaseOwner).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// RB-10: crash recovery (own chapter created, not yet adopted) must NOT be
// falsely paused by the tail-drift check (regression introduced with RB-3:
// the drift check ran before the chapterId idempotency branch)
// ---------------------------------------------------------------------------
describe('RB-10 crash recovery vs tail-drift false positive', () => {
  it('continues a batch whose own chapter was created but never adopted', async () => {
    await resetDb();
    await seedProject();
    // Existing project chapter at position 0 → tail = 0.
    await execute(
      await openDatabase(),
      `INSERT INTO chapters (project_id, position, title, synopsis, content, status, created_at, updated_at)
       VALUES (1, 0, '既有章节', '', '', 'draft', 't', 't')`,
      [],
    );
    await seedRunningBatch('b10', 2);
    // Production saveEditedPlan freezes the anchor: startPosition=0.
    await execute(
      await openDatabase(),
      `UPDATE multi_chapter_batches SET
         start_position = 0, expected_tail_chapter_id = 1 WHERE id = 'b10'`,
      [],
    );
    // Crash state: the reconciler created batch chapter 1 (position 1) and
    // bound it to item 1, then the process died BEFORE adoption.
    const res = await execute(
      await openDatabase(),
      `INSERT INTO chapters (project_id, position, title, synopsis, content, status, created_at, updated_at)
       VALUES (1, 1, '批次第1章', 's1', '', 'planned', 't', 't')`,
      [],
    );
    await execute(
      await openDatabase(),
      `UPDATE multi_chapter_batch_items
       SET chapter_id = ?, status = 'chapter_ready'
       WHERE batch_id = 'b10' AND ordinal = 1`,
      [res.insertId],
    );

    // Resume must CONTINUE the batch, not pause with a false drift report.
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
    await reconcileMultiChapterBatch('b10', {
      owner: 'test-owner',
      runPipeline: runner.run as any,
      resumeWritingTask: (async () => {}) as any,
    });

    const batch = await getBatchById('b10');
    // Must NOT be paused_project_changed (that would deadlock the user).
    expect(batch?.status).toBe('completed');
    expect(batch?.completedCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// RB-7: reconciler renews the lease on every step
// ---------------------------------------------------------------------------
describe('RB-7 lease renewal on each reconcile step', () => {
  it('keeps the lease owned by the same coordinator across a multi-step run', async () => {
    await resetDb();
    await seedProject();
    await seedRunningBatch('b4', 2);
    resetBatchInstanceId();

    const seenOwners: Array<string | null> = [];
    const runner = {
      run: async (taskId: string) => {
        // Inside the chapter run: the coordinator must still hold the lease.
        const mid = await getBatchById('b4');
        seenOwners.push(mid?.leaseOwner ?? null);
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

    await reconcileMultiChapterBatch('b4', {
      owner: 'test-owner',
      leaseMs: 60_000,
      runPipeline: runner.run as any,
      resumeWritingTask: (async () => {}) as any,
    });

    // Every observed mid-run lease belongs to our coordinator.
    expect(seenOwners.length).toBe(2);
    expect(seenOwners.every(o => o === 'test-owner')).toBe(true);
    // Lease is released afterwards.
    const final = await getBatchById('b4');
    expect(final?.status).toBe('completed');
    expect(final?.leaseOwner).toBeNull();
  });
});
