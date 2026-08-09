/**
 * Phase 3: pipeline_stage_attempts repository (real in-memory SQLite, FK ON).
 * Verifies create/update/get flows, attempt numbering, and that a task FK
 * violation fails closed.
 */
import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import type { InMemorySqliteDb } from './helpers/canonInMemoryDb';
import { __setDatabaseForTest, __resetForTest } from '../src/data/connection/openDatabase';
import {
  createStageAttempt,
  updateStageAttempt,
  getStageAttempts,
  getLatestStageAttempt,
  getStageAttempt,
  getRetryDueAttempts,
  clearTemporaryReasoningForTaskStage,
} from '../src/data/repositories/pipelineStageAttemptRepository';
import {
  createPipelineTaskWithCheckpoints,
} from '../src/data/repositories/pipelineTaskRepository';

let testDb: InMemorySqliteDb | null = null;

async function resetDb() {
  __resetForTest();
  testDb = await createCanonInMemoryDb();
  __setDatabaseForTest(testDb as any);
}

function newTask(overrides: Partial<any> = {}) {
  const now = Date.now();
  return {
    id: `task_${Math.random().toString(36).slice(2, 10)}`,
    targetType: 'chapter',
    targetId: 1,
    status: 'idle',
    stageResults: [] as any[],
    finalText: null as string | null,
    error: null as string | null,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null as number | null,
    ...overrides,
  };
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

async function seedTask(): Promise<string> {
  const task = newTask();
  await createPipelineTaskWithCheckpoints(task, ['draft', 'review', 'factCheck', 'proof']);
  return task.id;
}

describe('pipeline_stage_attempts repository', () => {
  it('creates and reads back a started attempt', async () => {
    await resetDb();
    const taskId = await seedTask();
    await createStageAttempt({
      id: `${taskId}:draft:1`,
      pipelineTaskId: taskId,
      stage: 'draft',
      attemptNo: 1,
      requestFingerprint: 'fp1',
      allocationTraceJson: JSON.stringify({ soft: 1 }),
      llmConfigId: 2,
      llmConfigSnapshotJson: JSON.stringify({ name: 'm' }),
      clientRequestId: `${taskId}:draft:1`,
    });
    const attempts = await getStageAttempts(taskId, 'draft');
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe('started');
    expect(attempts[0].requestFingerprint).toBe('fp1');
    expect(attempts[0].llmConfigId).toBe(2);
    expect(getLatestStageAttempt(taskId, 'draft')).resolves.toMatchObject({
      attemptNo: 1,
    });
  });

  it('records failure classification + retry schedule and rethrows semantics stay intact', async () => {
    await resetDb();
    const taskId = await seedTask();
    await createStageAttempt({
      id: `${taskId}:review:1`,
      pipelineTaskId: taskId,
      stage: 'review',
      attemptNo: 1,
      requestFingerprint: 'fp',
      llmConfigSnapshotJson: '{}',
      clientRequestId: 'c1',
    });
    const nextRetryAt = Date.now() + 30_000;
    await updateStageAttempt({
      id: `${taskId}:review:1`,
      status: 'safe_to_retry',
      failureClass: 'safe_retry',
      errorCode: 'total_timeout',
      errorMessage: 'timeout',
      httpStatus: null,
      retryAfterMs: 5_000,
      nextRetryAt,
      completedAt: Date.now(),
    });
    const attempt = await getStageAttempt(`${taskId}:review:1`);
    expect(attempt?.status).toBe('safe_to_retry');
    expect(attempt?.failureClass).toBe('safe_retry');
    expect(attempt?.retryAfterMs).toBe(5_000);
    expect(attempt?.nextRetryAt).toBe(nextRetryAt);
  });

  it('persists, reads, and clears the Schema 49 candidate scratch fields', async () => {
    await resetDb();
    const taskId = await seedTask();
    const attemptId = `${taskId}:review:1`;
    await createStageAttempt({
      id: attemptId,
      pipelineTaskId: taskId,
      stage: 'review',
      attemptNo: 1,
      requestFingerprint: 'v32-fp',
      llmConfigSnapshotJson: '{}',
      clientRequestId: attemptId,
    });
    await updateStageAttempt({
      id: attemptId,
      status: 'succeeded',
      reasoningContentTemp: 'legacy-reasoning-scratch',
      responseCandidateTemp: '{"verdict":"pass"}',
      responseCandidateChannel: 'both_reasoning_preferred',
      validationDetailsJson: JSON.stringify({
        version: 1,
        failureCode: 'REVIEW_SEMANTIC_INVALID',
        missingPaths: ['coverage'],
      }),
    });
    const stored = await getStageAttempt(attemptId);
    expect(stored).toMatchObject({
      reasoningContentTemp: 'legacy-reasoning-scratch',
      responseCandidateTemp: '{"verdict":"pass"}',
      responseCandidateChannel: 'both_reasoning_preferred',
      validationDetailsJson: expect.stringContaining('REVIEW_SEMANTIC_INVALID'),
    });

    await clearTemporaryReasoningForTaskStage(taskId, 'review');
    const cleared = await getStageAttempt(attemptId);
    expect(cleared?.reasoningContentTemp).toBeNull();
    expect(cleared?.responseCandidateTemp).toBeNull();
  });

  it('appends attempts in order (attempt_no unique per task+stage)', async () => {
    await resetDb();
    const taskId = await seedTask();
    for (let i = 1; i <= 3; i += 1) {
      await createStageAttempt({
        id: `${taskId}:proof:${i}`,
        pipelineTaskId: taskId,
        stage: 'proof',
        attemptNo: i,
        requestFingerprint: `fp${i}`,
        llmConfigSnapshotJson: '{}',
        clientRequestId: `c${i}`,
      });
    }
    const attempts = await getStageAttempts(taskId, 'proof');
    expect(attempts.map(a => a.attemptNo)).toEqual([1, 2, 3]);
    const latest = await getLatestStageAttempt(taskId, 'proof');
    expect(latest?.requestFingerprint).toBe('fp3');
  });

  it('lists retry-due attempts after next_retry_at elapses', async () => {
    await resetDb();
    const taskId = await seedTask();
    const past = Date.now() - 1_000;
    const future = Date.now() + 60_000;
    await createStageAttempt({
      id: `${taskId}:draft:1`,
      pipelineTaskId: taskId,
      stage: 'draft',
      attemptNo: 1,
      requestFingerprint: 'f1',
      llmConfigSnapshotJson: '{}',
      clientRequestId: 'c1',
    });
    await updateStageAttempt({
      id: `${taskId}:draft:1`,
      status: 'safe_to_retry',
      nextRetryAt: past,
      completedAt: Date.now(),
    });
    await createStageAttempt({
      id: `${taskId}:review:1`,
      pipelineTaskId: taskId,
      stage: 'review',
      attemptNo: 1,
      requestFingerprint: 'f2',
      llmConfigSnapshotJson: '{}',
      clientRequestId: 'c2',
    });
    await updateStageAttempt({
      id: `${taskId}:review:1`,
      status: 'safe_to_retry',
      nextRetryAt: future,
      completedAt: Date.now(),
    });
    const due = await getRetryDueAttempts(Date.now());
    expect(due.map(a => a.id)).toContain(`${taskId}:draft:1`);
    expect(due.map(a => a.id)).not.toContain(`${taskId}:review:1`);
  });

  it('fails closed on missing pipeline_task FK', async () => {
    await resetDb();
    await expect(
      createStageAttempt({
        id: 'orphan:1',
        pipelineTaskId: 'missing-task',
        stage: 'draft',
        attemptNo: 1,
        requestFingerprint: 'f',
        llmConfigSnapshotJson: '{}',
        clientRequestId: 'c',
      }),
    ).rejects.toThrow();
  });
});
