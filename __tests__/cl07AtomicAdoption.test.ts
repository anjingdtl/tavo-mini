/**
 * CL-07: Adoption 原子闭环 + 崩溃注入（修复前稳定失败测试）。
 *
 * 修复前 `adoptAndCommit` 分 6 次独立写：旧 revision → chapter.content →
 * pipeline revision → item fingerprint → counters → usage。任何一步之间
 * 崩溃都会留下半提交状态（正文已写但 counters 未动，或反之）。
 *
 * 本测试使用真实 in-memory SQLite + 真实 adoption 语句批 + fault-injection
 * 事务域（FAIL_ADOPTION_AT_STATEMENT），在每个语句边界注入崩溃：
 *
 *   旧 revision 前/后 → chapter update 后 → pipeline revision 后 →
 *   item binding 后 → counter 后
 *
 * 每个崩溃点恢复后必须 ALL-OR-NOTHING：正文、revision 数、item 状态、
 * counters、task resolved 全部保持崩溃前原状。
 */
import { __setDatabaseForTest, __resetForTest, openDatabase } from '../src/data/connection/openDatabase';
import { execute } from '../src/data/connection/execute';
import { all, one } from '../src/data/connection/query';
import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import type { InMemorySqliteDb } from './helpers/canonInMemoryDb';
import {
  createBatch,
  createBatchItem,
  createBatchChapterForItem,
  createItemRun,
  updateBatchStatus,
  getBatchById,
  getBatchItem,
} from '../src/data/repositories/multiChapterBatchRepository';
import { savePipelineTask } from '../src/data/repositories/pipelineTaskRepository';
import { adoptPipelineTaskResultAtomic } from '../src/services/multiChapterBatch/batchAdoption';
import { usePipelineTaskStore } from '../src/store/pipelineTaskStore';

let testDb: InMemorySqliteDb | null = null;

async function resetDb() {
  __resetForTest();
  testDb = await createCanonInMemoryDb();
  __setDatabaseForTest(testDb as any);
}

afterEach(async () => {
  __resetForTest();
  delete process.env.FAIL_ADOPTION_AT_STATEMENT;
  if (testDb) {
    try {
      testDb.close();
    } catch {
      /* ignore */
    }
    testDb = null;
  }
});

async function seedAdoptionState(): Promise<number> {
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
  // 旧正文（将被 revision 保留）。
  await execute(
    await openDatabase(),
    `UPDATE chapters SET content = '旧正文' WHERE id = ?`,
    [chapterId],
  );
  const now = Date.now();
  await savePipelineTask({
    id: 't1',
    targetType: 'chapter',
    targetId: chapterId,
    status: 'completed',
    stageResults: [],
    finalText: '新正文',
    error: null,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
  });
  await createItemRun({
    batchId: 'b1',
    ordinal: 1,
    runNo: 1,
    pipelineTaskId: 't1',
    llmConfigSnapshotJson: '{}',
    reason: 'batch_start',
  });
  usePipelineTaskStore.getState().registerPersistedTask({
    id: 't1',
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
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    resolvedAction: null,
  });
  return chapterId;
}

async function snapshotState(chapterId: number) {
  const chapter = await one(
    `SELECT content FROM chapters WHERE id = ?`,
    [chapterId],
  );
  const revisions = await all(
    `SELECT COUNT(*) AS c FROM content_revisions WHERE target_id = ? AND target_type = 'chapter'`,
    [chapterId],
  );
  const item = await getBatchItem('b1', 1);
  const batch = await getBatchById('b1');
  const task = await one(`SELECT resolved_at, resolved_action FROM pipeline_tasks WHERE id = 't1'`);
  return {
    content: String(chapter?.content ?? ''),
    revisionCount: Number(revisions[0].c ?? 0),
    itemStatus: item?.status,
    itemFingerprint: item?.adoptionFingerprint ?? null,
    completedCount: batch?.completedCount,
    currentOrdinal: batch?.currentOrdinal,
    batchStatus: batch?.status,
    taskResolved: task?.resolved_at ?? null,
    taskAction: task?.resolved_action ?? null,
  };
}

describe('CL-07: 原子 adoption 闭环（单事务 all-or-nothing）', () => {
  jest.setTimeout(60_000);

  it('正常 adoption：正文/revisions/item/counters/task 一次闭环', async () => {
    await resetDb();
    const chapterId = await seedAdoptionState();
    const before = await snapshotState(chapterId);
    expect(before.content).toBe('旧正文');
    expect(before.revisionCount).toBe(0);

    const result = await adoptPipelineTaskResultAtomic({
      taskId: 't1',
      chapterId,
      source: 'multi_chapter_batch',
      batchId: 'b1',
      ordinal: 1,
      completionQuality: 'full_pipeline',
      chapterCount: 1,
    });

    const after = await snapshotState(chapterId);
    expect(after.content).toBe('新正文');
    // 旧正文 revision + pipeline revision。
    expect(after.revisionCount).toBe(2);
    expect(after.itemStatus).toBe('succeeded');
    expect(after.itemFingerprint).toBe(result.adoptionFingerprint);
    expect(after.completedCount).toBe(1);
    expect(after.currentOrdinal).toBe(1);
    expect(after.batchStatus).toBe('completed');
  });

  it('重复 adoption 幂等：不重复写正文/修订/计数', async () => {
    await resetDb();
    const chapterId = await seedAdoptionState();
    await adoptPipelineTaskResultAtomic({
      taskId: 't1',
      chapterId,
      source: 'multi_chapter_batch',
      batchId: 'b1',
      ordinal: 1,
      completionQuality: 'full_pipeline',
      chapterCount: 1,
    });
    const first = await snapshotState(chapterId);

    const result = await adoptPipelineTaskResultAtomic({
      taskId: 't1',
      chapterId,
      source: 'multi_chapter_batch',
      batchId: 'b1',
      ordinal: 1,
      completionQuality: 'full_pipeline',
      chapterCount: 1,
    });
    expect(result.alreadyAdopted).toBe(true);
    const second = await snapshotState(chapterId);
    expect(second.revisionCount).toBe(first.revisionCount);
    expect(second.completedCount).toBe(first.completedCount);
    expect(second.content).toBe('新正文');
  });

  // ── 崩溃注入矩阵：每个语句边界失败 → 全量回滚 ─────────────────────────
  const CRASH_POINTS = [
    { at: 1, label: '旧 revision 写入后' },
    { at: 2, label: 'chapter update 后' },
    { at: 3, label: 'pipeline revision 后' },
    { at: 4, label: 'item binding 后' },
    { at: 5, label: 'batch counter 后' },
  ];

  for (const point of CRASH_POINTS) {
    it(`崩溃注入（${point.label}）→ 全量回滚，不留半提交状态`, async () => {
      await resetDb();
      const chapterId = await seedAdoptionState();
      const before = await snapshotState(chapterId);

      process.env.FAIL_ADOPTION_AT_STATEMENT = String(point.at);

      let caught: any = null;
      try {
        await adoptPipelineTaskResultAtomic({
          taskId: 't1',
          chapterId,
          source: 'multi_chapter_batch',
          batchId: 'b1',
          ordinal: 1,
          completionQuality: 'full_pipeline',
          chapterCount: 1,
        });
      } catch (e: any) {
        caught = e;
      }
      expect(caught).not.toBeNull();

      // ALL-OR-NOTHING：正文、revision、item、counters、task 全未变。
      const after = await snapshotState(chapterId);
      expect(after).toEqual(before);
    });
  }

  it('崩溃恢复后重试 adoption 成功且无重复', async () => {
    await resetDb();
    const chapterId = await seedAdoptionState();

    // 第 4 条（item binding）崩溃 → 回滚。
    process.env.FAIL_ADOPTION_AT_STATEMENT = '4';
    await expect(
      adoptPipelineTaskResultAtomic({
        taskId: 't1',
        chapterId,
        source: 'multi_chapter_batch',
        batchId: 'b1',
        ordinal: 1,
        completionQuality: 'full_pipeline',
        chapterCount: 1,
      }),
    ).rejects.toThrow();
    delete process.env.FAIL_ADOPTION_AT_STATEMENT;

    // 重试 → 成功，且只有一份 revision 对。
    const result = await adoptPipelineTaskResultAtomic({
      taskId: 't1',
      chapterId,
      source: 'multi_chapter_batch',
      batchId: 'b1',
      ordinal: 1,
      completionQuality: 'full_pipeline',
      chapterCount: 1,
    });
    expect(result.alreadyAdopted).toBe(false);
    const after = await snapshotState(chapterId);
    expect(after.content).toBe('新正文');
    expect(after.revisionCount).toBe(2);
    expect(after.completedCount).toBe(1);
    expect(after.batchStatus).toBe('completed');
  });
});
