/**
 * ONE-Flow Closure — continuation run row reads must survive 1MB+
 * context snapshots on low-RAM devices (CursorWindow shrinks to 1MB).
 *
 * Real SQLite (sql.js) seeds a run row with a multi-megabyte
 * context_snapshot_json, then verifies the repository read path returns
 * metadata (workflowVersion / trace id extracted via json_extract, snapshot
 * column projected away) and that the chunked snapshot loader reassembles
 * the exact original JSON.
 */
import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import type { InMemorySqliteDb } from './helpers/canonInMemoryDb';
import {
  __setDatabaseForTest,
  __resetForTest,
  openDatabase,
} from '../src/data/connection/openDatabase';
import {
  getRunById,
  getRunContextSnapshotJson,
  listRunsForProject,
  findLatestAdoptedRunForChapter,
} from '../src/services/continuation/generation/generationRepository';

const PROJECT_ID = 77;
const CHAPTER_ID = 901;
const now = new Date().toISOString();

/** ~2.6MB of snapshot JSON: padding fields plus the meaningful keys. */
function buildHugeSnapshotJson(): string {
  const padding = 'x'.repeat(2_600_000);
  return JSON.stringify({
    workflowVersion: 5,
    generationTraceId: 'gt-cursor-window-test',
    writingKernelTrace: {
      generationTraceId: 'gt-cursor-window-test',
      freezeFingerprint: 'fp-test',
    },
    frozenWritingContext: { padding },
    metadata: {},
  });
}

async function sql(sqlText: string, params: any[] = []): Promise<any> {
  const db = await openDatabase();
  const [res] = await db.executeSql(sqlText, params);
  return res;
}

describe('continuation run reads survive huge context snapshots', () => {
  let db: InMemorySqliteDb;
  let hugeSnapshot: string;

  beforeAll(async () => {
    db = await createCanonInMemoryDb();
    __setDatabaseForTest(db as any);
    hugeSnapshot = buildHugeSnapshotJson();
    await sql(
      `INSERT INTO projects (id, name, mode, created_at, updated_at)
       VALUES (?, 'cursor-window', 'continuation', ?, ?)`,
      [PROJECT_ID, now, now],
    );
    await sql(
      `INSERT INTO chapters (id, project_id, position, title, content, status, created_at, updated_at)
       VALUES (?, ?, 50, '第五十章', '正文', 'finalized', ?, ?)`,
      [CHAPTER_ID, PROJECT_ID, now, now],
    );
  });

  afterAll(() => {
    __resetForTest();
    db?.close();
  });

  beforeEach(async () => {
    await sql('DELETE FROM continuation_generation_runs');
    await sql(
      `INSERT INTO continuation_generation_runs (
         id, project_id, chapter_id, target_position, source_id,
         source_snapshot_json, canon_revision, story_memory_fingerprint,
         story_memory_through_position, input_revision_hash, user_instruction,
         settings_snapshot_json,
         context_snapshot_json, context_trace_json, token_usage_json,
         state, stage, completion_reason, finalized_revision_hash,
         created_at, updated_at, completed_at
       ) VALUES ('ct_run_huge', ?, ?, 50, NULL, '{}', 1, '', 0, '', '',
         '{}', ?, '{}', '{}',
         'completed', 'awaiting_user', 'adopted', 'hash1', ?, ?, ?)`,
      [PROJECT_ID, CHAPTER_ID, hugeSnapshot, now, now, now],
    );
  });

  test('getRunById returns metadata without loading the snapshot body', async () => {
    const run = await getRunById('ct_run_huge');
    expect(run).not.toBeNull();
    expect(run!.state).toBe('completed');
    expect(run!.workflowVersion).toBe(5);
    // Metadata reads must project the giant column away.
    expect(run!.contextSnapshotJson).toBeNull();
  });

  test('listRunsForProject and adopted-run lookup stay metadata-only', async () => {
    const runs = await listRunsForProject(PROJECT_ID);
    expect(runs).toHaveLength(1);
    expect(runs[0].contextSnapshotJson).toBeNull();
    expect(runs[0].workflowVersion).toBe(5);

    const adopted = await findLatestAdoptedRunForChapter(PROJECT_ID, CHAPTER_ID);
    expect(adopted).not.toBeNull();
    expect(adopted!.contextSnapshotJson).toBeNull();
    expect(adopted!.finalizedRevisionHash).toBe('hash1');
  });

  test('getRunContextSnapshotJson reassembles the exact original JSON', async () => {
    const snapshot = await getRunContextSnapshotJson('ct_run_huge');
    expect(snapshot).not.toBeNull();
    expect(snapshot).toBe(hugeSnapshot);
    const parsed = JSON.parse(snapshot!);
    expect(parsed.writingKernelTrace.generationTraceId).toBe(
      'gt-cursor-window-test',
    );
  });

  test('getRunContextSnapshotJson handles missing runs and empty snapshots', async () => {
    expect(await getRunContextSnapshotJson('ct_run_missing')).toBeNull();
    await sql(
      `INSERT INTO continuation_generation_runs (
         id, project_id, chapter_id, target_position, source_snapshot_json,
         canon_revision, story_memory_fingerprint, story_memory_through_position,
         input_revision_hash, user_instruction, settings_snapshot_json,
         context_snapshot_json, state, stage, created_at, updated_at
       ) VALUES ('ct_run_empty', ?, ?, 51, '{}', 1, '', 0, '', '', '{}',
         NULL, 'queued', 'awaiting_user', ?, ?)`,
      [PROJECT_ID, CHAPTER_ID, now, now],
    );
    expect(await getRunContextSnapshotJson('ct_run_empty')).toBeNull();
  });
});
