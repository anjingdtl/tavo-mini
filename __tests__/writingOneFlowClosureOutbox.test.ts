/**
 * ONE-Flow Closure — Outbox failure relevance gate (closure plan P0-1).
 *
 * Real SQLite (sql.js in-memory) drives `checkNextChapterReady` so the
 * Ready-Gate decision runs against actual outbox / chapters / story-memory
 * rows, not mocks.
 *
 * Contract under test: only unresolved hard failures the next-chapter Freeze
 * actually depends on may block. Historical rows keep their diagnostic value
 * (never deleted) but are classified stale / covered / superseded /
 * historical / unrelated instead of blocking.
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
const COMPLETED_CHAPTER_ID = 101;
const COMPLETED_POSITION = 72;
const CHAPTER_CONTENT = '第七十二章 灯塔下的对峙。林澜握紧了信号枪。';

function ts(ms: number): string {
  return new Date(Date.UTC(2026, 0, 1) + ms).toISOString();
}

async function sql(sqlText: string, params: any[] = []): Promise<any> {
  const db = await openDatabase();
  const [res] = await db.executeSql(sqlText, params);
  return res;
}

interface OutboxSeed {
  id: number;
  operation: 'extract_state' | 'apply_event' | 'rebuild_story_memory';
  dedupeKey: string;
  state: string;
  payloadJson?: string;
  chapterId?: number | null;
  lastError?: string;
  updatedAt?: string;
  completedAt?: string | null;
}

function seedOutbox(seed: OutboxSeed): Promise<any> {
  return sql(
    `INSERT INTO continuation_state_sync_outbox (
       id, project_id, chapter_id, operation, payload_json, dedupe_key,
       state, attempt_count, last_error, created_at, updated_at, completed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `co_seed_${seed.id}`,
      PROJECT_ID,
      seed.chapterId ?? null,
      seed.operation,
      seed.payloadJson ?? '{}',
      seed.dedupeKey,
      seed.state,
      seed.state === 'failed' ? 5 : 1,
      seed.lastError ?? (seed.state === 'failed' ? '历史失败' : null),
      seed.updatedAt ?? ts(0),
      seed.updatedAt ?? ts(0),
      seed.completedAt ?? (seed.state === 'completed' ? ts(10) : null),
    ],
  );
}

/**
 * Minimal settled world for the gate at completedPosition 72:
 * finalized chapter, exact extract + auto rebuild completed, story memory
 * clean and covering through 72. Each scenario adds failure rows on top.
 */
async function seedSettledBase(): Promise<string> {
  const revisionHash = contentRevisionHash(CHAPTER_CONTENT);
  await sql(
    `INSERT INTO projects (id, name, mode, created_at, updated_at)
     VALUES (1, 'closure-outbox', 'continuation', ?, ?)`,
    [ts(0), ts(0)],
  );
  await sql(
    `INSERT INTO chapters (id, project_id, position, title, synopsis, content, status, created_at, updated_at)
     VALUES (?, ?, ?, '第七十二章', '', ?, 'finalized', ?, ?)`,
    [
      COMPLETED_CHAPTER_ID,
      PROJECT_ID,
      COMPLETED_POSITION,
      CHAPTER_CONTENT,
      ts(0),
      ts(0),
    ],
  );
  await sql(
    `INSERT INTO project_story_memory (
       project_id, schema_version, through_chapter_id, through_chapter_position,
       memory_json, estimated_tokens, state_fingerprint, status, source,
       dirty_from_position, last_error, updated_at
     ) VALUES (?, 1, ?, ?, ?, 100, 'fp', 'clean', 'native', NULL, '', ?)`,
    [
      PROJECT_ID,
      COMPLETED_CHAPTER_ID,
      COMPLETED_POSITION,
      JSON.stringify({ throughChapterPosition: COMPLETED_POSITION, metadata: {} }),
      ts(10),
    ],
  );
  await seedOutbox({
    id: 1,
    operation: 'extract_state',
    dedupeKey: `extract_state:${COMPLETED_CHAPTER_ID}:${revisionHash}`,
    state: 'completed',
    chapterId: COMPLETED_CHAPTER_ID,
    payloadJson: JSON.stringify({
      projectId: PROJECT_ID,
      chapterId: COMPLETED_CHAPTER_ID,
      chapterRevisionHash: revisionHash,
    }),
  });
  await seedOutbox({
    id: 2,
    operation: 'rebuild_story_memory',
    dedupeKey: `rebuild_story_memory:auto:${PROJECT_ID}:${COMPLETED_POSITION}:${revisionHash}`,
    state: 'completed',
    payloadJson: JSON.stringify({ fromPosition: COMPLETED_POSITION }),
  });
  return revisionHash;
}

function gateInput() {
  return {
    projectId: PROJECT_ID,
    completedChapterId: COMPLETED_CHAPTER_ID,
    completedPosition: COMPLETED_POSITION,
    anchor: null,
  };
}

describe('ONE-Flow closure outbox relevance gate (P0-1)', () => {
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

  test('settled base with no failures is ready', async () => {
    const result = await checkNextChapterReady(gateInput());
    expect(result.ready).toBe(true);
  });

  test('current exact extract_state failed → BLOCK (fail-closed)', async () => {
    const revisionHash = contentRevisionHash(CHAPTER_CONTENT);
    await seedOutbox({
      id: 90,
      operation: 'extract_state',
      dedupeKey: `extract_state:${COMPLETED_CHAPTER_ID}:${revisionHash}_other`,
      state: 'failed',
      chapterId: COMPLETED_CHAPTER_ID,
      payloadJson: JSON.stringify({
        projectId: PROJECT_ID,
        chapterId: COMPLETED_CHAPTER_ID,
        chapterRevisionHash: `${revisionHash}_other`,
      }),
      lastError: 'extraction exploded',
    });
    // Make the exact row itself failed for this scenario.
    await sql(
      `UPDATE continuation_state_sync_outbox SET state = 'failed', last_error = 'extract failed'
       WHERE dedupe_key = ?`,
      [`extract_state:${COMPLETED_CHAPTER_ID}:${revisionHash}`],
    );
    const result = await checkNextChapterReady(gateInput());
    expect(result.ready).toBe(false);
    if (!result.ready && result.status === 'blocked') {
      expect(result.errorCode).toBe('BATCH_CONTINUATION_STATE_SYNC_FAILED');
    }
  });

  test('current exact rebuild_story_memory failed → BLOCK (fail-closed)', async () => {
    const revisionHash = contentRevisionHash(CHAPTER_CONTENT);
    await sql(
      `UPDATE continuation_state_sync_outbox SET state = 'failed', last_error = 'rebuild failed'
       WHERE dedupe_key = ?`,
      [
        `rebuild_story_memory:auto:${PROJECT_ID}:${COMPLETED_POSITION}:${revisionHash}`,
      ],
    );
    const result = await checkNextChapterReady(gateInput());
    expect(result.ready).toBe(false);
    if (!result.ready && result.status === 'blocked') {
      expect(result.errorCode).toBe('BATCH_CONTINUATION_STATE_SYNC_FAILED');
    }
  });

  test('RED: historical failed rebuild (old flow) with current truth ready → NOT BLOCK', async () => {
    await seedOutbox({
      id: 80,
      operation: 'rebuild_story_memory',
      dedupeKey: `rebuild_story_memory:${PROJECT_ID}:0:legacy_repair`,
      state: 'failed',
      payloadJson: JSON.stringify({ fromPosition: 0, reason: 'legacy_repair' }),
      lastError: '旧流程重建失败',
      updatedAt: ts(5),
    });
    const result = await checkNextChapterReady(gateInput());
    expect(result.ready).toBe(true);
  });

  test('RED: old-revision extract failure + current exact revision completed → NOT BLOCK', async () => {
    const revisionHash = contentRevisionHash(CHAPTER_CONTENT);
    await seedOutbox({
      id: 81,
      operation: 'extract_state',
      dedupeKey: `extract_state:${COMPLETED_CHAPTER_ID}:oldhashvalue`,
      state: 'failed',
      chapterId: COMPLETED_CHAPTER_ID,
      payloadJson: JSON.stringify({
        projectId: PROJECT_ID,
        chapterId: COMPLETED_CHAPTER_ID,
        chapterRevisionHash: 'oldhashvalue',
      }),
      lastError: '旧版本提取失败',
      updatedAt: ts(5),
    });
    expect(`extract_state:${COMPLETED_CHAPTER_ID}:${revisionHash}`).toBeTruthy();
    const result = await checkNextChapterReady(gateInput());
    expect(result.ready).toBe(true);
  });

  test('RED: failed extract for a deleted chapter → NOT BLOCK (historical)', async () => {
    await seedOutbox({
      id: 82,
      operation: 'extract_state',
      dedupeKey: 'extract_state:999:deadbeef',
      state: 'failed',
      chapterId: null,
      payloadJson: JSON.stringify({
        projectId: PROJECT_ID,
        chapterId: 999,
        chapterRevisionHash: 'deadbeef',
      }),
      lastError: '章节后来被删除',
      updatedAt: ts(5),
    });
    const result = await checkNextChapterReady(gateInput());
    expect(result.ready).toBe(true);
  });

  test('RED: failed extract beyond completed position → NOT BLOCK (unrelated)', async () => {
    const tailContent = '尚未定稿的尾部草稿章节';
    const tailHash = contentRevisionHash(tailContent);
    await sql(
      `INSERT INTO chapters (id, project_id, position, title, synopsis, content, status, created_at, updated_at)
       VALUES (102, ?, 100, '草稿', '', ?, 'draft', ?, ?)`,
      [PROJECT_ID, tailContent, ts(1), ts(1)],
    );
    await seedOutbox({
      id: 83,
      operation: 'extract_state',
      dedupeKey: `extract_state:102:${tailHash}`,
      state: 'failed',
      chapterId: 102,
      payloadJson: JSON.stringify({
        projectId: PROJECT_ID,
        chapterId: 102,
        chapterRevisionHash: tailHash,
      }),
      lastError: '尾部章节提取失败',
      updatedAt: ts(5),
    });
    const result = await checkNextChapterReady(gateInput());
    expect(result.ready).toBe(true);
  });

  test('failed extract in-range with hash still current → BLOCK (fail-closed)', async () => {
    const staleContent = '第十章的旧正文内容';
    const staleHash = contentRevisionHash(staleContent);
    await sql(
      `INSERT INTO chapters (id, project_id, position, title, synopsis, content, status, created_at, updated_at)
       VALUES (100, ?, 10, '第十章', '', ?, 'finalized', ?, ?)`,
      [PROJECT_ID, staleContent, ts(0), ts(0)],
    );
    await seedOutbox({
      id: 84,
      operation: 'extract_state',
      dedupeKey: `extract_state:100:${staleHash}`,
      state: 'failed',
      chapterId: 100,
      payloadJson: JSON.stringify({
        projectId: PROJECT_ID,
        chapterId: 100,
        chapterRevisionHash: staleHash,
      }),
      lastError: '早期章节提取失败未恢复',
      updatedAt: ts(5),
    });
    const result = await checkNextChapterReady(gateInput());
    expect(result.ready).toBe(false);
    if (!result.ready) {
      expect(result.status).toBe('blocked');
    }
  });

  test('failed extract in-range but chapter content since changed → NOT BLOCK (stale)', async () => {
    const oldHash = contentRevisionHash('第十章的旧正文内容');
    await sql(
      `INSERT INTO chapters (id, project_id, position, title, synopsis, content, status, created_at, updated_at)
       VALUES (100, ?, 10, '第十章', '', ?, 'finalized', ?, ?)`,
      [PROJECT_ID, '用户改写后的第十章正文', ts(0), ts(0)],
    );
    await seedOutbox({
      id: 85,
      operation: 'extract_state',
      dedupeKey: `extract_state:100:${oldHash}`,
      state: 'failed',
      chapterId: 100,
      payloadJson: JSON.stringify({
        projectId: PROJECT_ID,
        chapterId: 100,
        chapterRevisionHash: oldHash,
      }),
      lastError: '旧版本提取失败',
      updatedAt: ts(5),
    });
    const result = await checkNextChapterReady(gateInput());
    expect(result.ready).toBe(true);
  });

  test('RED: failed rebuild starting beyond completed position → NOT BLOCK (unrelated)', async () => {
    await seedOutbox({
      id: 86,
      operation: 'rebuild_story_memory',
      dedupeKey: `rebuild_story_memory:${PROJECT_ID}:80:manual`,
      state: 'failed',
      payloadJson: JSON.stringify({ fromPosition: 80, reason: 'manual' }),
      lastError: '越界重建失败',
      updatedAt: ts(5),
    });
    const result = await checkNextChapterReady(gateInput());
    expect(result.ready).toBe(true);
  });

  test('RED: apply_event failure → NOT BLOCK (historical, event durable at confirm)', async () => {
    await seedOutbox({
      id: 87,
      operation: 'apply_event',
      dedupeKey: 'apply_event:ce_legacy_1',
      state: 'failed',
      lastError: '旧流程 apply 失败',
      updatedAt: ts(5),
    });
    const result = await checkNextChapterReady(gateInput());
    expect(result.ready).toBe(true);
  });

  test('RED: old failed rebuild superseded by later completed rebuild from earlier position → NOT BLOCK', async () => {
    // Simulate an older device state where the truth row cannot attest
    // coverage (memory_json missing) but the outbox history can.
    await sql('DELETE FROM project_story_memory');
    const revisionHash = contentRevisionHash(CHAPTER_CONTENT);
    await seedOutbox({
      id: 88,
      operation: 'rebuild_story_memory',
      dedupeKey: `rebuild_story_memory:${PROJECT_ID}:50:legacy_repair`,
      state: 'failed',
      payloadJson: JSON.stringify({ fromPosition: 50, reason: 'legacy_repair' }),
      lastError: '从 50 重建失败',
      updatedAt: ts(20),
    });
    await seedOutbox({
      id: 89,
      operation: 'rebuild_story_memory',
      dedupeKey: `rebuild_story_memory:${PROJECT_ID}:0:legacy_retry`,
      state: 'completed',
      payloadJson: JSON.stringify({ fromPosition: 0, reason: 'legacy_retry' }),
      updatedAt: ts(30),
      completedAt: ts(31),
    });
    expect(revisionHash).toBeTruthy();
    const result = await checkNextChapterReady(gateInput());
    expect(result.ready).toBe(true);
  });

  test('failed rebuild in range with no later coverage and no truth row → BLOCK (fail-closed)', async () => {
    await sql('DELETE FROM project_story_memory');
    await seedOutbox({
      id: 91,
      operation: 'rebuild_story_memory',
      dedupeKey: `rebuild_story_memory:${PROJECT_ID}:50:legacy_repair`,
      state: 'failed',
      payloadJson: JSON.stringify({ fromPosition: 50, reason: 'legacy_repair' }),
      lastError: '从 50 重建失败',
      updatedAt: ts(20),
    });
    const result = await checkNextChapterReady(gateInput());
    expect(result.ready).toBe(false);
    if (!result.ready) {
      expect(result.status).toBe('blocked');
    }
  });

  test('dirty story memory with dirtyFromPosition <= completedPosition → NOT ready', async () => {
    await sql(
      `UPDATE project_story_memory
       SET status = 'dirty', dirty_from_position = 40 WHERE project_id = ?`,
      [PROJECT_ID],
    );
    const result = await checkNextChapterReady(gateInput());
    expect(result.ready).toBe(false);
    if (!result.ready) {
      expect(result.status).toBe('waiting');
    }
  });

  test('failed story memory build with dirtyFromPosition <= completedPosition → NOT ready', async () => {
    await sql(
      `UPDATE project_story_memory
       SET status = 'failed', dirty_from_position = 60 WHERE project_id = ?`,
      [PROJECT_ID],
    );
    const result = await checkNextChapterReady(gateInput());
    expect(result.ready).toBe(false);
  });
});
