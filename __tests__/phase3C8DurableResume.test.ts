/* eslint-env jest */

import { execute } from '../src/data/connection/execute';
import {
  openDatabase,
  __resetForTest,
  __setDatabaseForTest,
} from '../src/data/connection/openDatabase';
import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import type { InMemorySqliteDb } from './helpers/canonInMemoryDb';
import { resetFailedStageCheckpointsForResume } from '../src/data/repositories/pipelineStageCheckpointRepository';
import {
  createStageAttempt,
  getLatestStageAttempt,
  markStartedPipelineAttemptsOutcomeUnknown,
  updateStageAttempt,
} from '../src/data/repositories/pipelineStageAttemptRepository';
import { createOutlineDurableAdapter } from '../src/services/writing/persistence/outlineDurableAdapter';
import { usePipelineTaskStore } from '../src/store/pipelineTaskStore';
import {
  ensureContinuationV5StageResults,
  getRunById,
  getStageResult,
  insertRun,
  markRunsInterruptedOnColdStart,
  reserveContinuationStage,
} from '../src/services/continuation/generation/generationRepository';

let testDb: InMemorySqliteDb | null = null;

async function seedTask(
  statuses: Record<string, string>,
  taskId = 'c8-resume-test',
) {
  testDb = await createCanonInMemoryDb();
  __setDatabaseForTest(testDb as any);
  const database = await openDatabase();
  const now = Date.now();
  await execute(
    database,
    `INSERT INTO pipeline_tasks (
       id, target_type, target_id, status, stage_results,
       pipeline_topology_version,
       created_at, updated_at
     ) VALUES (?, 'chapter', 1, 'failed', '[]', 2, ?, ?)`,
    [taskId, now, now],
  );
  for (const [stage, status] of Object.entries(statuses)) {
    await execute(
      database,
      `INSERT INTO pipeline_stage_checkpoints (
         task_id, stage, status, attempt_count, updated_at
       ) VALUES (?, ?, ?, 1, ?)`,
      [taskId, stage, status, now],
    );
  }
  return { database, taskId };
}

async function checkpointRows(taskId: string) {
  const rows = await (await openDatabase()).executeSql(
    `SELECT stage, status, error_code, error_message
       FROM pipeline_stage_checkpoints
      WHERE task_id = ? ORDER BY stage`,
    [taskId],
  );
  return rows[0].rows.raw() as Array<{
    stage: string;
    status: string;
    error_code: string | null;
    error_message: string | null;
  }>;
}

async function seedContinuationRun(input: {
  runId: string;
  topology: 'compact_standard' | 'legacy';
  compactOnly: boolean;
  stage: 'unified_qa' | 'narrative_architect';
  state?: 'running' | 'interrupted';
}) {
  testDb = await createCanonInMemoryDb();
  __setDatabaseForTest(testDb as any);
  const database = await openDatabase();
  const now = new Date().toISOString();
  await execute(
    database,
    `INSERT INTO projects (id, name, mode, created_at, updated_at)
     VALUES (1, 'c8 continuation', 'continuation', ?, ?)`,
    [now, now],
  );
  await execute(
    database,
    `INSERT INTO chapters (
       id, project_id, position, title, synopsis, content, status,
       created_at, updated_at
     ) VALUES (2, 1, 2, '第2章', '续写', '', 'draft', ?, ?)`,
    [now, now],
  );
  await execute(
    database,
    `INSERT INTO llm_config (
       id, name, base_url, api_key, model_name, is_active, provider_type,
       context_window, max_output_tokens
     ) VALUES (7, 'c8', 'http://127.0.0.1:9/v1', 'k', 'm', 1,
       'openai_compatible', 8000, 4000)`,
  );
  await insertRun({
    id: input.runId,
    projectId: 1,
    chapterId: 2,
    targetPosition: 3 as any,
    sourceId: null,
    sourceSnapshotJson: '{}',
    canonSnapshotId: null,
    canonRevision: 1,
    storyMemoryFingerprint: 'fp',
    storyMemoryThroughPosition: 2,
    inputRevisionHash: 'hash',
    userInstruction: '续写本章',
    settingsSnapshotJson: '{}',
    contextSnapshotJson: JSON.stringify({
      workflowVersion: 5,
      frozenWritingContext: {
        stagePolicy: { values: { pipelineTopologyVersion: input.topology } },
      },
    }),
    contextTraceJson: null,
    tokenUsageJson: '{}',
    state: input.state ?? 'running',
    stage: 'round2',
    completionReason: null,
    adoptedRevisionHash: null,
    finalizedRevisionHash: null,
    errorCode: null,
    errorMessage: null,
  });
  const budget = {
    configId: 7,
    compiledPromptTokens: 100,
    minimumOutputTokens: 64,
    maximumOutputTokens: 1024,
  };
  await ensureContinuationV5StageResults({
    runId: input.runId,
    compactOnly: input.compactOnly,
    stages: {
      draft_writer: budget,
      narrative_architect: budget,
      revision_writer: budget,
      adversarial_auditor: budget,
      unified_qa: budget,
      final_reviser: budget,
    },
  });
  await reserveContinuationStage({
    runId: input.runId,
    stage: input.stage,
    modelConfigId: 7,
    inputTokens: 100,
    minOutputTokens: 64,
    maxOutputTokens: 1024,
  });
  return { database, runId: input.runId };
}

afterEach(() => {
  __resetForTest();
  testDb?.close();
  testDb = null;
  usePipelineTaskStore.setState({ tasks: [] });
});

describe('Phase III-C C8 — durable resume', () => {
  test('Compact current topology resets an interrupted/failed qa checkpoint', async () => {
    const { taskId } = await seedTask({
      draft: 'succeeded',
      qa: 'failed',
      brief: 'pending',
    });

    await resetFailedStageCheckpointsForResume(taskId);

    const rows = await checkpointRows(taskId);
    expect(rows.find(row => row.stage === 'draft')?.status).toBe('succeeded');
    expect(rows.find(row => row.stage === 'qa')?.status).toBe('pending');
    expect(rows.find(row => row.stage === 'brief')?.status).toBe('pending');
  });

  test('a durable outcome_unknown attempt is never reset into a replayable checkpoint', async () => {
    const { taskId } = await seedTask({
      draft: 'succeeded',
      brief: 'failed',
      proof: 'pending',
    });
    await createStageAttempt({
      id: 'c8-outcome-unknown-attempt',
      pipelineTaskId: taskId,
      stage: 'brief',
      attemptNo: 1,
      requestFingerprint: 'freeze:brief',
      llmConfigSnapshotJson: '{}',
      clientRequestId: 'c8-client-request',
    });
    await updateStageAttempt({
      id: 'c8-outcome-unknown-attempt',
      status: 'outcome_unknown',
      failureClass: 'outcome_unknown',
      errorCode: 'network_error',
      errorMessage: 'request crossed the provider boundary',
      completedAt: Date.now(),
    });

    await resetFailedStageCheckpointsForResume(taskId);

    const row = (await checkpointRows(taskId)).find(
      item => item.stage === 'brief',
    );
    expect(row?.status).toBe('failed');
    expect(row?.error_code).toBe('OUTCOME_UNKNOWN');
    expect(row?.error_message).toContain('结果未知');
  });

  test('cold start turns an unfinished current-pipeline attempt into a terminal unknown boundary', async () => {
    const { taskId } = await seedTask({
      draft: 'succeeded',
      qa: 'running',
      brief: 'pending',
    });
    await createStageAttempt({
      id: 'c8-cold-start-attempt',
      pipelineTaskId: taskId,
      stage: 'qa',
      attemptNo: 1,
      requestFingerprint: 'freeze:qa',
      llmConfigSnapshotJson: '{}',
      clientRequestId: 'c8-cold-start-client',
    });

    await expect(markStartedPipelineAttemptsOutcomeUnknown()).resolves.toBe(1);

    const attempt = await getLatestStageAttempt(taskId, 'qa');
    const row = (await checkpointRows(taskId)).find(
      item => item.stage === 'qa',
    );
    expect(attempt?.status).toBe('outcome_unknown');
    expect(attempt?.failureClass).toBe('outcome_unknown');
    expect(row?.status).toBe('failed');
    expect(row?.error_code).toBe('OUTCOME_UNKNOWN');
  });

  test('cold-start classification is current compact-pipeline only', async () => {
    const { database, taskId } = await seedTask({
      draft: 'succeeded',
      qa: 'running',
    });
    await createStageAttempt({
      id: 'c8-current-only-attempt',
      pipelineTaskId: taskId,
      stage: 'qa',
      attemptNo: 1,
      requestFingerprint: 'freeze:qa:current',
      llmConfigSnapshotJson: '{}',
      clientRequestId: 'c8-current-only-client',
    });

    const legacyTaskId = 'c8-legacy-task';
    const now = Date.now();
    await execute(
      database,
      `INSERT INTO pipeline_tasks (
         id, target_type, target_id, status, stage_results,
         pipeline_topology_version, created_at, updated_at
       ) VALUES (?, 'chapter', 1, 'failed', '[]', 1, ?, ?)`,
      [legacyTaskId, now, now],
    );
    await execute(
      database,
      `INSERT INTO pipeline_stage_checkpoints (
         task_id, stage, status, attempt_count, updated_at
       ) VALUES (?, 'review', 'running', 1, ?)`,
      [legacyTaskId, now],
    );
    await createStageAttempt({
      id: 'c8-legacy-attempt',
      pipelineTaskId: legacyTaskId,
      stage: 'review',
      attemptNo: 1,
      requestFingerprint: 'freeze:review:legacy',
      llmConfigSnapshotJson: '{}',
      clientRequestId: 'c8-legacy-client',
    });

    await expect(markStartedPipelineAttemptsOutcomeUnknown()).resolves.toBe(1);
    await expect(getLatestStageAttempt(taskId, 'qa')).resolves.toMatchObject({
      status: 'outcome_unknown',
    });
    await expect(getLatestStageAttempt(legacyTaskId, 'review')).resolves.toMatchObject({
      status: 'started',
    });
  });

  test('final persistence is idempotent when the same body already survived restart', async () => {
    const taskId = 'c8-final-persist-test';
    const persistFinalText = jest.fn(async () => {});
    usePipelineTaskStore.setState({
      tasks: [
        {
          id: taskId,
          finalText: 'FINAL-BODY',
          stageResults: [],
        } as any,
      ],
      persistTaskFinalText: persistFinalText,
    } as any);

    const adapter = createOutlineDurableAdapter({
      taskId,
      chapter: {} as any,
    });
    await adapter.persistFinal?.({
      finalValidate: { stage: 'finalValidate', body: 'FINAL-BODY' },
    });

    expect(persistFinalText).not.toHaveBeenCalled();
  });

  test('cold start protects a Compact continuation reservation and blocks resend', async () => {
    const { runId } = await seedContinuationRun({
      runId: 'ct-c8-compact-cold-start',
      topology: 'compact_standard',
      compactOnly: true,
      stage: 'unified_qa',
    });

    await expect(markRunsInterruptedOnColdStart()).resolves.toBeGreaterThanOrEqual(2);

    const stage = await getStageResult(runId, 'unified_qa');
    expect(stage).toMatchObject({
      status: 'interrupted',
      requestReserved: true,
      requestCount: 1,
      errorCode: 'OUTCOME_UNKNOWN',
      errorMessage: expect.stringContaining('结果未知'),
    });
    await expect(getRunById(runId)).resolves.toMatchObject({
      state: 'interrupted',
      errorCode: 'cold_start',
    });

    const resumed = await reserveContinuationStage({
      runId,
      stage: 'unified_qa',
      modelConfigId: 7,
      inputTokens: 100,
      minOutputTokens: 64,
      maxOutputTokens: 1024,
    });
    expect(resumed.reserved).toBe(false);
    expect(resumed.result.status).toBe('interrupted');

    await expect(markRunsInterruptedOnColdStart()).resolves.toBe(0);
  });

  test('cold start does not claim a legacy continuation reservation', async () => {
    const { runId } = await seedContinuationRun({
      runId: 'ct-c8-legacy-cold-start',
      topology: 'legacy',
      compactOnly: false,
      stage: 'narrative_architect',
    });

    await markRunsInterruptedOnColdStart();

    await expect(getStageResult(runId, 'narrative_architect')).resolves.toMatchObject({
      status: 'running',
      requestReserved: true,
      requestCount: 1,
      errorCode: null,
    });
  });

  test('cold start also reconciles a run already marked interrupted by an older build', async () => {
    const { runId } = await seedContinuationRun({
      runId: 'ct-c8-stale-interrupted',
      topology: 'compact_standard',
      compactOnly: true,
      stage: 'unified_qa',
      state: 'interrupted',
    });

    await expect(markRunsInterruptedOnColdStart()).resolves.toBe(1);
    await expect(getStageResult(runId, 'unified_qa')).resolves.toMatchObject({
      status: 'interrupted',
      requestReserved: true,
      requestCount: 1,
      errorCode: 'OUTCOME_UNKNOWN',
    });
  });
});
