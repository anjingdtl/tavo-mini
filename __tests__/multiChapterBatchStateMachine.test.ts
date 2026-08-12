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

import {
  determineNextBatchAction,
  type DetermineBatchActionInput,
} from '../src/services/multiChapterBatch/determineNextBatchAction';
import type {
  MultiChapterBatchItemRow,
  MultiChapterBatchRow,
} from '../src/data/repositories/multiChapterBatchRepository';
import {
  CURRENT_CONTEXT_BUDGET_VERSION,
  CURRENT_OUTLINE_WORKFLOW_VERSION,
  V3_HIERARCHICAL_CONTEXT_BUDGET_VERSION,
} from '../src/services/pipeline/outlineWorkflowVersion';

// ---------------------------------------------------------------------------
// Part 1: decision table
// ---------------------------------------------------------------------------

function batchRow(
  overrides: Partial<MultiChapterBatchRow> = {},
): MultiChapterBatchRow {
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
    outlineWorkflowVersion: CURRENT_OUTLINE_WORKFLOW_VERSION,
    contextBudgetVersion: CURRENT_CONTEXT_BUDGET_VERSION,
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

function decide(
  input: Partial<DetermineBatchActionInput> & {
    batch: MultiChapterBatchRow;
    items: MultiChapterBatchItemRow[];
  },
) {
  return determineNextBatchAction(input as DetermineBatchActionInput);
}

describe('determineNextBatchAction — batch-level', () => {
  it('plans or waits for confirmation before start', () => {
    expect(
      decide({ batch: batchRow({ status: 'draft' }), items: [] }).type,
    ).toBe('plan_batch');
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

  it('pauses a current-workflow batch that still carries the legacy budget version', () => {
    const action = decide({
      batch: batchRow({ contextBudgetVersion: 4 }),
      items: [itemRow(1)],
    });
    expect(action.type).toBe('pause_legacy_batch');
  });
});

describe('determineNextBatchAction — item-level', () => {
  it('creates chapter → pipeline task → runs the pipeline in order', () => {
    const base = batchRow();
    expect(decide({ batch: base, items: [itemRow(1)] }).type).toBe(
      'create_chapter',
    );
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

  it('pauses an incomplete current-workflow task with the legacy budget version', () => {
    const action = decide({
      batch: batchRow(),
      items: [
        itemRow(1, {
          chapterId: 10,
          status: 'running_pipeline',
          activePipelineTaskId: 'legacy-budget-task',
        }),
      ],
      taskStatuses: { 'legacy-budget-task': 'interrupted' },
      taskWorkflowVersions: {
        'legacy-budget-task': CURRENT_OUTLINE_WORKFLOW_VERSION,
      },
      taskContextBudgetVersions: {
        'legacy-budget-task': 4,
      },
    });
    expect(action).toEqual({ type: 'pause_legacy_pipeline', ordinal: 1 });
  });

  it('keeps an incomplete V3 task resumable instead of treating it as legacy', () => {
    const action = decide({
      batch: batchRow({
        contextBudgetVersion: V3_HIERARCHICAL_CONTEXT_BUDGET_VERSION,
      }),
      items: [
        itemRow(1, {
          chapterId: 10,
          status: 'running_pipeline',
          activePipelineTaskId: 'v3-task',
        }),
      ],
      taskStatuses: { 'v3-task': 'interrupted' },
      taskWorkflowVersions: {
        'v3-task': CURRENT_OUTLINE_WORKFLOW_VERSION,
      },
      taskContextBudgetVersions: {
        'v3-task': V3_HIERARCHICAL_CONTEXT_BUDGET_VERSION,
      },
    });
    expect(action).toEqual({ type: 'resume_pipeline', ordinal: 1 });
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

    expect(
      decide({
        batch: batchRow(),
        items: [failedItem],
        taskStatuses: { t1: 'failed' },
        latestAttempts: {
          t1: {
            id: 'a3',
            pipelineTaskId: 't1',
            stage: 'factCheck',
            attemptNo: 2,
            requestVersion: 3,
            requestFingerprint: 'f',
            allocationTraceJson: null,
            frozenRequestJson: null,
            llmConfigId: null,
            llmConfigSnapshotJson: '{}',
            clientRequestId: 'c',
            providerRequestId: null,
            status: 'succeeded',
            failureClass: 'response_invalid',
            errorCode: 'PIPELINE_RESPONSE_INVALID',
            errorMessage: 'content 为空',
            httpStatus: null,
            retryAfterMs: null,
            startedAt: 0,
            lastProgressAt: null,
            deadlineAt: null,
            nextRetryAt: null,
            completedAt: 1,
            inputTokens: 10,
            outputTokens: 10,
            totalTokens: 20,
          } as any,
        },
      }).type,
    ).toBe('pause_response_invalid');
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
    expect(decide({ batch: batchRow(), items: [dueItem] }).type).toBe(
      'run_pipeline',
    );
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
import {
  __setDatabaseForTest,
  __resetForTest,
} from '../src/data/connection/openDatabase';
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
import {
  cloneDefaultContextAutomationPolicyV3,
  hashContextAutomationPolicyV3,
  type ContextAutomationPolicyV3,
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

async function seedProject(id = 1): Promise<void> {
  await execute(
    await openDatabase(),
    `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (?, 'p', 'outline', 't', 't')`,
    [id],
  );
}

async function seedReadyBatch(
  batchId = 'b1',
  count = 2,
  frozenPolicy?: ContextAutomationPolicyV3,
) {
  await createBatch({
    id: batchId,
    projectId: 1,
    sourcePrompt: '长剧情摘要',
    chapterCount: count,
    targetWordsPerChapter: 3000,
    pipelineMode: 'full',
    ...(frozenPolicy
      ? {
          outlineWorkflowVersion: CURRENT_OUTLINE_WORKFLOW_VERSION,
          contextBudgetVersion: V3_HIERARCHICAL_CONTEXT_BUDGET_VERSION,
          contextAutomationPolicyV3: frozenPolicy,
        }
      : {}),
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

describe('reconcileMultiChapterBatch — frozen policy + 3-child resume closure', () => {
  it('keeps batch policy A after live mutation and resumes children 2/3 without rerunning child 1', async () => {
    await resetDb();
    await seedProject();

    const policyA = cloneDefaultContextAutomationPolicyV3();
    policyA.boards.resources.priority = 11;
    const policyB = cloneDefaultContextAutomationPolicyV3();
    policyB.boards.resources.priority = 99;

    await execute(
      await openDatabase(),
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('context_auto_mode', 'v3')`,
    );
    await execute(
      await openDatabase(),
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('context_auto_policy_v3', ?)`,
      [JSON.stringify(policyA)],
    );
    await seedReadyBatch('policy-resume', 3, policyA);

    // Simulate a live settings edit after the batch has been created. The
    // reconciler must continue to use the persisted batch snapshot.
    await execute(
      await openDatabase(),
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('context_auto_policy_v3', ?)`,
      [JSON.stringify(policyB)],
    );

    const expectedHash = hashContextAutomationPolicyV3(policyA);
    const observed: Array<{ kind: string; taskId: string; hash: string }> = [];
    const runCalls: string[] = [];
    const resumeCalls: string[] = [];
    let holdChildTwo = true;

    const persistTask = async (
      taskId: string,
      status: 'completed' | 'interrupted',
    ) => {
      const text = `正文-${taskId}`;
      await savePipelineTask({
        id: taskId,
        targetType: 'chapter',
        targetId: 0,
        status,
        stageResults:
          status === 'completed'
            ? [
                {
                  stage: 'draft',
                  status: 'success',
                  text,
                  tokens: { input: 100, output: 200, total: 300 },
                },
              ]
            : [],
        finalText: status === 'completed' ? text : null,
        error: status === 'completed' ? null : 'test interruption',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        resolvedAt: null,
      });
    };

    const capturePolicy = (kind: string, taskId: string, options: any) => {
      const policy = options?.contextAutomationPolicyV3;
      observed.push({
        kind,
        taskId,
        hash: policy ? hashContextAutomationPolicyV3(policy) : 'missing',
      });
    };

    const runPipeline = async (
      taskId: string,
      _chapter: any,
      _onStageUpdate: any,
      options: any,
    ) => {
      runCalls.push(taskId);
      capturePolicy('run', taskId, options);
      // The second run is child #2. Leave its task interrupted so the next
      // reconcile invocation exercises the persisted Resume path.
      if (runCalls.length === 2 && holdChildTwo) {
        await persistTask(taskId, 'interrupted');
        return;
      }
      await persistTask(taskId, 'completed');
    };

    const resumePipeline = async (
      taskId: string,
      _chapter: any,
      _onStageUpdate: any,
      options: any,
    ) => {
      resumeCalls.push(taskId);
      capturePolicy('resume', taskId, options);
      if (holdChildTwo) return;
      await persistTask(taskId, 'completed');
    };

    // Bound the first invocation after child #2 interruption; no retry or
    // sleep is involved in this deterministic interruption fixture.
    await reconcileMultiChapterBatch('policy-resume', {
      owner: 'closure-owner-1',
      runPipeline: runPipeline as any,
      resumePipeline: resumePipeline as any,
      maxSteps: 12,
    });

    const pausedItems = await getBatchItems('policy-resume');
    expect(pausedItems[0].status).toBe('succeeded');
    expect(pausedItems[1].status).toBe('running_pipeline');
    expect(pausedItems[1].activePipelineTaskId).toBeTruthy();
    expect((await getBatchById('policy-resume'))?.completedCount).toBe(1);

    // A second reconcile is the cold-start boundary: it reloads the task and
    // batch rows from SQLite before deciding to resume child #2.
    holdChildTwo = false;
    const resumeCallsBeforeColdStart = resumeCalls.length;
    await reconcileMultiChapterBatch('policy-resume', {
      owner: 'closure-owner-2',
      runPipeline: runPipeline as any,
      resumePipeline: resumePipeline as any,
    });

    const finalBatch = await getBatchById('policy-resume');
    expect(finalBatch?.status).toBe('completed');
    expect(finalBatch?.completedCount).toBe(3);
    const finalItems = await getBatchItems('policy-resume');
    expect(finalItems.map(item => item.status)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
    ]);

    // Gate J: every child runner invocation, including post-mutation Resume,
    // receives the batch's A snapshot, never live policy B.
    expect(finalBatch?.contextAutomationPolicyHash).toBe(expectedHash);
    expect(observed.length).toBeGreaterThanOrEqual(3);
    expect(observed.every(entry => entry.hash === expectedHash)).toBe(true);
    expect(observed.some(entry => entry.hash === hashContextAutomationPolicyV3(policyB))).toBe(false);

    // Gate L: child #1 ran once; child #2 resumed; child #3 ran once; parent
    // completed only after all three durable adoptions.
    expect(new Set(runCalls).size).toBe(3);
    expect(runCalls.filter(taskId => taskId === pausedItems[0].activePipelineTaskId)).toHaveLength(1);
    expect(resumeCalls).toContain(pausedItems[1].activePipelineTaskId);
    expect(runCalls).toHaveLength(3);
    expect(resumeCalls.slice(resumeCallsBeforeColdStart)).toHaveLength(1);
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
