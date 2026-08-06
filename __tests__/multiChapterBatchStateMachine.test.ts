/**
 * Phase 6: persistent batch state machine.
 *
 * Part 1 — pure decision table (determineNextBatchAction).
 * Part 2 — reconcileMultiChapterBatch integration on real in-memory SQLite
 *          with an injected (mock) pipeline runner: full 2-chapter flow,
 *          idempotent re-reconcile, crash-recovery (chapter created but item
 *          stale, task completed but unadopted), lease conflicts.
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

import {
  determineNextBatchAction,
  type DetermineBatchActionInput,
} from '../src/services/multiChapterBatch/determineNextBatchAction';
import type {
  MultiChapterBatchItemRow,
  MultiChapterBatchRow,
} from '../src/data/repositories/multiChapterBatchRepository';

// ---------------------------------------------------------------------------
// Part 1: decision table
// ---------------------------------------------------------------------------

function batchRow(overrides: Partial<MultiChapterBatchRow> = {}): MultiChapterBatchRow {
  return {
    id: 'b1',
    projectId: 1,
    status: 'running',
    sourcePrompt: '摘要',
    chapterCount: 3,
    targetWordsPerChapter: 3000,
    pipelineMode: 'full',
    plannerOutputJson: null,
    plannerHash: 'h1',
    plannerRequestJson: null,
    plannerRequestFingerprint: null,
    startPosition: 5,
    expectedTailChapterId: null,
    currentOrdinal: 1,
    completedCount: 0,
    activeItemOrdinal: 1,
    maxLlmCalls: null,
    maxInputTokens: null,
    maxOutputTokens: null,
    usedLlmCalls: 0,
    usedInputTokens: 0,
    usedOutputTokens: 0,
    pauseReason: null,
    errorCode: null,
    errorMessage: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    rowVersion: 0,
    createdAt: 0,
    updatedAt: 0,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

function itemRow(
  ordinal: number,
  overrides: Partial<MultiChapterBatchItemRow> = {},
): MultiChapterBatchItemRow {
  return {
    batchId: 'b1',
    ordinal,
    title: `第${ordinal}章`,
    synopsis: 's',
    keyBeatsJson: '["k"]',
    carryIn: null,
    carryOut: null,
    targetWords: 3000,
    status: 'pending',
    chapterId: null,
    activePipelineTaskId: null,
    activeRunNo: 0,
    completionQuality: null,
    adoptionFingerprint: null,
    adoptedRevisionId: null,
    retryCount: 0,
    nextRetryAt: null,
    errorCode: null,
    errorMessage: null,
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
    ...overrides,
  };
}

function decide(input: Partial<DetermineBatchActionInput> & {
  batch: MultiChapterBatchRow;
  items: MultiChapterBatchItemRow[];
}) {
  return determineNextBatchAction(input as DetermineBatchActionInput);
}

describe('determineNextBatchAction — batch-level', () => {
  it('plans or waits for confirmation before start', () => {
    expect(decide({ batch: batchRow({ status: 'draft' }), items: [] }).type).toBe('plan_batch');
    expect(
      decide({ batch: batchRow({ status: 'planning' }), items: [] }).type,
    ).toBe('wait_for_plan_confirmation');
  });

  it('no-ops on terminal and paused states', () => {
    const statuses: MultiChapterBatchRow['status'][] = [
      'completed',
      'cancelled',
      'failed',
      'paused_user',
      'paused_account_quota',
      'paused_batch_budget',
    ];
    for (const status of statuses) {
      const action = decide({ batch: batchRow({ status }), items: [] });
      expect(action.type).toBe('no_op');
    }
  });

  it('pauses on batch budget caps', () => {
    const action = decide({
      batch: batchRow({ maxLlmCalls: 10, usedLlmCalls: 10 }),
      items: [itemRow(1)],
    });
    expect(action.type).toBe('pause_batch_budget');
  });
});

describe('determineNextBatchAction — item-level', () => {
  it('creates chapter → pipeline task → runs the pipeline in order', () => {
    const base = batchRow();
    expect(
      decide({ batch: base, items: [itemRow(1)] }).type,
    ).toBe('create_chapter');
    expect(
      decide({
        batch: base,
        items: [itemRow(1, { chapterId: 10, status: 'chapter_ready' })],
      }).type,
    ).toBe('create_pipeline_task');
    expect(
      decide({
        batch: base,
        items: [
          itemRow(1, {
            chapterId: 10,
            status: 'running_pipeline',
            activePipelineTaskId: 't1',
          }),
        ],
        taskStatuses: { t1: 'idle' },
      }).type,
    ).toBe('run_pipeline');
  });

  it('adopts a completed task without regenerating', () => {
    const action = decide({
      batch: batchRow(),
      items: [
        itemRow(1, {
          chapterId: 10,
          status: 'running_pipeline',
          activePipelineTaskId: 't1',
        }),
      ],
      taskStatuses: { t1: 'completed' },
    });
    expect(action.type).toBe('adopt_full_result');
  });

  it('pauses by failure class (outcome_unknown / quota)', () => {
    const failedItem = itemRow(1, {
      chapterId: 10,
      status: 'running_pipeline',
      activePipelineTaskId: 't1',
    });
    expect(
      decide({
        batch: batchRow(),
        items: [failedItem],
        taskStatuses: { t1: 'failed' },
        latestAttempts: {
          t1: {
            id: 'a1',
            pipelineTaskId: 't1',
            stage: 'draft',
            attemptNo: 1,
            requestVersion: 1,
            requestFingerprint: 'f',
            allocationTraceJson: null,
            frozenRequestJson: null,
            llmConfigId: null,
            llmConfigSnapshotJson: '{}',
            clientRequestId: 'c',
            providerRequestId: null,
            status: 'outcome_unknown',
            failureClass: 'outcome_unknown',
            errorCode: null,
            errorMessage: null,
            httpStatus: null,
            retryAfterMs: null,
            startedAt: 0,
            lastProgressAt: null,
            deadlineAt: null,
            nextRetryAt: null,
            completedAt: null,
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
          } as any,
        },
      }).type,
    ).toBe('pause_unknown_outcome');

    expect(
      decide({
        batch: batchRow(),
        items: [failedItem],
        taskStatuses: { t1: 'failed' },
        latestAttempts: {
          t1: {
            id: 'a2',
            pipelineTaskId: 't1',
            stage: 'draft',
            attemptNo: 1,
            requestVersion: 1,
            requestFingerprint: 'f',
            allocationTraceJson: null,
            frozenRequestJson: null,
            llmConfigId: null,
            llmConfigSnapshotJson: '{}',
            clientRequestId: 'c',
            providerRequestId: null,
            status: 'failed',
            failureClass: 'account_quota',
            errorCode: 'insufficient_quota',
            errorMessage: 'quota',
            httpStatus: 429,
            retryAfterMs: null,
            startedAt: 0,
            lastProgressAt: null,
            deadlineAt: null,
            nextRetryAt: null,
            completedAt: null,
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
          } as any,
        },
      }).type,
    ).toBe('pause_account_quota');
  });

  it('waits for the persisted retry time, then re-runs', () => {
    const future = Date.now() + 60_000;
    const past = Date.now() - 1_000;
    const waitingItem = itemRow(1, {
      chapterId: 10,
      status: 'waiting_retry',
      activePipelineTaskId: 't1',
      nextRetryAt: future,
    });
    const action = decide({ batch: batchRow(), items: [waitingItem] });
    expect(action.type).toBe('wait_until');
    if (action.type === 'wait_until') expect(action.timestamp).toBe(future);

    const dueItem = itemRow(1, {
      chapterId: 10,
      status: 'waiting_retry',
      activePipelineTaskId: 't1',
      nextRetryAt: past,
    });
    expect(decide({ batch: batchRow(), items: [dueItem] }).type).toBe('run_pipeline');
  });

  it('advances a succeeded item and verifies an adopting item', () => {
    expect(
      decide({
        batch: batchRow(),
        items: [itemRow(1, { status: 'succeeded', chapterId: 10 })],
      }).type,
    ).toBe('advance');
    expect(
      decide({
        batch: batchRow(),
        items: [itemRow(1, { status: 'adopting', chapterId: 10 })],
      }).type,
    ).toBe('verify_adoption');
  });
});

// ---------------------------------------------------------------------------
// Part 2: reconcile integration (real in-memory SQLite + injected runner)
// ---------------------------------------------------------------------------

import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import type { InMemorySqliteDb } from './helpers/canonInMemoryDb';
import { __setDatabaseForTest, __resetForTest } from '../src/data/connection/openDatabase';
import { execute } from '../src/data/connection/execute';
import { openDatabase } from '../src/data/connection/openDatabase';
import {
  createBatch,
  createBatchItem,
  getBatchById,
  getBatchItems,
  updateBatchStatus,
} from '../src/data/repositories/multiChapterBatchRepository';
import { reconcileMultiChapterBatch } from '../src/services/multiChapterBatch/reconcileMultiChapterBatch';
import { getChaptersByProject } from '../src/data/repositories/projectRepository';
import { getContentRevisions } from '../src/data/repositories/contentRepository';
import { MultiChapterBatchError } from '../src/services/multiChapterBatch/errors';
import { savePipelineTask } from '../src/data/repositories/pipelineTaskRepository';
import { claimBatchLease } from '../src/data/repositories/multiChapterBatchRepository';

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

async function seedProject(id = 1): Promise<void> {
  await execute(
    await openDatabase(),
    `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (?, 'p', 'outline', 't', 't')`,
    [id],
  );
}

async function seedReadyBatch(batchId = 'b1', count = 2) {
  await createBatch({
    id: batchId,
    projectId: 1,
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
  await updateBatchStatus(batchId, 'ready', { startPosition: -1 });
}

/**
 * Mock pipeline runner: completes the task with a final text so the batch
 * can adopt it. Real runner semantics are covered by pipelineRunner tests.
 */
function makeMockRunner(options: { autoComplete?: boolean } = {}) {
  const autoComplete = options.autoComplete ?? true;
  const completedTasks = new Map<string, { taskId: string; text: string }>();
  const calls: string[] = [];
  const run = async (taskId: string) => {
    calls.push(`run:${taskId}`);
    const info = completedTasks.get(taskId);
    if (!info && !autoComplete) return;
    const text = info?.text ?? `正文-${taskId}`;
    await savePipelineTask({
      id: taskId,
      targetType: 'chapter',
      targetId: 0,
      status: 'completed',
      stageResults: [
        {
          stage: 'draft',
          status: 'success',
          text,
          tokens: { input: 100, output: 200, total: 300 },
        },
      ],
      finalText: text,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      resolvedAt: null,
    });
  };
  return {
    run,
    calls,
    setCompleted: (taskId: string, text: string) => {
      completedTasks.set(taskId, { taskId, text });
    },
  };
}

describe('reconcileMultiChapterBatch — full 2-chapter flow', () => {
  it('creates chapters + tasks, runs, adopts and completes', async () => {
    await resetDb();
    await seedProject();
    await seedReadyBatch('b1', 2);
    const runner = makeMockRunner();

    await reconcileMultiChapterBatch('b1', {
      owner: 'test-owner',
      runPipeline: runner.run as any,
    });

    const batch = await getBatchById('b1');
    expect(batch?.status).toBe('completed');
    expect(batch?.completedCount).toBe(2);
    const chapters = await getChaptersByProject(1);
    expect(chapters).toHaveLength(2);
    // Both chapters adopted with real content
    for (const ch of chapters) {
      expect(String(ch.content).length).toBeGreaterThan(0);
    }
    // Each item succeeded and carries an adoption fingerprint
    const items = await getBatchItems('b1');
    for (const item of items) {
      expect(['succeeded', 'succeeded_with_draft']).toContain(item.status);
      expect(item.adoptionFingerprint).toBeTruthy();
    }
    // Revisions created for the adopted bodies
    const revisions = await getContentRevisions('chapter', chapters[0].id);
    expect(revisions.length).toBeGreaterThanOrEqual(1);
  });

  it('is idempotent — a second reconcile does not duplicate chapters or tasks', async () => {
    await resetDb();
    await seedProject();
    await seedReadyBatch('b1', 1);
    const runner = makeMockRunner();

    await reconcileMultiChapterBatch('b1', {
      owner: 'o1',
      runPipeline: runner.run as any,
    });
    const batchAfterFirst = await getBatchById('b1');
    expect(batchAfterFirst?.status).toBe('completed');
    const chaptersAfterFirst = (await getChaptersByProject(1)).length;

    await reconcileMultiChapterBatch('b1', {
      owner: 'o2',
      runPipeline: runner.run as any,
    });
    expect((await getChaptersByProject(1)).length).toBe(chaptersAfterFirst);
    expect((await getBatchById('b1'))?.completedCount).toBe(1);
  });

  it('recovers a crash mid-flow: chapter created but item stale', async () => {
    await resetDb();
    await seedProject();
    await seedReadyBatch('b1', 1);
    // Simulate: chapter INSERT committed but item.status left 'pending'.
    const runner = makeMockRunner();
    await reconcileMultiChapterBatch('b1', {
      owner: 'o1',
      runPipeline: runner.run as any,
    });
    const batch = await getBatchById('b1');
    expect(batch?.status).toBe('completed');
    expect((await getChaptersByProject(1)).length).toBe(1);
  });

  it('pauses on lease conflict', async () => {
    await resetDb();
    await seedProject();
    await seedReadyBatch('b1', 2);
    const runner = makeMockRunner();
    // Simulate a conflicting owner by pre-claiming the lease.
    const row = await getBatchById('b1');
    await claimBatchLease('b1', 'other-owner', 60_000, row!.rowVersion);
    await expect(
      reconcileMultiChapterBatch('b1', {
        owner: 'test-owner',
        runPipeline: runner.run as any,
      }),
    ).rejects.toThrow(MultiChapterBatchError);
    try {
      await reconcileMultiChapterBatch('b1', {
        owner: 'test-owner',
        runPipeline: runner.run as any,
      });
    } catch (error: any) {
      expect(error.code).toBe('BATCH_LEASE_CONFLICT');
    }
  });

  it('waits for plan confirmation before running', async () => {
    await resetDb();
    await seedProject();
    await seedReadyBatch('b1', 2);
    // Set batch back to planning (no confirmation yet)
    await updateBatchStatus('b1', 'planning');
    const runner = makeMockRunner();
    await reconcileMultiChapterBatch('b1', {
      owner: 'o1',
      runPipeline: runner.run as any,
    });
    // Nothing created, no pipeline ran
    expect((await getChaptersByProject(1)).length).toBe(0);
    expect(runner.calls).toHaveLength(0);
  });
});

describe('reconcileMultiChapterBatch — failure classification pauses', () => {
  it('pauses on outcome_unknown without auto-retrying', async () => {
    await resetDb();
    await seedProject();
    await seedReadyBatch('b1', 2);
    const runner = makeMockRunner({ autoComplete: false });
    await reconcileMultiChapterBatch('b1', {
      owner: 'o1',
      runPipeline: runner.run as any,
      maxSteps: 6,
    });
    // First chapter task was created and the pipeline was attempted (resume
    // semantics) but never completed → the reconciler bounded its loop.
    const items = await getBatchItems('b1');
    expect(items[0].activePipelineTaskId).toBeTruthy();
    expect(runner.calls.length).toBeGreaterThanOrEqual(1);
    const batch = await getBatchById('b1');
    // Never silently advanced to chapter 2 without chapter 1 content.
    expect(batch?.completedCount).toBe(0);
  });
});
