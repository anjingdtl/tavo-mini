/**
 * F2-07 探针：复现真机 N02 的"run2 completed 后未 adopt，反而创建 run3"。
 *
 * 真机证据（N02 batch_msj3os7n_rxisdk）：
 *   - run2 task ...036: completed（finalText 3326 字，proof checkpoint succeeded）
 *   - run3 task ...389 在 run2 完成 82ms 后创建（同一 reconcile 循环）
 *
 * 本探针验证 reconcile 在纯 DB 状态下对 "running_pipeline + task completed"
 * 的决策是否符合预期（应 adopt_full_result → item succeeded → advance）。
 */
import { __setDatabaseForTest, __resetForTest, openDatabase } from '../src/data/connection/openDatabase';
import { execute } from '../src/data/connection/execute';
import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import type { InMemorySqliteDb } from './helpers/canonInMemoryDb';
import {
  createBatch,
  createBatchItem,
  createBatchChapterForItem,
  createItemRun,
  updateBatchStatus,
  getBatchById,
  getBatchItems,
} from '../src/data/repositories/multiChapterBatchRepository';
import { savePipelineTask } from '../src/data/repositories/pipelineTaskRepository';
import { reconcileMultiChapterBatch } from '../src/services/multiChapterBatch/reconcileMultiChapterBatch';
import { usePipelineTaskStore } from '../src/store/pipelineTaskStore';

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

async function seedCompletedTaskScenario(): Promise<{ chapterId: number; taskId: string }> {
  await execute(
    await openDatabase(),
    `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
  );
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
  await updateBatchStatus('b1', 'ready');
  const chapterId = await createBatchChapterForItem('b1', 1, {
    projectId: 1,
    position: 0,
    title: '第1章',
    synopsis: 's',
  });
  // run1（failed，模拟真机）——task 已失败，无 finalText。
  const run1Task = `batch_b1_ord1_run1`;
  await savePipelineTask({
    id: run1Task,
    targetType: 'chapter',
    targetId: chapterId,
    status: 'failed',
    stageResults: [],
    finalText: null,
    error: 'Network request failed',
    createdAt: 1000,
    updatedAt: 2000,
    resolvedAt: null,
  });
  await createItemRun({
    batchId: 'b1',
    ordinal: 1,
    runNo: 1,
    pipelineTaskId: run1Task,
    llmConfigSnapshotJson: '{}',
    reason: 'batch_start',
  });
  // run2（completed，模拟真机）——finalText 已落地。
  const run2Task = `batch_b1_ord1_run2`;
  await savePipelineTask({
    id: run2Task,
    targetType: 'chapter',
    targetId: chapterId,
    status: 'completed',
    stageResults: [],
    finalText: '新正文',
    error: null,
    createdAt: 3000,
    updatedAt: 4000,
    resolvedAt: null,
  });
  await createItemRun({
    batchId: 'b1',
    ordinal: 1,
    runNo: 2,
    pipelineTaskId: run2Task,
    llmConfigSnapshotJson: '{}',
    reason: 'batch_start',
  });
  // item 状态 = 真机 run2 完成后：running_pipeline + activePipelineTaskId=run2。
  await execute(
    await openDatabase(),
    `UPDATE multi_chapter_batch_items SET status = 'running_pipeline', active_pipeline_task_id = ?, active_run_no = 2 WHERE batch_id = 'b1' AND ordinal = 1`,
    [run2Task],
  );
  // 注册到内存 store（真机路径一致）。
  usePipelineTaskStore.getState().registerPersistedTask({
    id: run2Task,
    targetType: 'chapter',
    targetId: chapterId,
    status: 'completed',
    stageResults: [],
    finalText: '新正文',
    error: null,
    inputFingerprint: null,
    pipelineContextJson: null,
    pipelineContextVersion: null,
    pipelineContextHash: null,
    createdAt: 3000,
    updatedAt: 4000,
    resolvedAt: null,
    resolvedAction: null,
  });
  return { chapterId, taskId: run2Task };
}

describe('F2-07 探针: completed task 后 reconcile 决策', () => {
  jest.setTimeout(30_000);

  it('running_pipeline + task completed → adopt + 推进，不创建新 run', async () => {
    await resetDb();
    await seedCompletedTaskScenario();

    await reconcileMultiChapterBatch('b1', {
      owner: 'probe-test',
      maxSteps: 30,
    });

    const batch = await getBatchById('b1');
    const items = await getBatchItems('b1');
    const item = items[0];
    expect(batch?.status).toBe('completed');
    expect(item?.status).toBe('succeeded');
    expect(item?.adoptedRevisionId).not.toBeNull();
    expect(item?.adoptionFingerprint).not.toBeNull();
    // 不应出现 run3。
    const runs = await execute(
      await openDatabase(),
      `SELECT COUNT(*) AS c FROM multi_chapter_batch_item_runs WHERE batch_id = 'b1' AND ordinal = 1`,
    );
    expect(Number(runs.rows.item(0).c)).toBe(2);
  });
});
