/**
 * Phase 4: multi-chapter batch repository (real in-memory SQLite, FK ON).
 *
 * Covers: batch/item/run CRUD, lease CAS (conflict/expiry/row_version),
 * atomic chapter creation + item binding (no orphan chapters), atomic
 * pipeline task + checkpoints + item run creation (no orphan tasks),
 * adoption commit + counter advance, project delete cascade.
 */
import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import type { InMemorySqliteDb } from './helpers/canonInMemoryDb';
import { __setDatabaseForTest, __resetForTest } from '../src/data/connection/openDatabase';
import {
  createBatch,
  getBatchById,
  getActiveBatchByProject,
  updateBatchStatus,
  claimBatchLease,
  releaseBatchLease,
  incrementBatchUsage,
  createBatchItem,
  getBatchItems,
  getBatchItem,
  updateBatchItem,
  getItemRuns,
  createBatchChapterForItem,
  createPipelineTaskForBatchItem,
  commitBatchItemAdoption,
} from '../src/data/repositories/multiChapterBatchRepository';
import { getChapterById, getChaptersByProject } from '../src/data/repositories/projectRepository';
import { getStageCheckpoints } from '../src/data/repositories/pipelineStageCheckpointRepository';
import { getPipelineTaskById } from '../src/data/repositories/pipelineTaskRepository';
import { deleteProject } from '../src/data/repositories/projectRepository';
import { execute } from '../src/data/connection/execute';
import { openDatabase } from '../src/data/connection/openDatabase';
import {
  cloneDefaultContextAutomationPolicyV3,
  hashContextAutomationPolicyV3,
} from '../src/services/contextAutomationPolicy';

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

/** Insert a project directly (schema-level helper). */
async function seedProject(id: number): Promise<void> {
  await execute(
    await openDatabase(),
    `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (?, 'p', 'outline', 't', 't')`,
    [id],
  );
}

async function seedBatch(batchId: string, projectId = 1, count = 3) {
  await createBatch({
    id: batchId,
    projectId,
    sourcePrompt: '长剧情摘要',
    chapterCount: count,
    targetWordsPerChapter: 3000,
    pipelineMode: 'full',
  });
  for (let i = 1; i <= count; i += 1) {
    await createBatchItem({
      batchId,
      ordinal: i,
      title: `第${i}章`,
      synopsis: `梗概${i}`,
      keyBeatsJson: JSON.stringify(['节拍']),
      targetWords: 3000,
    });
  }
}

describe('batch header CRUD + lease CAS', () => {
  it('creates and reads a draft batch, and finds the active one per project', async () => {
    await resetDb();
    await seedProject(1);
    await seedBatch('b1');
    const batch = await getBatchById('b1');
    expect(batch).not.toBeNull();
    expect(batch!.status).toBe('draft');
    expect(batch!.chapterCount).toBe(3);
    expect(batch!.currentOrdinal).toBe(1);
    const active = await getActiveBatchByProject(1);
    expect(active?.id).toBe('b1');
  });

  it('claims the lease with CAS and rejects concurrent owners', async () => {
    await resetDb();
    await seedProject(1);
    await seedBatch('b1');
    const row = await getBatchById('b1');
    const version = row!.rowVersion;
    expect(await claimBatchLease('b1', 'owner-a', 60_000, version)).toBe(true);
    // Same version again → conflict (version bumped)
    expect(await claimBatchLease('b1', 'owner-b', 60_000, version)).toBe(false);
    // Owner-a can re-claim (same owner)
    const row2 = await getBatchById('b1');
    expect(
      await claimBatchLease('b1', 'owner-a', 60_000, row2!.rowVersion),
    ).toBe(true);
  });

  it('releases the lease and lets an expired lease be taken over', async () => {
    await resetDb();
    await seedProject(1);
    await seedBatch('b1');
    const row = await getBatchById('b1');
    expect(await claimBatchLease('b1', 'a', 60_000, row!.rowVersion)).toBe(true);
    expect(await releaseBatchLease('b1', 'a')).toBe(true);
    const row2 = await getBatchById('b1');
    expect(await claimBatchLease('b1', 'b', 60_000, row2!.rowVersion)).toBe(true);
    // Expired lease takeover
    expect(await releaseBatchLease('b1', 'b')).toBe(true);
    // Force-expire by updating lease_expires_at directly
    await execute(
      await openDatabase(),
      `UPDATE multi_chapter_batches SET lease_owner = 'c', lease_expires_at = ?, row_version = row_version + 1 WHERE id = 'b1'`,
      [Date.now() - 1000],
    );
    const row4 = await getBatchById('b1');
    expect(await claimBatchLease('b1', 'd', 60_000, row4!.rowVersion)).toBe(true);
  });

  it('tracks usage counters', async () => {
    await resetDb();
    await seedProject(1);
    await seedBatch('b1');
    await incrementBatchUsage('b1', { llmCalls: 2, inputTokens: 100, outputTokens: 50 });
    const row = await getBatchById('b1');
    expect(row!.usedLlmCalls).toBe(2);
    expect(row!.usedInputTokens).toBe(100);
    expect(row!.usedOutputTokens).toBe(50);
  });

  it('updates status with fields', async () => {
    await resetDb();
    await seedProject(1);
    await seedBatch('b1');
    await updateBatchStatus('b1', 'ready', {
      plannerHash: 'h1',
      startPosition: 5,
    });
    const row = await getBatchById('b1');
    expect(row!.status).toBe('ready');
    expect(row!.plannerHash).toBe('h1');
    expect(row!.startPosition).toBe(5);
  });

  it('freezes the V3 policy snapshot and hash on the batch header', async () => {
    await resetDb();
    await seedProject(1);
    const policy = cloneDefaultContextAutomationPolicyV3();
    policy.boards.resources.priority = 99;
    await createBatch({
      id: 'v3-batch',
      projectId: 1,
      sourcePrompt: '冻结策略',
      chapterCount: 2,
      targetWordsPerChapter: 3000,
      pipelineMode: 'full',
      outlineWorkflowVersion: 4,
      contextBudgetVersion: 6,
      contextAutomationPolicyV3: policy,
    } as any);

    const batch = await getBatchById('v3-batch');
    expect(batch?.contextAutomationPolicyVersion).toBe('context-automation-v3');
    expect(batch?.contextAutomationPolicyHash).toBe(
      hashContextAutomationPolicyV3(policy),
    );
    expect(batch?.contextAutomationPolicySnapshot).toEqual(policy);
  });
});

describe('atomic chapter creation', () => {
  it('creates the chapter and binds it to the item in one transaction', async () => {
    await resetDb();
    await seedProject(1);
    await seedBatch('b1');
    const chapterId = await createBatchChapterForItem('b1', 1, {
      projectId: 1,
      position: 0,
      title: '第一章',
      synopsis: '梗概1',
    });
    expect(chapterId).toBeGreaterThan(0);
    const chapter = await getChapterById(chapterId);
    expect(chapter?.title).toBe('第一章');
    expect(chapter?.synopsis).toBe('梗概1');
    const item = await getBatchItem('b1', 1);
    expect(item?.chapterId).toBe(chapterId);
    expect(item?.status).toBe('chapter_ready');
  });

  it('does not create an orphan chapter when the item is already bound', async () => {
    await resetDb();
    await seedProject(1);
    await seedBatch('b1');
    await createBatchChapterForItem('b1', 1, { projectId: 1, position: 0, title: 't', synopsis: 's' });
    const chaptersBefore = (await getChaptersByProject(1)).length;
    await expect(
      createBatchChapterForItem('b1', 1, { projectId: 1, position: 0, title: 't2', synopsis: 's2' }),
    ).rejects.toThrow('BATCH_CHAPTER_BIND_CONFLICT');
    // No orphan chapter and no title overwrite
    const chaptersAfter = (await getChaptersByProject(1)).length;
    expect(chaptersAfter).toBe(chaptersBefore);
    const item = await getBatchItem('b1', 1);
    const chapter = await getChapterById(item!.chapterId!);
    expect(chapter?.title).toBe('t');
  });
});

describe('atomic pipeline task creation for batch item', () => {
  it('creates task + 4 checkpoints + item run and binds the item', async () => {
    await resetDb();
    await seedProject(1);
    await seedBatch('b1');
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
        id: 'task1',
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
    const task = await getPipelineTaskById('task1');
    expect(task?.targetId).toBe(chapterId);
    const checkpoints = await getStageCheckpoints('task1');
    expect(checkpoints.map(c => c.stage).sort()).toEqual(
      ['draft', 'factCheck', 'proof', 'review'],
    );
    const runs = await getItemRuns('b1', 1);
    expect(runs).toHaveLength(1);
    expect(runs[0].pipelineTaskId).toBe('task1');
    const item = await getBatchItem('b1', 1);
    expect(item?.activePipelineTaskId).toBe('task1');
    expect(item?.status).toBe('running_pipeline');
  });

  it('rolls back everything when the item is already bound to a task', async () => {
    await resetDb();
    await seedProject(1);
    await seedBatch('b1');
    const chapterId = await createBatchChapterForItem('b1', 1, {
      projectId: 1,
      position: 0,
      title: 't',
      synopsis: 's',
    });
    const now = Date.now();
    const makeTask = (id: string) => ({
      id,
      targetType: 'chapter',
      targetId: chapterId,
      status: 'idle',
      stageResults: [] as any[],
      finalText: null as string | null,
      error: null as string | null,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null as number | null,
    });
    await createPipelineTaskForBatchItem({
      batchId: 'b1', ordinal: 1, chapterId,
      task: makeTask('task1'),
      stages: ['draft', 'review', 'factCheck', 'proof'],
      runNo: 1, llmConfigSnapshotJson: '{}', reason: 'batch_start',
    });
    await expect(
      createPipelineTaskForBatchItem({
        batchId: 'b1', ordinal: 1, chapterId,
        task: makeTask('task2'),
        stages: ['draft', 'review', 'factCheck', 'proof'],
        runNo: 2, llmConfigSnapshotJson: '{}', reason: 'model_change',
      }),
    ).rejects.toThrow('BATCH_PIPELINE_TASK_CREATE_FAILED');
    // No orphan task2
    expect(await getPipelineTaskById('task2')).toBeNull();
    const runs = await getItemRuns('b1', 1);
    expect(runs).toHaveLength(1);
  });
});

describe('adoption commit + counter advance', () => {
  it('advances counters and completes the batch on the last chapter', async () => {
    await resetDb();
    await seedProject(1);
    await seedBatch('b1', 1, 2);
    for (let i = 1; i <= 2; i += 1) {
      const chapterId = await createBatchChapterForItem('b1', i, {
        projectId: 1,
        position: i - 1,
        title: `t${i}`,
        synopsis: 's',
      });
      await updateBatchItem('b1', i, {
        status: 'adopting',
        adoptionFingerprint: `fp${i}`,
      });
      await commitBatchItemAdoption({
        batchId: 'b1',
        ordinal: i,
        chapterCount: 2,
        completionQuality: 'full_pipeline',
        adoptionFingerprint: `fp${i}`,
        adoptedRevisionId: 100 + i,
      });
      void chapterId;
    }
    const batch = await getBatchById('b1');
    expect(batch!.completedCount).toBe(2);
    expect(batch!.status).toBe('completed');
    expect(batch!.completedAt).not.toBeNull();
    const item2 = await getBatchItem('b1', 2);
    expect(item2?.status).toBe('succeeded');
    expect(item2?.completionQuality).toBe('full_pipeline');
    expect(item2?.adoptionFingerprint).toBe('fp2');
  });

  it('is idempotent for repeated adoption of the same fingerprint (no double commit)', async () => {
    await resetDb();
    await seedProject(1);
    await seedBatch('b1');
    await createBatchChapterForItem('b1', 1, { projectId: 1, position: 0, title: 't', synopsis: 's' });
    await updateBatchItem('b1', 1, {
      status: 'adopting',
      adoptionFingerprint: 'fp1',
    });
    await commitBatchItemAdoption({
      batchId: 'b1',
      ordinal: 1,
      chapterCount: 3,
      completionQuality: 'full_pipeline',
      adoptionFingerprint: 'fp1',
      adoptedRevisionId: null,
    });
    // Repeated reconcile with the same fingerprint is a no-op.
    await commitBatchItemAdoption({
      batchId: 'b1',
      ordinal: 1,
      chapterCount: 3,
      completionQuality: 'full_pipeline',
      adoptionFingerprint: 'fp1',
      adoptedRevisionId: null,
    });
    const batch = await getBatchById('b1');
    expect(batch!.completedCount).toBe(1);
    expect(batch!.status).toBe('running');
  });

  it('clears transient state-sync wait markers when adoption succeeds', async () => {
    await resetDb();
    await seedProject(1);
    await seedBatch('b1');
    await createBatchChapterForItem('b1', 1, {
      projectId: 1,
      position: 0,
      title: 't',
      synopsis: 's',
    });
    await updateBatchItem('b1', 1, {
      status: 'waiting_retry',
      adoptionFingerprint: 'fp1',
      errorCode: 'BATCH_CONTINUATION_STATE_SYNC_WAIT',
      errorMessage: '故事记忆重建进行中（attempt 1）',
      nextRetryAt: Date.now() + 5_000,
      retryCount: 1,
    });

    await commitBatchItemAdoption({
      batchId: 'b1',
      ordinal: 1,
      chapterCount: 3,
      completionQuality: 'full_pipeline',
      adoptionFingerprint: 'fp1',
      adoptedRevisionId: null,
    });

    const item = await getBatchItem('b1', 1);
    expect(item?.status).toBe('succeeded');
    expect(item?.errorCode).toBeNull();
    expect(item?.errorMessage).toBeNull();
    expect(item?.nextRetryAt).toBeNull();
  });

  it('rejects an adoption with a different fingerprint', async () => {
    await resetDb();
    await seedProject(1);
    await seedBatch('b1');
    await createBatchChapterForItem('b1', 1, { projectId: 1, position: 0, title: 't', synopsis: 's' });
    await updateBatchItem('b1', 1, {
      status: 'adopting',
      adoptionFingerprint: 'fp1',
    });
    await commitBatchItemAdoption({
      batchId: 'b1',
      ordinal: 1,
      chapterCount: 3,
      completionQuality: 'full_pipeline',
      adoptionFingerprint: 'fp1',
      adoptedRevisionId: null,
    });
    // Different fingerprint → fail closed.
    await expect(
      commitBatchItemAdoption({
        batchId: 'b1',
        ordinal: 1,
        chapterCount: 3,
        completionQuality: 'full_pipeline',
        adoptionFingerprint: 'fp2',
        adoptedRevisionId: null,
      }),
    ).rejects.toThrow('BATCH_ADOPTION_MISMATCH');
    const batch = await getBatchById('b1');
    expect(batch!.completedCount).toBe(1);
  });
});

describe('project delete cascade', () => {
  it('cascades batch rows when the project is deleted', async () => {
    await resetDb();
    await seedProject(1);
    await seedBatch('b1');
    await deleteProject(1);
    expect(await getBatchById('b1')).toBeNull();
    expect(await getBatchItems('b1')).toHaveLength(0);
  });
});
