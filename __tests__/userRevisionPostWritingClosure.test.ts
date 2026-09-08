/**
 * P1: after a finalized chapter is edited through the real chapter repository
 * boundary (body A → B), the chapter becomes draft and the ONE existing
 * PostWriting closure safely advances to body B. Body A remains in trace
 * history, duplicate finalize stays idempotent, and a body change that bypasses
 * the lineage boundary still fails closed.
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
import { updateChapter } from '../src/data/repositories/projectRepository';
import { finalizeChapterMemory } from '../src/services/storyMemory/storyMemoryService';
import { persistOutlinePostWritingClosure } from '../src/services/writing/flow/outlinePostWritingClosure';
import { buildWritingPersistedEvent } from '../src/services/writing/flow/writingPersistedEvent';
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
  return (await all(
    `SELECT id, dedupe_key, payload_json FROM continuation_state_sync_outbox
      WHERE project_id = ? ORDER BY dedupe_key`,
    [PROJECT_ID],
  )) as any;
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
      `rebuild_story_memory:outline:${PROJECT_ID}:${CHAPTER_ID}:${sha256Hex(
        BODY_A,
      )}`,
    );

    // The repository boundary must atomically write the body, downgrade the
    // presentation state, and record the old body as the revision parent.
    await updateChapter(CHAPTER_ID, { content: BODY_B });
    const editedChapter = await one<{
      content: string;
      status: string;
      finalized_at: string | null;
    }>('SELECT content, status, finalized_at FROM chapters WHERE id = ?', [
      CHAPTER_ID,
    ]);
    expect(editedChapter).toEqual({
      content: BODY_B,
      status: 'draft',
      finalized_at: null,
    });
    const parentSnapshot = await one<{
      content: string;
      source: string;
      source_ref: string;
    }>(
      `SELECT content, source, source_ref FROM content_revisions
       WHERE target_type = 'chapter' AND target_id = ?
         AND source = 'before_manual_edit'
       ORDER BY id DESC LIMIT 1`,
      [CHAPTER_ID],
    );
    expect(parentSnapshot?.content).toBe(BODY_A);
    expect(parentSnapshot?.source).toBe('before_manual_edit');
    expect(parentSnapshot?.source_ref).toContain(sha256Hex(BODY_A));
    expect(parentSnapshot?.source_ref).toContain(sha256Hex(BODY_B));

    await expect(finalizeChapterMemory(CHAPTER_ID)).resolves.toBeTruthy();

    const after = await listOutbox();
    expect(after).toHaveLength(2);
    const fingerPrints = after.map(
      row =>
        JSON.parse(String(row.payload_json)).writingPersistedEvent
          .finalBodyFingerprint,
    );
    expect(fingerPrints).toContain(sha256Hex(BODY_A));
    expect(fingerPrints).toContain(sha256Hex(BODY_B));

    // The current trace event now describes body B; body A is retained as a
    // historical event and there is still exactly one closure marker.
    const task = await one<{ pipeline_context_json: string }>(
      'SELECT pipeline_context_json FROM pipeline_tasks WHERE id = ?',
      [TASK_ID],
    );
    const trace = JSON.parse(String(task?.pipeline_context_json)).draftContext
      .writingKernelTrace;
    expect(trace.writingPersistedEvent.finalBodyFingerprint).toBe(
      sha256Hex(BODY_B),
    );
    expect(trace.writingPersistedEventHistory).toHaveLength(1);
    expect(trace.writingPersistedEventHistory[0].finalBodyFingerprint).toBe(
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
    await updateChapter(CHAPTER_ID, { content: BODY_B });
    await finalizeChapterMemory(CHAPTER_ID);
    const first = await listOutbox();

    await finalizeChapterMemory(CHAPTER_ID);
    const second = await listOutbox();
    expect(second).toEqual(first);
  });

  test('an identical repository save does not invalidate a finalized body', async () => {
    await closeOriginalBody();
    const before = await all<{
      source: string;
    }>(
      `SELECT source FROM content_revisions
       WHERE target_type = 'chapter' AND target_id = ?`,
      [CHAPTER_ID],
    );

    await updateChapter(CHAPTER_ID, { content: BODY_A });

    const chapter = await one<{
      content: string;
      status: string;
      finalized_at: string | null;
    }>('SELECT content, status, finalized_at FROM chapters WHERE id = ?', [
      CHAPTER_ID,
    ]);
    expect(chapter?.content).toBe(BODY_A);
    expect(chapter?.status).toBe('final');
    expect(chapter?.finalized_at).not.toBeNull();

    const after = await all<{
      source: string;
    }>(
      `SELECT source FROM content_revisions
       WHERE target_type = 'chapter' AND target_id = ?`,
      [CHAPTER_ID],
    );
    expect(after).toHaveLength(before.length);
    await expect(finalizeChapterMemory(CHAPTER_ID)).resolves.toBeTruthy();
    expect(await listOutbox()).toHaveLength(1);
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
    const chapter = await one<{ status: string; finalized_at: string | null }>(
      'SELECT status, finalized_at FROM chapters WHERE id = ?',
      [CHAPTER_ID],
    );
    expect(chapter).toEqual({ status: 'draft', finalized_at: null });
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

  test('rejects a revision whose parent fingerprint is not the closed body', async () => {
    await closeOriginalBody();
    await updateChapter(CHAPTER_ID, { content: BODY_B });

    await expect(
      finalizeChapterMemory(CHAPTER_ID, {
        revisionAdvancedBody: true,
        revisionBaseBodyFingerprint: sha256Hex('unrelated body'),
      }),
    ).rejects.toThrow(/WRITING_POST_WRITING_REVISION_DRIFT/);

    const chapter = await one<{
      status: string;
      finalized_at: string | null;
    }>('SELECT status, finalized_at FROM chapters WHERE id = ?', [CHAPTER_ID]);
    expect(chapter).toEqual({ status: 'draft', finalized_at: null });
  });

  test('rejects a different chapter even when revision advance is requested', async () => {
    await closeOriginalBody();
    const task = await one<{ pipeline_context_json: string }>(
      'SELECT pipeline_context_json FROM pipeline_tasks WHERE id = ?',
      [TASK_ID],
    );
    const trace = JSON.parse(String(task?.pipeline_context_json)).draftContext
      .writingKernelTrace;
    const event = buildWritingPersistedEvent({
      generationTraceId: trace.generationTraceId,
      freezeFingerprint: trace.freezeFingerprint,
      projectId: PROJECT_ID,
      chapterId: CHAPTER_ID + 1,
      chapterPosition: 1,
      finalBody: BODY_B,
      scenario: 'outline',
    });

    await expect(
      persistOutlinePostWritingClosure({
        taskId: TASK_ID,
        persistedEvent: event,
        durationMs: 0,
        revisionAdvancedBody: true,
        revisionBaseBodyFingerprint: sha256Hex(BODY_A),
      }),
    ).rejects.toThrow(/WRITING_POST_WRITING_REVISION_DRIFT/);
  });
});
