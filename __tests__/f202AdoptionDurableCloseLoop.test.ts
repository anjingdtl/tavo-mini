/**
 * F2-02: Adoption durable close-loop（修复前稳定失败测试）。
 *
 * 风险：adoptPipelineTaskResultAtomic 事务提交后才做
 *   store.resolveTask()（fire-and-forget DB 写）
 *   markStoryMemoryDirtyIfCovered()（独立事务）
 * 若进程在事务提交后、这两次 best-effort JS 调用前崩溃，则：
 *   - pipeline_tasks.resolved_at 仍为 NULL（batch 已 completed，冷启动 reconcile
 *     因 item fingerprint 相同而 alreadyAdopted 短路，task 永远 unresolved）
 *   - project_story_memory.status 不是 dirty（dirty intent 丢失）
 *
 * 本测试禁用 post-commit JS 调用（spyOn 成 no-op，模拟进程崩溃），只从
 * 真实 SQLite 读取状态——任务要求 task durable resolved + story memory dirty
 * 都必须已经在 adoption 事务内持久化，不依赖事务后的 JS。
 */
import { __setDatabaseForTest, __resetForTest, openDatabase } from '../src/data/connection/openDatabase';
import { execute } from '../src/data/connection/execute';
import { one, all } from '../src/data/connection/query';
import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import type { InMemorySqliteDb } from './helpers/canonInMemoryDb';
import {
  createBatch,
  createBatchItem,
  createBatchChapterForItem,
  createItemRun,
  updateBatchStatus,
  getBatchItem,
  getBatchById,
} from '../src/data/repositories/multiChapterBatchRepository';
import { savePipelineTask } from '../src/data/repositories/pipelineTaskRepository';
import { adoptPipelineTaskResultAtomic } from '../src/services/multiChapterBatch/batchAdoption';
import { adoptPipelineTaskResult } from '../src/services/multiChapterBatch/batchAdoption';
import { usePipelineTaskStore } from '../src/store/pipelineTaskStore';
import * as storyMemoryRepo from '../src/data/repositories/storyMemoryRepository';
import * as storyMemoryService from '../src/services/storyMemory/storyMemoryService';
import { createEmptyStoryMemory } from '../src/services/storyMemory/storyMemoryDefaults';
import { canonicalStringify } from '../src/services/storyMemory/storyMemoryFingerprint';

let testDb: InMemorySqliteDb | null = null;
let resolveTaskSpy: jest.SpyInstance | null = null;
let markDirtySpy: jest.SpyInstance | null = null;
let enqueueMaintenanceSpy: jest.SpyInstance | null = null;

async function resetDb() {
  __resetForTest();
  testDb = await createCanonInMemoryDb();
  __setDatabaseForTest(testDb as any);
  resolveTaskSpy = jest
    .spyOn(usePipelineTaskStore.getState(), 'resolveTask')
    .mockImplementation(() => undefined);
  markDirtySpy = jest
    .spyOn(storyMemoryRepo, 'markStoryMemoryDirtyIfCovered')
    .mockImplementation(async () => {
      throw new Error('POST_COMMIT_CRASH_SIMULATED');
    });
  enqueueMaintenanceSpy = jest
    .spyOn(storyMemoryService, 'enqueueStoryMemoryMaintenance')
    .mockImplementation(() => undefined);
}

afterEach(async () => {
  resolveTaskSpy?.mockRestore();
  markDirtySpy?.mockRestore();
  enqueueMaintenanceSpy?.mockRestore();
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

async function seedAdoptionState(options: {
  oldContent?: string;
  position?: number;
  finalized?: boolean;
  storyMemory?: { throughPosition: number; status?: string };
} = {}): Promise<number> {
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
  const position = options.position ?? 0;
  const chapterId = await createBatchChapterForItem('b1', 1, {
    projectId: 1,
    position,
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
  if (options.finalized) {
    await execute(
      await openDatabase(),
      `UPDATE chapters SET status = 'final', finalized_at = 't' WHERE id = ?`,
      [chapterId],
    );
  }
  if (options.storyMemory) {
    const state = createEmptyStoryMemory(1);
    state.throughChapterPosition = options.storyMemory.throughPosition;
    const now = new Date().toISOString();
    await execute(
      await openDatabase(),
      `INSERT INTO project_story_memory (
        project_id, schema_version, through_chapter_id,
        through_chapter_position, memory_json, estimated_tokens,
        state_fingerprint, last_applied_patch_id, status, source,
        dirty_from_position, last_error, updated_at
      ) VALUES (1, 1, NULL, ?, ?, 0, ?, NULL, ?, 'native', NULL, '', ?)`,
      [
        options.storyMemory.throughPosition,
        canonicalStringify(state),
        state.metadata.stateFingerprint,
        options.storyMemory.status ?? 'ready',
        now,
      ],
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

async function taskResolved(): Promise<{ resolvedAt: string | null; action: string | null }> {
  const row = await one(
    `SELECT resolved_at, resolved_action FROM pipeline_tasks WHERE id = 't1'`,
  );
  return {
    resolvedAt: row?.resolved_at ?? null,
    action: row?.resolved_action ?? null,
  };
}

async function storyMemoryState(): Promise<{ status: string; dirtyFrom: number | null }> {
  const row = await one(
    `SELECT status, dirty_from_position FROM project_story_memory WHERE project_id = 1`,
  );
  return {
    status: String(row?.status ?? ''),
    dirtyFrom: row?.dirty_from_position != null ? Number(row.dirty_from_position) : null,
  };
}

describe('F2-02: Adoption durable close-loop（post-commit 崩溃模拟）', () => {
  jest.setTimeout(60_000);

  it('事务提交即 task durable resolved + story memory dirty（post-commit JS 禁用）', async () => {
    await resetDb();
    const chapterId = await seedAdoptionState({
      oldContent: '旧正文',
      finalized: true,
      storyMemory: { throughPosition: 0 },
    });

    await adoptPipelineTaskResultAtomic({
      taskId: 't1',
      chapterId,
      source: 'multi_chapter_batch',
      batchId: 'b1',
      ordinal: 1,
      completionQuality: 'full_pipeline',
      chapterCount: 1,
    });

    const task = await taskResolved();
    expect(task.resolvedAt).not.toBeNull();
    expect(task.action).toBe('accept');

    const sm = await storyMemoryState();
    expect(sm.status).toBe('dirty');
    expect(sm.dirtyFrom).toBe(0);

    const item = await getBatchItem('b1', 1);
    expect(item?.status).toBe('succeeded');
    const batch = await getBatchById('b1');
    expect(batch?.status).toBe('completed');
  });

  it('position 超出覆盖：pending_invalidated 侧效果也持久化在事务内', async () => {
    await resetDb();
    const chapterId = await seedAdoptionState({
      oldContent: '旧正文',
      position: 5,
      finalized: true,
      storyMemory: { throughPosition: 0 },
    });
    // 预置一条覆盖该位置的 generated batch。
    await execute(
      await openDatabase(),
      `INSERT INTO story_memory_batches (
        batch_id, project_id, from_chapter_id, from_position,
        through_chapter_id, through_position, schema_version,
        source_fingerprint, base_state_fingerprint, result_state_fingerprint,
        patch_json, status, last_error, generated_at, applied_at
      ) VALUES ('sb1', 1, ?, 5, ?, 5, 2, 'f', 'f', 'f', '{}', 'generated', '', ?, NULL)`,
      [chapterId, chapterId, new Date().toISOString()],
    );

    await adoptPipelineTaskResultAtomic({
      taskId: 't1',
      chapterId,
      source: 'multi_chapter_batch',
      batchId: 'b1',
      ordinal: 1,
      completionQuality: 'full_pipeline',
      chapterCount: 1,
    });

    const sm = await storyMemoryState();
    expect(sm.status).toBe('ready'); // 覆盖外：不置 dirty
    const batch = await one(`SELECT status FROM story_memory_batches WHERE batch_id = 'sb1'`);
    expect(batch?.status).toBe('invalidated');

    const task = await taskResolved();
    expect(task.resolvedAt).not.toBeNull();
  });

  it('crash 注入后重试：task resolved + dirty 最终持久化', async () => {
    await resetDb();
    const chapterId = await seedAdoptionState({
      oldContent: '旧正文',
      finalized: true,
      storyMemory: { throughPosition: 0 },
    });

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

    let task = await taskResolved();
    expect(task.resolvedAt).toBeNull();

    await adoptPipelineTaskResultAtomic({
      taskId: 't1',
      chapterId,
      source: 'multi_chapter_batch',
      batchId: 'b1',
      ordinal: 1,
      completionQuality: 'full_pipeline',
      chapterCount: 1,
    });

    task = await taskResolved();
    expect(task.resolvedAt).not.toBeNull();
    expect(task.action).toBe('accept');
    const sm = await storyMemoryState();
    expect(sm.status).toBe('dirty');
  });

  it('重复 adoption 幂等：不重复改变 task/story-memory 终态', async () => {
    await resetDb();
    const chapterId = await seedAdoptionState({
      oldContent: '旧正文',
      storyMemory: { throughPosition: 0 },
    });

    await adoptPipelineTaskResultAtomic({
      taskId: 't1',
      chapterId,
      source: 'multi_chapter_batch',
      batchId: 'b1',
      ordinal: 1,
      completionQuality: 'full_pipeline',
      chapterCount: 1,
    });
    const firstTask = await taskResolved();
    const firstSm = await storyMemoryState();
    const firstBatch = await getBatchById('b1');

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

    const secondTask = await taskResolved();
    const secondSm = await storyMemoryState();
    const secondBatch = await getBatchById('b1');
    expect(secondTask).toEqual(firstTask);
    expect(secondSm).toEqual(firstSm);
    expect(secondBatch?.completedCount).toBe(firstBatch?.completedCount);
  });

  it('无 story memory 记录：task 仍 durable resolved，且不产生脏行', async () => {
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

    const task = await taskResolved();
    expect(task.resolvedAt).not.toBeNull();
    expect(task.action).toBe('accept');

    const rows = await all(`SELECT COUNT(*) AS c FROM project_story_memory WHERE project_id = 1`);
    expect(Number(rows[0]?.c ?? 0)).toBe(0);
  });

  it('已覆盖章节的手动采纳必须续接唯一 Story Memory 维护队列', async () => {
    await resetDb();
    const chapterId = await seedAdoptionState({
      oldContent: '旧正文',
      storyMemory: { throughPosition: 0 },
    });
    await execute(
      await openDatabase(),
      `UPDATE chapters SET status = 'final', finalized_at = 't' WHERE id = ?`,
      [chapterId],
    );

    await adoptPipelineTaskResult({
      taskId: 't1',
      chapterId,
      source: 'manual',
    });

    expect(enqueueMaintenanceSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 1,
        reason: 'dirty',
        priority: 'background',
      }),
    );
  });
});
