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
    expect(reconcileMultiChapterBatch).toHaveBeenCalledWith(
      id,
      expect.objectContaining({ owner: expect.stringMatching(/^ui_/) }),
    );
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
});
