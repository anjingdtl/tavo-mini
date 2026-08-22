import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import type { InMemorySqliteDb } from './helpers/canonInMemoryDb';
import {
  __resetForTest,
  __setDatabaseForTest,
  openDatabase,
} from '../src/data/connection/openDatabase';
import { execute } from '../src/data/connection/execute';
import {
  getOutboxByDedupe,
} from '../src/services/continuation/generation/generationRepository';
import { processContinuationOutbox } from '../src/services/continuation/generation/continuationStateOutboxWorker';
import {
  enqueueOutlineStoryMemoryPostWriting,
} from '../src/services/writing/flow/outlinePostWritingClosure';
import { buildWritingPersistedEvent } from '../src/services/writing/flow/writingPersistedEvent';

const PROJECT_ID = 1;
const CHAPTER_ID = 101;
const CHAPTER_POSITION = 0;
const BODY = '定稿后的 Outline 正文。';

let testDb: InMemorySqliteDb | null = null;

async function sql(sqlText: string, params: any[] = []): Promise<any> {
  const db = await openDatabase();
  const [result] = await db.executeSql(sqlText, params);
  return result;
}

function event() {
  return buildWritingPersistedEvent({
    generationTraceId: 'gt-outline-outbox',
    freezeFingerprint: 'freeze-outline-outbox',
    projectId: PROJECT_ID,
    chapterId: CHAPTER_ID,
    chapterPosition: CHAPTER_POSITION,
    finalBody: BODY,
    scenario: 'outline',
  });
}

async function seed(): Promise<void> {
  await execute(
    await openDatabase(),
    `INSERT INTO projects (id, name, mode, created_at, updated_at)
     VALUES (?, 'outline-outbox', 'outline', 't', 't')`,
    [PROJECT_ID],
  );
  await execute(
    await openDatabase(),
    `INSERT INTO chapters (
       id, project_id, position, title, synopsis, content, status,
       created_at, updated_at, finalized_at
     ) VALUES (?, ?, ?, '第一章', '', ?, 'final', 't', 't', 't')`,
    [CHAPTER_ID, PROJECT_ID, CHAPTER_POSITION, BODY],
  );
}

describe('Outline PostWriting → ONE Memory outbox', () => {
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

  test('uses one stable event/dedupe key and settles through the existing worker', async () => {
    const first = await enqueueOutlineStoryMemoryPostWriting({
      persistedEvent: event(),
      taskId: 'outline-task-1',
    });
    const second = await enqueueOutlineStoryMemoryPostWriting({
      persistedEvent: event(),
      taskId: 'outline-task-1',
    });

    expect(second.eventKey).toBe(first.eventKey);
    expect(second.dedupeKey).toBe(first.dedupeKey);
    expect(second.outboxId).toBe(first.outboxId);
    expect(
      await sql(
        'SELECT COUNT(*) AS c FROM continuation_state_sync_outbox WHERE dedupe_key = ?',
        [first.dedupeKey],
      ).then((row: any) => row.rows.item(0).c),
    ).toBe(1);

    const rebuild = jest.fn(async () => undefined);
    await expect(
      processContinuationOutbox({
        limit: 10,
        rebuildStoryMemory: rebuild,
      }),
    ).resolves.toEqual({ processed: 1, failed: 0 });
    expect(rebuild).toHaveBeenCalledWith(PROJECT_ID, CHAPTER_POSITION);
    await expect(getOutboxByDedupe(first.dedupeKey)).resolves.toMatchObject({
      state: 'completed',
    });
  });

  test('fails closed when a retry sees a different persisted body', async () => {
    const handoff = await enqueueOutlineStoryMemoryPostWriting({
      persistedEvent: event(),
    });
    await execute(
      await openDatabase(),
      'UPDATE chapters SET content = ? WHERE id = ?',
      ['被替换的正文。', CHAPTER_ID],
    );

    const result = await processContinuationOutbox({
      limit: 10,
      rebuildStoryMemory: jest.fn(async () => undefined),
    });
    expect(result).toEqual({ processed: 0, failed: 1 });
    await expect(getOutboxByDedupe(handoff.dedupeKey)).resolves.toMatchObject({
      state: 'failed',
      lastError: expect.stringContaining('WRITING_POST_WRITING_REVISION_DRIFT'),
    });
  });
});
