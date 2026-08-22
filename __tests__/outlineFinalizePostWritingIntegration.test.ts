jest.mock('../src/services/continuation/generation/continuationStateOutboxWorker', () => ({
  processContinuationOutbox: jest.fn(async () => ({ processed: 0, failed: 0 })),
}));

import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import type { InMemorySqliteDb } from './helpers/canonInMemoryDb';
import {
  __resetForTest,
  __setDatabaseForTest,
  openDatabase,
} from '../src/data/connection/openDatabase';
import { execute } from '../src/data/connection/execute';
import { one } from '../src/data/connection/query';
import { savePipelineTask } from '../src/data/repositories/pipelineTaskRepository';
import { getOutboxByDedupe } from '../src/services/continuation/generation/generationRepository';
import { finalizeChapterMemory } from '../src/services/storyMemory/storyMemoryService';
import { buildWritingKernelFreezeTrace } from '../src/services/writing/unifiedWritingKernel';
import { emptyWritingChapterObservability } from '../src/services/writing/observability/writingChapterObservability';
import { outlineRequest } from './helpers/oneShotFixtures';
import { sha256Hex } from '../src/services/continuation/hashUtils';

const PROJECT_ID = 1;
const CHAPTER_ID = 201;
const TASK_ID = 'outline-finalize-task';
const BODY = '编辑器定稿后的 Outline 正文。';

let testDb: InMemorySqliteDb | null = null;

async function seed(): Promise<void> {
  await execute(
    await openDatabase(),
    `INSERT INTO projects (id, name, mode, created_at, updated_at)
     VALUES (?, 'outline-finalize', 'outline', 't', 't')`,
    [PROJECT_ID],
  );
  await execute(
    await openDatabase(),
    `INSERT INTO chapters (
       id, project_id, position, title, synopsis, content, status,
       created_at, updated_at
     ) VALUES (?, ?, 0, '第一章', '', ?, 'draft', 't', 't')`,
    [CHAPTER_ID, PROJECT_ID, BODY],
  );

  const kernel = buildWritingKernelFreezeTrace({
    request: outlineRequest({ pipelineTopologyVersion: 'compact_standard' }),
  });
  const trace = {
    ...kernel.trace,
    observability: emptyWritingChapterObservability({
      generationTraceId: kernel.trace.generationTraceId,
      freezeFingerprint: kernel.trace.freezeFingerprint,
      scenario: 'outline',
      executionProfile: 'standard',
    }),
  };
  const contextJson = JSON.stringify({
    version: 4,
    draftContext: {
      frozenWritingContext: kernel.frozenContext,
      writingKernelTrace: trace,
    },
  });
  await savePipelineTask({
    id: TASK_ID,
    targetType: 'chapter',
    targetId: CHAPTER_ID,
    status: 'completed',
    stageResults: [],
    finalText: BODY,
    error: null,
    pipelineContextJson: contextJson,
    pipelineContextVersion: 4,
    pipelineContextHash: sha256Hex(contextJson).slice(0, 32),
    pipelineTopologyVersion: 2,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    resolvedAt: null,
  });
  await execute(
    await openDatabase(),
    `INSERT INTO content_revisions (
       project_id, target_type, target_id, title, content, source, source_ref, created_at
     ) VALUES (?, 'chapter', ?, '第一章', ?, 'pipeline', ?, 't')`,
    [PROJECT_ID, CHAPTER_ID, BODY, TASK_ID],
  );
}

describe('Outline finalize → PostWriting → ONE Memory', () => {
  beforeEach(async () => {
    __resetForTest();
    testDb = await createCanonInMemoryDb();
    __setDatabaseForTest(testDb as any);
    await seed();
  });

  afterEach(() => {
    __resetForTest();
    testDb?.close();
    testDb = null;
  });

  test('finalize creates one durable event/outbox and closes the task trace', async () => {
    await finalizeChapterMemory(CHAPTER_ID);

    const chapter = await one<{ status: string; finalized_at: string | null }>(
      'SELECT status, finalized_at FROM chapters WHERE id = ?',
      [CHAPTER_ID],
    );
    expect(chapter?.status).toBe('final');
    expect(chapter?.finalized_at).toBeTruthy();

    const outbox = await one<{
      operation: string;
      dedupe_key: string;
      payload_json: string;
      state: string;
    }>(
      `SELECT operation, dedupe_key, payload_json, state
         FROM continuation_state_sync_outbox
        WHERE project_id = ?`,
      [PROJECT_ID],
    );
    expect(outbox?.operation).toBe('rebuild_story_memory');
    expect(outbox?.dedupe_key).toContain('rebuild_story_memory:outline:1:201:');
    expect(JSON.parse(String(outbox?.payload_json)).writingPersistedEvent).toMatchObject({
      scenario: 'outline',
      projectId: PROJECT_ID,
      chapterId: CHAPTER_ID,
      finalBodyFingerprint: sha256Hex(BODY),
    });
    expect(outbox?.state).toBe('pending');

    const task = await one<{ pipeline_context_json: string }>(
      'SELECT pipeline_context_json FROM pipeline_tasks WHERE id = ?',
      [TASK_ID],
    );
    const trace = JSON.parse(String(task?.pipeline_context_json)).draftContext
      .writingKernelTrace;
    expect(trace.writingPersistedEvent).toMatchObject({
      scenario: 'outline',
      chapterId: CHAPTER_ID,
      finalBodyFingerprint: sha256Hex(BODY),
      generationTraceId: trace.generationTraceId,
      freezeFingerprint: trace.freezeFingerprint,
    });
    expect(
      trace.events.filter(
        (event: { stage: string; status: string }) =>
          event.stage === 'postWritingUpdate' && event.status === 'completed',
      ),
    ).toHaveLength(1);
  });

  test('re-finalize is idempotent for the same body', async () => {
    await finalizeChapterMemory(CHAPTER_ID);
    const first = await one<{ dedupe_key: string; id: string }>(
      'SELECT id, dedupe_key FROM continuation_state_sync_outbox WHERE project_id = ?',
      [PROJECT_ID],
    );

    await finalizeChapterMemory(CHAPTER_ID);
    const second = await one<{ dedupe_key: string; id: string }>(
      'SELECT id, dedupe_key FROM continuation_state_sync_outbox WHERE project_id = ?',
      [PROJECT_ID],
    );
    expect(second).toEqual(first);
    await expect(getOutboxByDedupe(String(first?.dedupe_key))).resolves.toMatchObject({
      id: first?.id,
    });
  });
});
