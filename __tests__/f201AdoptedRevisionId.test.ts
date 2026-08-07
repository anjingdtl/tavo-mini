/**
 * F2-01: adoptedRevisionId 原子回填（修复前稳定失败测试）。
 *
 * Atomic Adoption 事务内 pipeline revision 的 insertId 只在执行阶段取得，
 * 而 batch item UPDATE 在语句构建阶段参数已被定死。本测试断言：
 *
 *   multi_chapter_batch_items.adopted_revision_id
 *   === content_revisions.id (source='pipeline', source_ref=taskId)
 *
 * 走真实 SQLite（sql.js in-memory）+ 真实 adoptPipelineTaskResultAtomic +
 * 真实 executeTransaction 路径，禁止手工 SQL 回填。
 */
import { __setDatabaseForTest, __resetForTest, openDatabase } from '../src/data/connection/openDatabase';
import { execute } from '../src/data/connection/execute';
import { all } from '../src/data/connection/query';
import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import type { InMemorySqliteDb } from './helpers/canonInMemoryDb';
import {
  createBatch,
  createBatchItem,
  createBatchChapterForItem,
  createItemRun,
  updateBatchStatus,
  getBatchItem,
} from '../src/data/repositories/multiChapterBatchRepository';
import { savePipelineTask } from '../src/data/repositories/pipelineTaskRepository';
import { adoptPipelineTaskResultAtomic } from '../src/services/multiChapterBatch/batchAdoption';

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

async function seedAdoptionState(options: { oldContent?: string } = {}): Promise<number> {
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
  if (options.oldContent != null) {
    await execute(
      await openDatabase(),
      `UPDATE chapters SET content = ? WHERE id = ?`,
      [options.oldContent, chapterId],
    );
  }
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
  return chapterId;
}

async function pipelineRevisionId(chapterId: number): Promise<number | null> {
  const rows = await all(
    `SELECT id FROM content_revisions
     WHERE target_type = 'chapter' AND target_id = ?
       AND source = 'pipeline' AND source_ref = 't1'`,
    [chapterId],
  );
  return rows.length > 0 ? Number(rows[0].id) : null;
}

describe('F2-01: adoptedRevisionId 原子回填', () => {
  jest.setTimeout(60_000);

  it('有旧正文：item.adoptedRevisionId === pipeline revision id', async () => {
    await resetDb();
    const chapterId = await seedAdoptionState({ oldContent: '旧正文' });

    const result = await adoptPipelineTaskResultAtomic({
      taskId: 't1',
      chapterId,
      source: 'multi_chapter_batch',
      batchId: 'b1',
      ordinal: 1,
      completionQuality: 'full_pipeline',
      chapterCount: 1,
    });

    const revisionId = await pipelineRevisionId(chapterId);
    expect(revisionId).not.toBeNull();
    expect(result.adoptedRevisionId).toBe(revisionId);

    const item = await getBatchItem('b1', 1);
    expect(item?.adoptedRevisionId).toBe(revisionId);
  });

  it('无旧正文：item.adoptedRevisionId === pipeline revision id', async () => {
    await resetDb();
    const chapterId = await seedAdoptionState();

    const result = await adoptPipelineTaskResultAtomic({
      taskId: 't1',
      chapterId,
      source: 'multi_chapter_batch',
      batchId: 'b1',
      ordinal: 1,
      completionQuality: 'full_pipeline',
      chapterCount: 1,
    });

    const revisionId = await pipelineRevisionId(chapterId);
    expect(revisionId).not.toBeNull();
    expect(result.adoptedRevisionId).toBe(revisionId);

    const item = await getBatchItem('b1', 1);
    expect(item?.adoptedRevisionId).toBe(revisionId);
  });

  it('重复 adoption：adoptedRevisionId 幂等且仍指向同一 pipeline revision', async () => {
    await resetDb();
    const chapterId = await seedAdoptionState({ oldContent: '旧正文' });

    await adoptPipelineTaskResultAtomic({
      taskId: 't1',
      chapterId,
      source: 'multi_chapter_batch',
      batchId: 'b1',
      ordinal: 1,
      completionQuality: 'full_pipeline',
      chapterCount: 1,
    });
    const firstRevisionId = await pipelineRevisionId(chapterId);
    const firstItem = await getBatchItem('b1', 1);
    expect(firstItem?.adoptedRevisionId).toBe(firstRevisionId);

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
    expect(result.adoptedRevisionId).toBe(firstRevisionId);

    const secondItem = await getBatchItem('b1', 1);
    expect(secondItem?.adoptedRevisionId).toBe(firstRevisionId);
  });

  it('crash 注入后重试：adoptedRevisionId 最终正确持久化', async () => {
    await resetDb();
    const chapterId = await seedAdoptionState({ oldContent: '旧正文' });

    // 第 5 条（batch counter）崩溃 → 全量回滚。
    process.env.FAIL_ADOPTION_AT_STATEMENT = '5';
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

    const beforeRetry = await getBatchItem('b1', 1);
    expect(beforeRetry?.adoptedRevisionId).toBeNull();

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

    const revisionId = await pipelineRevisionId(chapterId);
    expect(revisionId).not.toBeNull();
    expect(result.adoptedRevisionId).toBe(revisionId);

    const item = await getBatchItem('b1', 1);
    expect(item?.adoptedRevisionId).toBe(revisionId);

    // revision.content 必须等于 chapter.content（同一份最终正文）。
    const chapter = await all(`SELECT content FROM chapters WHERE id = ?`, [chapterId]);
    const revision = await all(`SELECT content FROM content_revisions WHERE id = ?`, [revisionId!]);
    expect(String(chapter[0]?.content ?? '')).toBe('新正文');
    expect(String(revision[0]?.content ?? '')).toBe('新正文');
  });
});
