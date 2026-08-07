/**
 * F2-07 UI 修复：批次暂停页点"确认后继续"无反应（store 内存态不刷新）。
 *
 * 根因：store.resume() 写 DB（updateBatchStatus 'running'）后不刷新
 * store.batch 内存态；页面 view 依赖 store.batch.status 决定显示
 * paused / running。而 reconcile 是长跑（每章 4 阶段阻塞数分钟），
 * driveBatchReconcile 完成时才 refreshBatch —— 用户点"确认后继续"后
 * UI 停留在暂停视图数分钟无任何反应。
 *
 * 修复：resume() 在 re-arm batch 后立即 refreshBatch，让页面立即切回
 * 运行视图（批次后台继续）。
 */
jest.mock('../src/services/multiChapterBatch/planner', () => {
  const actual = jest.requireActual('../src/services/multiChapterBatch/planner');
  return {
    ...actual,
    createBatchChapterPlan: jest.fn(async () => ({
      plan: { chapters: [{ ordinal: 1, title: '第1章', synopsis: 's', keyBeats: [], carryIn: '', carryOut: '', targetWords: 3000 }] },
      hash: 'h',
      requestJson: '{}',
      requestFingerprint: 'fp',
      messages: [],
      estimatedInputTokens: 10,
      usedRepair: false,
    })),
    collectPlannerMaterials: jest.fn(async () => ({
      outlineText: '',
      recentChaptersText: '',
      charactersText: '',
      worldbookText: '',
      storyMemoryText: '',
    })),
  };
});

// reconcile 模拟"长跑"：不 resolve（真实场景每章运行数分钟），
// 验证 resume 的 UI 状态刷新不依赖 reconcile 完成。
jest.mock('../src/services/multiChapterBatch/reconcileMultiChapterBatch', () => ({
  reconcileMultiChapterBatch: jest.fn(
    () => new Promise<void>(() => {}),
  ),
}));

const mockResolveLLMRequestConfig = jest.fn();
jest.mock('../src/services/llm', () => ({
  resolveLLMRequestConfig: (...args: any[]) => mockResolveLLMRequestConfig(...args),
}));

jest.mock('../src/native/PipelineForegroundModule', () => ({
  PipelineForeground: {
    start: jest.fn(() => Promise.resolve()),
    updateProgress: jest.fn(() => Promise.resolve()),
    notifyComplete: jest.fn(() => Promise.resolve()),
    notifyFailed: jest.fn(() => Promise.resolve()),
    stop: jest.fn(() => Promise.resolve()),
  },
}));

import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import type { InMemorySqliteDb } from './helpers/canonInMemoryDb';
import { __setDatabaseForTest, __resetForTest } from '../src/data/connection/openDatabase';
import { execute } from '../src/data/connection/execute';
import { one, all } from '../src/data/connection/query';
import { openDatabase } from '../src/data/connection/openDatabase';
import { useMultiChapterBatchStore, resetBatchInstanceId } from '../src/store/multiChapterBatchStore';
import {
  createBatch,
  createBatchItem,
  updateBatchStatus,
  updateBatchItem,
} from '../src/data/repositories/multiChapterBatchRepository';
import { savePipelineTask } from '../src/data/repositories/pipelineTaskRepository';

let testDb: InMemorySqliteDb | null = null;

async function resetDb() {
  __resetForTest();
  testDb = await createCanonInMemoryDb();
  __setDatabaseForTest(testDb as any);
}

afterEach(async () => {
  __resetForTest();
  resetBatchInstanceId();
  jest.clearAllMocks();
  if (testDb) {
    try {
      testDb.close();
    } catch {
      /* ignore */
    }
    testDb = null;
  }
});

async function seedPausedBatch(): Promise<void> {
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
  await updateBatchStatus('b1', 'paused_timeout_unknown', {
    errorCode: 'BATCH_LLM_OUTCOME_UNKNOWN',
  });
  await updateBatchItem('b1', 1, {
    status: 'outcome_unknown',
    errorCode: 'BATCH_LLM_OUTCOME_UNKNOWN',
  });
}

describe('F2-07: resume 后 UI 状态立即刷新（不依赖 reconcile 完成）', () => {
  it('点"确认后继续"后 store.batch.status 立即从 paused 变为 running', async () => {
    await resetDb();
    await seedPausedBatch();
    const store = useMultiChapterBatchStore;
    await store.getState().loadBatch('b1');
    expect(store.getState().batch?.status).toBe('paused_timeout_unknown');

    await store.getState().resume('b1');
    // 让异步微任务跑完（refreshBatch 在 resume 内同步执行）。
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(store.getState().batch?.status).toBe('running');
  });

  it('resume 后 item 的 outcome_unknown 被解绑（activePipelineTaskId 置空）', async () => {
    await resetDb();
    await seedPausedBatch();
    const store = useMultiChapterBatchStore;
    await store.getState().loadBatch('b1');

    await store.getState().resume('b1');
    await new Promise(resolve => setTimeout(resolve, 20));

    const item = store.getState().items[0];
    expect(item?.status).toBe('running_pipeline');
    expect(item?.activePipelineTaskId).toBeNull();
  });
});

describe('F2-07: resume 有成功 checkpoint 时从失败 stage 续跑（token 保护）', () => {
  async function seedPausedBatchWithCheckpoints(): Promise<string> {
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
    const taskId = 'batch_b1_ord1_t1';
    await savePipelineTask({
      id: taskId,
      targetType: 'chapter',
      targetId: 100,
      status: 'failed',
      stageResults: [],
      finalText: null,
      error: 'Network request failed',
      createdAt: 1000,
      updatedAt: 2000,
      resolvedAt: null,
    });
    // 模拟 network_error 中断在终审：draft/review/factCheck succeeded，proof failed。
    const now = Date.now();
    for (const stage of ['draft', 'review', 'factCheck']) {
      await execute(
        await openDatabase(),
        `INSERT INTO pipeline_stage_checkpoints (task_id, stage, status, attempt_count, updated_at)
         VALUES (?, ?, 'succeeded', 1, ?)`,
        [taskId, stage, now],
      );
    }
    await execute(
      await openDatabase(),
      `INSERT INTO pipeline_stage_checkpoints (task_id, stage, status, attempt_count, updated_at)
       VALUES (?, 'proof', 'failed', 1, ?)`,
      [taskId, now],
    );
    await updateBatchStatus('b1', 'paused_timeout_unknown', {
      errorCode: 'BATCH_LLM_OUTCOME_UNKNOWN',
    });
    await updateBatchItem('b1', 1, {
      status: 'outcome_unknown',
      activePipelineTaskId: taskId,
      errorCode: 'BATCH_LLM_OUTCOME_UNKNOWN',
    });
    return taskId;
  }

  it('有成功 checkpoint：resume 保留 task，失败 stage 重置为 pending，task 转 interrupted', async () => {
    await resetDb();
    const taskId = await seedPausedBatchWithCheckpoints();
    const store = useMultiChapterBatchStore;
    await store.getState().loadBatch('b1');

    await store.getState().resume('b1');
    await new Promise(resolve => setTimeout(resolve, 20));

    // task 保留（未解绑）。
    const item = store.getState().items[0];
    expect(item?.status).toBe('running_pipeline');
    expect(item?.activePipelineTaskId).toBe(taskId);

    // task 状态转为 interrupted（pipeline 状态机对 interrupted 走 resume）。
    const task = await one(
      `SELECT status FROM pipeline_tasks WHERE id = ?`,
      [taskId],
    );
    expect(String(task?.status)).toBe('interrupted');

    // 失败 stage 重置为 pending；成功 stage 保留 succeeded（不会重跑）。
    const checkpoints = await all(
      `SELECT stage, status FROM pipeline_stage_checkpoints WHERE task_id = ? ORDER BY stage`,
      [taskId],
    );
    const byStage = Object.fromEntries(
      checkpoints.map((r: any) => [r.stage, r.status]),
    );
    expect(byStage.draft).toBe('succeeded');
    expect(byStage.review).toBe('succeeded');
    expect(byStage.factCheck).toBe('succeeded');
    expect(byStage.proof).toBe('pending');
  });

  it('无成功 checkpoint：resume 仍走全新 run（解绑 task）', async () => {
    await resetDb();
    await seedPausedBatch();
    const store = useMultiChapterBatchStore;
    await store.getState().loadBatch('b1');

    await store.getState().resume('b1');
    await new Promise(resolve => setTimeout(resolve, 20));

    const item = store.getState().items[0];
    expect(item?.activePipelineTaskId).toBeNull();
  });
});
