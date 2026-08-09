/**
 * Multi-chapter batch — frozen protocol-version propagation (§4.4).
 *
 * The batch row freezes outlineWorkflowVersion / contextBudgetVersion ONCE
 * at creation (CURRENT = 3 for new batches; migrated legacy batches stay 1).
 * Every chapter task created by the batch state machine must COPY the batch
 * row versions — never re-read the app default mid-batch. A single batch
 * never mixes versions across its child tasks.
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
import {
  __setDatabaseForTest,
  __resetForTest,
} from '../src/data/connection/openDatabase';
import { execute } from '../src/data/connection/execute';
import { openDatabase } from '../src/data/connection/openDatabase';
import { all } from '../src/data/connection/query';
import {
  createBatch,
  createBatchItem,
  getBatchById,
  updateBatchStatus,
} from '../src/data/repositories/multiChapterBatchRepository';
import { savePipelineTask } from '../src/data/repositories/pipelineTaskRepository';
import { reconcileMultiChapterBatch } from '../src/services/multiChapterBatch/reconcileMultiChapterBatch';
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

/** Runner that completes every task it is handed (task row + memory). */
function completingRunner() {
  const calls: string[] = [];
  return {
    run: async (taskId: string) => {
      calls.push(taskId);
      // Production runner persists through the task store which propagates
      // the frozen versions; the mock must preserve the row's version
      // columns instead of overwriting them with the default.
      const existing = await all(
        `SELECT outline_workflow_version AS o, context_budget_version AS b
         FROM pipeline_tasks WHERE id = ?`,
        [taskId],
      );
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
        outlineWorkflowVersion: Number(existing[0]?.o ?? 1),
        contextBudgetVersion: Number(existing[0]?.b ?? 1),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        resolvedAt: null,
      });
    },
    calls,
  };
}

async function seedProject(): Promise<void> {
  await execute(
    await openDatabase(),
    `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
  );
}

async function seedBatch(
  batchId: string,
  count: number,
  versions?: { outlineWorkflowVersion?: number; contextBudgetVersion?: number },
): Promise<void> {
  await createBatch({
    id: batchId,
    projectId: 1,
    sourcePrompt: 's',
    chapterCount: count,
    targetWordsPerChapter: 3000,
    pipelineMode: 'full',
    // New batches freeze the CURRENT versions explicitly; legacy fixtures
    // may override to simulate pre-upgrade rows.
    outlineWorkflowVersion: versions?.outlineWorkflowVersion,
    contextBudgetVersion: versions?.contextBudgetVersion,
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

async function pipelineTaskVersions(): Promise<
  Array<{ outline: number; budget: number }>
> {
  const rows = await all(
    `SELECT outline_workflow_version AS o, context_budget_version AS b FROM pipeline_tasks ORDER BY rowid`,
  );
  return rows.map(r => ({ outline: Number(r.o), budget: Number(r.b) }));
}

describe('multi-chapter batch workflow version freeze (§4.4)', () => {
  jest.setTimeout(60_000);

  it('new batch freezes CURRENT versions (3) and every child task copies them', async () => {
    await resetDb();
    await seedProject();
    await seedBatch('b-new', 3);
    const batch = await getBatchById('b-new');
    expect(batch?.outlineWorkflowVersion).toBe(
      CURRENT_OUTLINE_WORKFLOW_VERSION,
    );
    expect(batch?.contextBudgetVersion).toBe(CURRENT_CONTEXT_BUDGET_VERSION);

    const runner = completingRunner();
    await reconcileMultiChapterBatch('b-new', {
      owner: 'o1',
      runPipeline: runner.run as any,
    });

    expect(runner.calls.length).toBe(3);
    const versions = await pipelineTaskVersions();
    expect(versions.length).toBe(3);
    for (const v of versions) {
      expect(v.outline).toBe(3);
      expect(v.budget).toBe(3);
    }
  });

  it('legacy batch (migrated version 1) keeps ALL child tasks at V1', async () => {
    await resetDb();
    await seedProject();
    await seedBatch('b-legacy', 2, {
      outlineWorkflowVersion: 1,
      contextBudgetVersion: 1,
    });
    const batch = await getBatchById('b-legacy');
    expect(batch?.outlineWorkflowVersion).toBe(1);
    expect(batch?.contextBudgetVersion).toBe(1);

    const runner = completingRunner();
    await reconcileMultiChapterBatch('b-legacy', {
      owner: 'o1',
      runPipeline: runner.run as any,
    });

    const versions = await pipelineTaskVersions();
    expect(versions.length).toBe(2);
    for (const v of versions) {
      expect(v.outline).toBe(1);
      expect(v.budget).toBe(1);
    }
  });

  it('mixed batch versions never happen: children always match the frozen row', async () => {
    // Simulate a partial legacy batch that already ran chapter 1 (V1 task),
    // then verify remaining chapters STILL get V1 — the app default (2)
    // must never leak into an existing batch.
    await resetDb();
    await seedProject();
    await seedBatch('b-mixed', 2, {
      outlineWorkflowVersion: 1,
      contextBudgetVersion: 1,
    });
    // Simulate chapter 1 already completed under V1.
    await savePipelineTask({
      id: 'legacy-task-1',
      targetType: 'chapter',
      targetId: 100,
      status: 'completed',
      stageResults: [],
      finalText: '旧正文',
      error: null,
      outlineWorkflowVersion: 1,
      contextBudgetVersion: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      resolvedAt: null,
    });

    const runner = completingRunner();
    await reconcileMultiChapterBatch('b-mixed', {
      owner: 'o1',
      runPipeline: runner.run as any,
    });

    const versions = await pipelineTaskVersions();
    for (const v of versions) {
      expect(v.outline).toBe(1);
      expect(v.budget).toBe(1);
    }
  });
});
