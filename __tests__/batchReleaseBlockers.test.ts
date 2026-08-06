/**
 * Release-blocker regression tests (audit 2026-08-06).
 *
 * Each test here proves a defect found in the release audit — the test FAILS
 * on the audited HEAD and PASSES after the minimal fix:
 *
 *   RB-1  batch pipelineMode selection never reaches the single-chapter
 *         pipeline execution (UI mode vs real execution mismatch).
 *   RB-2  adoption crash window: an 'adoption_previous' revision written but
 *         chapter content not yet written is short-circuited by the
 *         latestRevision idempotency check → empty chapter body + batch
 *         progress committed anyway.
 *   RB-3  startPosition / expectedTailChapterId are never frozen on the
 *         production path → project-tail drift protection is dead code.
 *   RB-4  batch usage counters only sum successful stageResults, missing
 *         failed / retried LLM requests (pipeline_stage_attempts is the
 *         audit source of truth).
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
import { __setDatabaseForTest, __resetForTest } from '../src/data/connection/openDatabase';
import { execute } from '../src/data/connection/execute';
import { openDatabase } from '../src/data/connection/openDatabase';
import {
  createBatch,
  createBatchItem,
  createPipelineTaskForBatchItem,
  updateBatchStatus,
  updateBatchItem,
  getBatchById,
} from '../src/data/repositories/multiChapterBatchRepository';
import { savePipelineTask } from '../src/data/repositories/pipelineTaskRepository';
import { getChapterById } from '../src/data/repositories/projectRepository';
import { createContentRevision } from '../src/data/repositories/contentRepository';
import { createStageAttempt, updateStageAttempt } from '../src/data/repositories/pipelineStageAttemptRepository';
import { reconcileMultiChapterBatch } from '../src/services/multiChapterBatch/reconcileMultiChapterBatch';
import { useMultiChapterBatchStore } from '../src/store/multiChapterBatchStore';

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

async function seedChapter(
  projectId = 1,
  position = 0,
  content = '',
  title = '第1章',
): Promise<number> {
  const result = await execute(
    await openDatabase(),
    `INSERT INTO chapters (project_id, position, title, synopsis, content, status, created_at, updated_at)
     VALUES (?, ?, ?, '梗概', ?, 'draft', 't', 't')`,
    [projectId, position, title, content],
  );
  return result.insertId;
}

async function seedBatch(batchId = 'b1', count = 1, pipelineMode = 'full') {
  await createBatch({
    id: batchId,
    projectId: 1,
    sourcePrompt: 's',
    chapterCount: count,
    targetWordsPerChapter: 3000,
    pipelineMode,
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
  // Production path marks the batch ready via saveEditedPlan; this helper
  // mimics that (NO manual startPosition — see RB-3).
  await updateBatchStatus(batchId, 'ready');
}

/** Runner that captures the single-chapter pipeline options and completes. */
function capturingRunner() {
  const calls: Array<{ taskId: string; options?: Record<string, unknown> }> = [];
  return {
    run: async (taskId: string, _chapter: unknown, _onStage: unknown, options?: Record<string, unknown>) => {
      calls.push({ taskId, options });
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
            tokens: { input: 10, output: 20, total: 30 },
          },
        ],
        finalText: `正文-${taskId}`,
        error: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        resolvedAt: null,
      });
    },
    calls,
  };
}

// ---------------------------------------------------------------------------
// RB-1: batch pipelineMode must reach the single-chapter execution
// ---------------------------------------------------------------------------
describe('RB-1 batch mode reaches pipeline execution', () => {
  it('passes the batch pipelineMode into the chapter pipeline run options', async () => {
    await resetDb();
    await seedProject();
    await seedBatch('rb1', 1, 'draft_only');
    const runner = capturingRunner();

    await reconcileMultiChapterBatch('rb1', {
      owner: 'test-owner',
      runPipeline: runner.run as any,
      resumePipeline: (async () => {}) as any,
    });

    expect(runner.calls.length).toBe(1);
    // The batch mode selection MUST reach the pipeline execution layer
    // (batch 'draft_only' maps to single-chapter 'noReview').
    expect(runner.calls[0].options?.pipelineModeOverride).toBe('noReview');
  });
});

// ---------------------------------------------------------------------------
// RB-2: adoption crash window — revision written, content not yet written
// ---------------------------------------------------------------------------
describe('RB-2 adoption crash window', () => {
  it('re-adopts and writes the body when only the previous-content revision landed', async () => {
    await resetDb();
    await seedProject();
    const chapterId = await seedChapter(1, 0, '旧正文');

    // Production-shaped batch: item already bound to the chapter + task.
    await createBatch({
      id: 'rb2',
      projectId: 1,
      sourcePrompt: 's',
      chapterCount: 1,
      targetWordsPerChapter: 3000,
      pipelineMode: 'full',
    });
    await updateBatchStatus('rb2', 'ready');
    await createBatchItem({
      batchId: 'rb2',
      ordinal: 1,
      title: '第1章',
      synopsis: 's1',
      keyBeatsJson: '["k"]',
      targetWords: 3000,
    });
    await updateBatchItem('rb2', 1, {
      chapterId,
      status: 'running_pipeline',
    });
    const taskId = `rb2_task_${Date.now()}`;
    await createPipelineTaskForBatchItem({
      batchId: 'rb2',
      ordinal: 1,
      chapterId,
      task: {
        id: taskId,
        targetType: 'chapter',
        targetId: chapterId,
        status: 'completed',
        stageResults: [
          {
            stage: 'draft',
            status: 'success',
            text: '新正文',
            tokens: { input: 1, output: 2, total: 3 },
          },
        ],
        finalText: '新正文',
        error: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        resolvedAt: null,
      },
      stages: ['draft', 'review', 'factCheck', 'proof'],
      runNo: 1,
      llmConfigSnapshotJson: '{}',
      reason: 'batch_start',
    });

    // Crash window: adoptPipelineTaskResult wrote the previous-content
    // revision but the process died BEFORE chapter.content was updated.
    await createContentRevision({
      projectId: 1,
      targetType: 'chapter',
      targetId: chapterId,
      title: '第1章',
      content: '旧正文',
      source: 'adoption_previous',
      sourceRef: taskId,
    });

    await reconcileMultiChapterBatch('rb2', {
      owner: 'test-owner',
      runPipeline: (async () => {}) as any,
      resumePipeline: (async () => {}) as any,
    });

    const chapter = await getChapterById(chapterId);
    // The body MUST land even when the latest revision belongs to this task.
    expect(chapter?.content).toBe('新正文');
    const batch = await getBatchById('rb2');
    expect(batch?.status).toBe('completed');
    expect(batch?.completedCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// RB-3: production path must freeze the project-tail anchor
// ---------------------------------------------------------------------------
describe('RB-3 tail anchor frozen on production path', () => {
  it('freezes startPosition + expectedTailChapterId when the plan is saved', async () => {
    await resetDb();
    await seedProject();
    const tailChapterId = await seedChapter(1, 0, '已有正文', '既有章节');
    await seedBatch('rb3', 2, 'full');

    // Production path: store.saveEditedPlan → updateBatchStatus('ready').
    const store = useMultiChapterBatchStore.getState();
    await store.loadBatch('rb3');
    await store.saveEditedPlan('rb3', [
      {
        ordinal: 1,
        title: '第1章',
        synopsis: 's1',
        keyBeats: ['k1'],
        carryIn: '',
        carryOut: '',
        targetWords: 3000,
      },
      {
        ordinal: 2,
        title: '第2章',
        synopsis: 's2',
        keyBeats: ['k2'],
        carryIn: '',
        carryOut: '',
        targetWords: 3000,
      },
    ]);

    const batch = await getBatchById('rb3');
    expect(batch?.status).toBe('ready');
    // Tail anchor MUST be frozen so drift protection can actually work.
    expect(batch?.startPosition).toBe(0);
    expect(batch?.expectedTailChapterId).toBe(tailChapterId);
  });
});

// ---------------------------------------------------------------------------
// RB-4: batch usage counts every LLM request (attempts), not just successes
// ---------------------------------------------------------------------------
describe('RB-4 batch usage from pipeline_stage_attempts', () => {
  it('counts failed / retried requests into used_llm_calls', async () => {
    await resetDb();
    await seedProject();
    const chapterId = await seedChapter(1, 0, '');

    await createBatch({
      id: 'rb4',
      projectId: 1,
      sourcePrompt: 's',
      chapterCount: 1,
      targetWordsPerChapter: 3000,
      pipelineMode: 'full',
    });
    await updateBatchStatus('rb4', 'ready');
    await createBatchItem({
      batchId: 'rb4',
      ordinal: 1,
      title: '第1章',
      synopsis: 's1',
      keyBeatsJson: '["k"]',
      targetWords: 3000,
    });
    await updateBatchItem('rb4', 1, {
      chapterId,
      status: 'running_pipeline',
    });
    const taskId = `rb4_task_${Date.now()}`;
    await createPipelineTaskForBatchItem({
      batchId: 'rb4',
      ordinal: 1,
      chapterId,
      task: {
        id: taskId,
        targetType: 'chapter',
        targetId: chapterId,
        status: 'completed',
        stageResults: [
          {
            stage: 'draft',
            status: 'success',
            text: '正文',
            tokens: { input: 10, output: 20, total: 30 },
          },
        ],
        finalText: '正文',
        error: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        resolvedAt: null,
      },
      stages: ['draft', 'review', 'factCheck', 'proof'],
      runNo: 1,
      llmConfigSnapshotJson: '{}',
      reason: 'batch_start',
    });

    // Two real LLM requests happened: draft succeeded, review failed.
    // Real path: createStageAttempt('started') → updateStageAttempt(...).
    await createStageAttempt({
      id: `${taskId}:draft:1`,
      pipelineTaskId: taskId,
      stage: 'draft',
      attemptNo: 1,
      requestFingerprint: 'fp1',
      llmConfigSnapshotJson: '{}',
      clientRequestId: `${taskId}:draft:1`,
      startedAt: Date.now() - 1000,
    });
    await updateStageAttempt({
      id: `${taskId}:draft:1`,
      status: 'succeeded',
      completedAt: Date.now(),
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    });
    await createStageAttempt({
      id: `${taskId}:review:1`,
      pipelineTaskId: taskId,
      stage: 'review',
      attemptNo: 1,
      requestFingerprint: 'fp2',
      llmConfigSnapshotJson: '{}',
      clientRequestId: `${taskId}:review:1`,
      startedAt: Date.now() - 500,
    });
    await updateStageAttempt({
      id: `${taskId}:review:1`,
      status: 'failed',
      failureClass: 'safe_retry',
      completedAt: Date.now(),
    });

    await reconcileMultiChapterBatch('rb4', {
      owner: 'test-owner',
      runPipeline: (async () => {}) as any,
      resumePipeline: (async () => {}) as any,
    });

    const batch = await getBatchById('rb4');
    // Both HTTP requests count toward the batch budget, even though one failed.
    expect(batch?.usedLlmCalls).toBe(2);
    expect(batch?.usedInputTokens).toBe(10);
    expect(batch?.usedOutputTokens).toBe(20);
  });
});
