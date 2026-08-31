/**
 * P0-2: after a user revision (body A → B) the ONE existing PostWriting
 * closure must accept the revision-advanced body: a NEW fingerprint-keyed
 * outbox row describes body B, while the frozen Kernel trace keeps body A's
 * immutable persisted event. Duplicate finalize for the same body stays
 * idempotent, and without the revision-advanced opt-in the drift guard still
 * fails closed.
 */
import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import type { InMemorySqliteDb } from './helpers/canonInMemoryDb';
import {
  __resetForTest,
  __setDatabaseForTest,
  openDatabase,
} from '../src/data/connection/openDatabase';
import { execute } from '../src/data/connection/execute';
import { all, one } from '../src/data/connection/query';
import { savePipelineTask } from '../src/data/repositories/pipelineTaskRepository';
import { finalizeChapterMemory } from '../src/services/storyMemory/storyMemoryService';
import { buildWritingKernelFreezeTrace } from '../src/services/writing/unifiedWritingKernel';
import { emptyWritingChapterObservability } from '../src/services/writing/observability/writingChapterObservability';
import { outlineRequest } from './helpers/oneShotFixtures';
import { sha256Hex } from '../src/services/continuation/hashUtils';

const PROJECT_ID = 1;
const CHAPTER_ID = 201;
const TASK_ID = 'revision-advanced-task';
const BODY_A = '修订前的原稿正文。';
const BODY_B = '用户精准修订后的新正文，事实保持一致。';

let testDb: InMemorySqliteDb | null = null;

async function seed(): Promise<void> {
  await execute(
    await openDatabase(),
    `INSERT INTO projects (id, name, mode, created_at, updated_at)
     VALUES (?, 'revision-advanced', 'outline', 't', 't')`,
    [PROJECT_ID],
  );
  await execute(
    await openDatabase(),
    `INSERT INTO chapters (
       id, project_id, position, title, synopsis, content, status,
       created_at, updated_at
     ) VALUES (?, ?, 0, '第一章', '', ?, 'final', 't', 't')`,
    [CHAPTER_ID, PROJECT_ID, BODY_A],
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
    finalText: BODY_A,
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
    [PROJECT_ID, CHAPTER_ID, BODY_A, TASK_ID],
  );
}

async function closeOriginalBody(): Promise<void> {
  await finalizeChapterMemory(CHAPTER_ID);
}

async function listOutbox(): Promise<
  Array<{ id: string; dedupe_key: string; payload_json: string }>
> {
  return await all(
    `SELECT id, dedupe_key, payload_json FROM continuation_state_sync_outbox
      WHERE project_id = ? ORDER BY dedupe_key`,
    [PROJECT_ID],
  ) as any;
}

describe('user revision → revision-advanced ONE Memory closure', () => {
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

  test('revision-advanced finalize enqueues the new fingerprint and keeps the frozen trace', async () => {
    await closeOriginalBody();
    const before = await listOutbox();
    expect(before).toHaveLength(1);
    expect(before[0].dedupe_key).toBe(
      `rebuild_story_memory:outline:${PROJECT_ID}:${CHAPTER_ID}:${sha256Hex(BODY_A)}`,
    );

    // Simulate the user revision apply: chapter body A → B, plus the audit
    // snapshot row the apply writes BEFORE the closure runs. The PostWriting
    // binding must look through the non-pipeline snapshot row and still find
    // the originating pipeline task.
    await execute(
      await openDatabase(),
      `INSERT INTO content_revisions (
         project_id, target_type, target_id, title, content, source, source_ref, created_at
       ) VALUES (?, 'chapter', ?, '第一章', ?, 'before_targeted_revision', 'ur_snapshot', 't2')`,
      [PROJECT_ID, CHAPTER_ID, BODY_A],
    );
    await execute(
      await openDatabase(),
      'UPDATE chapters SET content = ?, updated_at = ? WHERE id = ?',
      [BODY_B, 't2', CHAPTER_ID],
    );

    await expect(
      finalizeChapterMemory(CHAPTER_ID, { revisionAdvancedBody: true }),
    ).resolves.toBeTruthy();

    const after = await listOutbox();
    expect(after).toHaveLength(2);
    const fingerPrints = after.map(row =>
      JSON.parse(String(row.payload_json)).writingPersistedEvent
        .finalBodyFingerprint,
    );
    expect(fingerPrints).toContain(sha256Hex(BODY_A));
    expect(fingerPrints).toContain(sha256Hex(BODY_B));

    // The frozen trace still carries the original body's immutable event and
    // exactly one postWritingUpdate closure.
    const task = await one<{ pipeline_context_json: string }>(
      'SELECT pipeline_context_json FROM pipeline_tasks WHERE id = ?',
      [TASK_ID],
    );
    const trace = JSON.parse(String(task?.pipeline_context_json)).draftContext
      .writingKernelTrace;
    expect(trace.writingPersistedEvent.finalBodyFingerprint).toBe(
      sha256Hex(BODY_A),
    );
    expect(
      trace.events.filter(
        (event: { stage: string; status: string }) =>
          event.stage === 'postWritingUpdate' && event.status === 'completed',
      ),
    ).toHaveLength(1);
  });

  test('duplicate revision-advanced finalize for the same body stays idempotent', async () => {
    await closeOriginalBody();
    await execute(
      await openDatabase(),
      'UPDATE chapters SET content = ? WHERE id = ?',
      [BODY_B, CHAPTER_ID],
    );
    await finalizeChapterMemory(CHAPTER_ID, { revisionAdvancedBody: true });
    const first = await listOutbox();

    await finalizeChapterMemory(CHAPTER_ID, { revisionAdvancedBody: true });
    const second = await listOutbox();
    expect(second).toEqual(first);
  });

  test('without the revision-advanced opt-in the trace re-closure still fails closed', async () => {
    await closeOriginalBody();
    await execute(
      await openDatabase(),
      'UPDATE chapters SET content = ? WHERE id = ?',
      [BODY_B, CHAPTER_ID],
    );
    // A plain finalize on a drifted body refuses to re-close the frozen trace.
    await expect(finalizeChapterMemory(CHAPTER_ID)).rejects.toThrow(
      /WRITING_POST_WRITING_REVISION_DRIFT/,
    );
    // The fingerprint-keyed outbox handoff itself landed (memory never stays
    // stale), but the frozen trace keeps body A's immutable event.
    const rows = await listOutbox();
    expect(rows).toHaveLength(2);
    const task = await one<{ pipeline_context_json: string }>(
      'SELECT pipeline_context_json FROM pipeline_tasks WHERE id = ?',
      [TASK_ID],
    );
    const trace = JSON.parse(String(task?.pipeline_context_json)).draftContext
      .writingKernelTrace;
    expect(trace.writingPersistedEvent.finalBodyFingerprint).toBe(
      sha256Hex(BODY_A),
    );
  });
});
