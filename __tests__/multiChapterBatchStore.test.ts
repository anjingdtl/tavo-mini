/**
 * Phase 8: multi-chapter batch store (create → plan → confirm → start).
 * Uses real in-memory SQLite for batch rows; mocks the planner LLM call and
 * the batch reconciler so the store flow is deterministic.
 */
jest.mock('../src/services/multiChapterBatch/planner', () => {
  const actual = jest.requireActual('../src/services/multiChapterBatch/planner');
  return {
    ...actual,
    createBatchChapterPlan: jest.fn(async () => ({
      plan: {
        chapters: [
          {
            ordinal: 1,
            title: '第一章',
            synopsis: '梗概1',
            keyBeats: ['节拍'],
            carryIn: '',
            carryOut: '悬念',
            targetWords: 3000,
          },
          {
            ordinal: 2,
            title: '第二章',
            synopsis: '梗概2',
            keyBeats: ['节拍2'],
            carryIn: '悬念',
            carryOut: '',
            targetWords: 3000,
          },
        ],
      },
      hash: 'planner-hash-1',
      requestJson: '{}',
      requestFingerprint: 'fp',
      messages: [],
      estimatedInputTokens: 100,
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

jest.mock('../src/services/multiChapterBatch/reconcileMultiChapterBatch', () => ({
  reconcileMultiChapterBatch: jest.fn(async () => undefined),
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
import { openDatabase } from '../src/data/connection/openDatabase';
import { useMultiChapterBatchStore, resetBatchInstanceId } from '../src/store/multiChapterBatchStore';
import { getBatchById, getBatchItems } from '../src/data/repositories/multiChapterBatchRepository';
import { createBatchChapterPlan } from '../src/services/multiChapterBatch/planner';
import { reconcileMultiChapterBatch } from '../src/services/multiChapterBatch/reconcileMultiChapterBatch';
import {
  CURRENT_OUTLINE_WORKFLOW_VERSION,
  V3_HIERARCHICAL_CONTEXT_BUDGET_VERSION,
} from '../src/services/pipeline/outlineWorkflowVersion';

let testDb: InMemorySqliteDb | null = null;

async function resetDb() {
  __resetForTest();
  testDb = await createCanonInMemoryDb();
  __setDatabaseForTest(testDb as any);
}

afterEach(async () => {
  __resetForTest();
  resetBatchInstanceId();
  if (testDb) {
    try {
      testDb.close();
    } catch {
      // ignore
    }
    testDb = null;
  }
});

describe('multiChapterBatchStore', () => {
  it('creates a draft batch with items', async () => {
    await resetDb();
    await execute(
      await openDatabase(),
      `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
      [],
    );
    const id = await useMultiChapterBatchStore.getState().createDraftBatch({
      projectId: 1,
      sourcePrompt: '摘要',
      chapterCount: 3,
      targetWordsPerChapter: 3000,
      pipelineMode: 'full',
    });
    expect(id).toBeTruthy();
    const batch = await getBatchById(id);
    expect(batch?.status).toBe('draft');
    const items = await getBatchItems(id);
    expect(items).toHaveLength(3);
    expect(items[0].ordinal).toBe(1);
    expect(useMultiChapterBatchStore.getState().batch?.id).toBe(id);
  });

  it('runs the planner and stores planning state', async () => {
    await resetDb();
    await execute(
      await openDatabase(),
      `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
      [],
    );
    mockResolveLLMRequestConfig.mockResolvedValue({
      context_window: 1000000,
    });
    const store = useMultiChapterBatchStore.getState();
    const id = await store.createDraftBatch({
      projectId: 1,
      sourcePrompt: '摘要',
      chapterCount: 2,
      targetWordsPerChapter: 3000,
      pipelineMode: 'full',
    });
    const plan = await useMultiChapterBatchStore.getState().runPlanner(id);
    expect(plan.chapters).toHaveLength(2);
    const batch = await getBatchById(id);
    expect(batch?.status).toBe('planning');
    expect(batch?.plannerHash).toBe('planner-hash-1');
    // 批次消耗上限由弹性预算池自动分配（用户无需感知）
    expect(batch?.maxLlmCalls).toBe(24);
    expect(batch?.maxInputTokens).toBe(4_000_000);
    expect(batch?.maxOutputTokens).toBe(2_000_000);
    expect(createBatchChapterPlan).toHaveBeenCalled();
  });

  it('saves the edited plan, freezes the hash and marks ready', async () => {
    await resetDb();
    await execute(
      await openDatabase(),
      `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
      [],
    );
    const store = useMultiChapterBatchStore.getState();
    const id = await store.createDraftBatch({
      projectId: 1,
      sourcePrompt: '摘要',
      chapterCount: 2,
      targetWordsPerChapter: 3000,
      pipelineMode: 'full',
    });
    await useMultiChapterBatchStore.getState().runPlanner(id);
    await useMultiChapterBatchStore.getState().saveEditedPlan(id, [
      { ordinal: 1, title: '第一章', synopsis: '新梗概1', keyBeats: ['k1'], carryIn: '', carryOut: '', targetWords: 3000 },
      { ordinal: 2, title: '第二章', synopsis: '新梗概2', keyBeats: ['k2'], carryIn: '', carryOut: '', targetWords: 3000 },
    ]);
    const batch = await getBatchById(id);
    expect(batch?.status).toBe('ready');
    expect(batch?.plannerHash).toBeTruthy();
    const items = await getBatchItems(id);
    expect(items[0].synopsis).toBe('新梗概1');
  });

  it('starts the batch via the reconciler (injected instance owner)', async () => {
    await resetDb();
    await execute(
      await openDatabase(),
      `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
      [],
    );
    const store = useMultiChapterBatchStore.getState();
    const id = await store.createDraftBatch({
      projectId: 1,
      sourcePrompt: '摘要',
      chapterCount: 1,
      targetWordsPerChapter: 3000,
      pipelineMode: 'full',
    });
    await useMultiChapterBatchStore.getState().runPlanner(id);
    await useMultiChapterBatchStore.getState().saveEditedPlan(id, [
      { ordinal: 1, title: '第一章', synopsis: 's', keyBeats: ['k'], carryIn: '', carryOut: '', targetWords: 3000 },
    ]);
    await useMultiChapterBatchStore.getState().start(id);
    // Non-blocking start (RB-7): the reconciler is driven in the background,
    // so `reconciling` stays true right after start returns.
    expect(useMultiChapterBatchStore.getState().reconciling).toBe(true);
    expect(reconcileMultiChapterBatch).toHaveBeenCalledWith(
      id,
      expect.objectContaining({ owner: expect.stringMatching(/^ui_/) }),
    );
    // …and is cleared once the background drive completes.
    await new Promise(r => setTimeout(r, 10));
    expect(useMultiChapterBatchStore.getState().reconciling).toBe(false);
  });

  it('cancels without deleting completed chapters', async () => {
    await resetDb();
    await execute(
      await openDatabase(),
      `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
      [],
    );
    const store = useMultiChapterBatchStore.getState();
    const id = await store.createDraftBatch({
      projectId: 1,
      sourcePrompt: '摘要',
      chapterCount: 1,
      targetWordsPerChapter: 3000,
      pipelineMode: 'full',
    });
    await useMultiChapterBatchStore.getState().cancel(id);
    const batch = await getBatchById(id);
    expect(batch?.status).toBe('cancelled');
  });

  it('closes a legacy batch and creates a current batch for its remaining tail', async () => {
    await resetDb();
    await execute(
      await openDatabase(),
      `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
      [],
    );
    await execute(
      await openDatabase(),
      `INSERT INTO chapters (id, project_id, position, title, synopsis, content, status, created_at, updated_at)
       VALUES (100, 1, 0, '旧当前章', '旧梗概', '', 'planned', 't', 't')`,
      [],
    );
    await execute(
      await openDatabase(),
      `INSERT INTO multi_chapter_batches (
         id, project_id, status, source_prompt, chapter_count,
         target_words_per_chapter, pipeline_mode, reasoning_effort,
         outline_workflow_version, context_budget_version, created_at, updated_at
       ) VALUES ('legacy-tail', 1, 'paused_user', '原摘要', 3, 3000, 'full', 'high', 1, 1, 't', 't')`,
      [],
    );
    await execute(
      await openDatabase(),
      `INSERT INTO multi_chapter_batch_items
       (batch_id, ordinal, title, synopsis, key_beats_json, target_words, status, chapter_id, created_at, updated_at)
       VALUES
       ('legacy-tail', 1, '已完成', '完成梗概', '["完成"]', 3000, 'succeeded', NULL, 't', 't'),
       ('legacy-tail', 2, '当前章', '当前梗概', '["推进"]', 3200, 'failed', 100, 't', 't'),
       ('legacy-tail', 3, '后续章', '后续梗概', '["承接"]', 3400, 'pending', NULL, 't', 't')`,
      [],
    );

    await useMultiChapterBatchStore.getState().loadBatch('legacy-tail');
    await expect(
      useMultiChapterBatchStore.getState().resume('legacy-tail'),
    ).rejects.toMatchObject({ code: 'BATCH_LEGACY_WORKFLOW_BLOCKED' });
    const newBatchId = await useMultiChapterBatchStore
      .getState()
      .restartLegacyBatch('legacy-tail');

    const oldBatch = await getBatchById('legacy-tail');
    const newBatch = await getBatchById(newBatchId);
    const newItems = await getBatchItems(newBatchId);
    expect(oldBatch?.status).toBe('cancelled');
    expect(oldBatch?.errorCode).toBe('BATCH_LEGACY_WORKFLOW_BLOCKED');
    expect(newBatch?.status).toBe('ready');
    expect(newBatch?.outlineWorkflowVersion).toBe(
      CURRENT_OUTLINE_WORKFLOW_VERSION,
    );
    expect(newBatch?.contextBudgetVersion).toBe(
      V3_HIERARCHICAL_CONTEXT_BUDGET_VERSION,
    );
    expect(newBatch?.contextAutomationPolicyVersion).toBe(
      'context-automation-v3',
    );
    expect(newBatch?.contextAutomationPolicyHash).toBeTruthy();
    expect(newItems).toHaveLength(2);
    expect(newItems[0]).toEqual(
      expect.objectContaining({
        ordinal: 1,
        chapterId: 100,
        status: 'chapter_ready',
        targetWords: 3200,
      }),
    );
    expect(newItems[1]).toEqual(
      expect.objectContaining({ ordinal: 2, chapterId: null, status: 'pending' }),
    );
  });

  it('auto re-drives the batch when a retry becomes due (refresh watchdog)', async () => {
    await resetDb();
    await execute(
      await openDatabase(),
      `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
      [],
    );
    const store = useMultiChapterBatchStore.getState();
    const id = await store.createDraftBatch({
      projectId: 1,
      sourcePrompt: '摘要',
      chapterCount: 1,
      targetWordsPerChapter: 3000,
      pipelineMode: 'full',
    });
    // Chapter failed with safe_retry: item waiting_retry, retry time passed,
    // batch still 'running' with no live coordinator (reconcile handed back
    // after wait_until).
    await execute(
      await openDatabase(),
      `UPDATE multi_chapter_batches SET status = 'running' WHERE id = ?`,
      [id],
    );
    await execute(
      await openDatabase(),
      `UPDATE multi_chapter_batch_items
       SET status = 'waiting_retry', next_retry_at = ?
       WHERE batch_id = ? AND ordinal = 1`,
      [Date.now() - 1000, id],
    );

    await store.loadBatch(id);
    (reconcileMultiChapterBatch as jest.Mock).mockClear();
    await store.refresh();
    // Let the background drive finish.
    await new Promise(r => setTimeout(r, 10));

    // The refresh watchdog must have re-driven the reconciler automatically.
    expect(reconcileMultiChapterBatch).toHaveBeenCalledTimes(1);
    expect(useMultiChapterBatchStore.getState().reconciling).toBe(false);
  });
});
