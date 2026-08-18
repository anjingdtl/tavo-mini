/**
 * ONE-Flow Closure — Ready Gate vs current Story Memory truth (P0-3).
 *
 * Truth priority: Canon > Frozen Source Boundary > Structured Continuity
 * State > Story Memory > Recent Prose. The Ready Gate must read the CURRENT
 * story-memory truth row, not historical failure rows: an old rebuild
 * failure that later success has covered must never re-judge the memory
 * unusable, while a memory that is actually dirty / rebuilding / failed
 * within the required range must keep blocking (fail-closed).
 */
import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import type { InMemorySqliteDb } from './helpers/canonInMemoryDb';
import {
  __setDatabaseForTest,
  __resetForTest,
  openDatabase,
} from '../src/data/connection/openDatabase';
import { checkNextChapterReady } from '../src/services/multiChapterBatch/continuationBatchStateGate';
import { contentRevisionHash } from '../src/services/continuation/generation/generationRepository';

const PROJECT_ID = 1;
const CHAPTER_ID = 101;
const COMPLETED_POSITION = 72;
const CHAPTER_CONTENT = '第七十二章 灯塔下的对峙。林澜握紧了信号枪。';

async function sql(sqlText: string, params: any[] = []): Promise<any> {
  const db = await openDatabase();
  const [res] = await db.executeSql(sqlText, params);
  return res;
}

async function seedSettledBase(): Promise<string> {
  const revisionHash = contentRevisionHash(CHAPTER_CONTENT);
  const now = new Date().toISOString();
  await sql(
    `INSERT INTO projects (id, name, mode, created_at, updated_at)
     VALUES (1, 'closure-ready-gate', 'continuation', ?, ?)`,
    [now, now],
  );
  await sql(
    `INSERT INTO chapters (id, project_id, position, title, synopsis, content, status, created_at, updated_at)
     VALUES (?, ?, ?, '第七十二章', '', ?, 'finalized', ?, ?)`,
    [CHAPTER_ID, PROJECT_ID, COMPLETED_POSITION, CHAPTER_CONTENT, now, now],
  );
  await sql(
    `INSERT INTO continuation_state_sync_outbox (
       id, project_id, chapter_id, operation, payload_json, dedupe_key,
       state, attempt_count, last_error, created_at, updated_at, completed_at
     ) VALUES
       ('co_ex', 1, ?, 'extract_state', '{}', ?, 'completed', 1, NULL, ?, ?, ?),
       ('co_rb', 1, ?, 'rebuild_story_memory', '{}', ?, 'completed', 1, NULL, ?, ?, ?)`,
    [
      CHAPTER_ID,
      `extract_state:${CHAPTER_ID}:${revisionHash}`,
      now,
      now,
      now,
      CHAPTER_ID,
      `rebuild_story_memory:auto:${PROJECT_ID}:${COMPLETED_POSITION}:${revisionHash}`,
      now,
      now,
      now,
    ],
  );
  return revisionHash;
}

async function setMemoryTruth(truth: {
  status: string;
  dirtyFromPosition: number | null;
  throughPosition: number;
}): Promise<void> {
  const now = new Date().toISOString();
  await sql(
    `INSERT OR REPLACE INTO project_story_memory (
       project_id, schema_version, through_chapter_id, through_chapter_position,
       memory_json, estimated_tokens, state_fingerprint, status, source,
       dirty_from_position, last_error, updated_at
     ) VALUES (?, 1, ?, ?, ?, 100, 'fp', ?, 'native', ?, '', ?)`,
    [
      PROJECT_ID,
      CHAPTER_ID,
      truth.throughPosition,
      JSON.stringify({
        throughChapterPosition: truth.throughPosition,
        metadata: {},
      }),
      truth.status,
      truth.dirtyFromPosition,
      now,
    ],
  );
}

async function seedHistoricalRebuildFailure(fromPosition: number): Promise<void> {
  await sql(
    `INSERT INTO continuation_state_sync_outbox (
       id, project_id, chapter_id, operation, payload_json, dedupe_key,
       state, attempt_count, last_error, created_at, updated_at, completed_at
     ) VALUES ('co_hist_fail', 1, NULL, 'rebuild_story_memory', ?, ?, 'failed', 5, '历史重建失败', '2026-01-01T00:00:05.000Z', '2026-01-01T00:00:05.000Z', NULL)`,
    [
      JSON.stringify({ fromPosition, reason: 'legacy_repair' }),
      `rebuild_story_memory:${PROJECT_ID}:${fromPosition}:legacy_repair`,
    ],
  );
}

function gateInput() {
  return {
    projectId: PROJECT_ID,
    completedChapterId: CHAPTER_ID,
    completedPosition: COMPLETED_POSITION,
    anchor: null,
  };
}

describe('ONE-Flow closure ready gate story-memory truth alignment (P0-3)', () => {
  let db: InMemorySqliteDb;

  beforeAll(async () => {
    db = await createCanonInMemoryDb();
    __setDatabaseForTest(db as any);
  });

  afterAll(() => {
    __resetForTest();
    db?.close();
  });

  beforeEach(async () => {
    await sql('DELETE FROM continuation_state_sync_outbox');
    await sql('DELETE FROM project_story_memory');
    await sql('DELETE FROM chapters');
    await sql('DELETE FROM projects');
    await seedSettledBase();
  });

  test('old rebuild failed @ required position, truth ready + covered + clean → NOT blocked', async () => {
    await seedHistoricalRebuildFailure(COMPLETED_POSITION);
    await setMemoryTruth({
      status: 'clean',
      dirtyFromPosition: null,
      throughPosition: COMPLETED_POSITION,
    });
    const result = await checkNextChapterReady(gateInput());
    expect(result.ready).toBe(true);
  });

  test('truth clean + covered + no dirty marker → ready regardless of earlier failures', async () => {
    await seedHistoricalRebuildFailure(10);
    await setMemoryTruth({
      status: 'clean',
      dirtyFromPosition: null,
      throughPosition: COMPLETED_POSITION,
    });
    const result = await checkNextChapterReady(gateInput());
    expect(result.ready).toBe(true);
  });

  test('story memory failed with dirtyFromPosition <= completedPosition → NOT ready', async () => {
    await setMemoryTruth({
      status: 'failed',
      dirtyFromPosition: 60,
      throughPosition: 72,
    });
    const result = await checkNextChapterReady(gateInput());
    expect(result.ready).toBe(false);
  });

  test('story memory rebuilding with dirtyFromPosition <= completedPosition → NOT ready', async () => {
    await setMemoryTruth({
      status: 'rebuilding',
      dirtyFromPosition: COMPLETED_POSITION,
      throughPosition: 71,
    });
    const result = await checkNextChapterReady(gateInput());
    expect(result.ready).toBe(false);
    if (!result.ready) {
      expect(result.status).toBe('waiting');
    }
  });

  test('truth row cannot attest coverage (throughPosition behind) + in-range failure → blocked', async () => {
    await seedHistoricalRebuildFailure(50);
    await setMemoryTruth({
      status: 'clean',
      dirtyFromPosition: null,
      throughPosition: 40,
    });
    const result = await checkNextChapterReady(gateInput());
    expect(result.ready).toBe(false);
    if (!result.ready && result.status === 'blocked') {
      expect(result.errorCode).toBe('BATCH_CONTINUATION_STATE_SYNC_FAILED');
    }
  });

  test('no truth row at all + in-range failure → blocked (fail-closed)', async () => {
    await seedHistoricalRebuildFailure(50);
    const result = await checkNextChapterReady(gateInput());
    expect(result.ready).toBe(false);
    if (!result.ready) {
      expect(result.status).toBe('blocked');
    }
  });
});
