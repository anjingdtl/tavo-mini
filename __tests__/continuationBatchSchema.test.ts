/**
 * Continuation batch schema / migration tests (Round 1, doc §30).
 *
 * Migration Matrix:
 *   - fresh install (createCurrentSchema) carries the Schema 53 columns;
 *   - previous schema (42-shape) upgraded via migrateV52ToV53 gains them;
 *   - old outline batch rows backfill writing_mode='outline' and
 *     active_continuation_run_id=NULL without touching any other semantic;
 *   - the migration is idempotent;
 *   - the backup manifest enumerates the new columns (doc §31).
 */
import type { InMemorySqliteDb } from './helpers/canonInMemoryDb';
import {
  createCanonInMemoryDb,
  createEmptyInMemoryDb,
} from './helpers/canonInMemoryDb';
import { __setDatabaseForTest, __resetForTest } from '../src/data/connection/openDatabase';
import { buildSchema42CreateSqls } from '../src/services/migrations/v41-to-v42';
import { migrateV52ToV53 } from '../src/services/migrations/v52-to-v53';
import { SCHEMA_VERSION } from '../src/services/migrations';
import {
  createBatch,
  createBatchItem,
  getBatchById,
  getBatchItems,
  bindContinuationRunForItem,
  commitBatchItemAdoption,
  updateBatchItem,
  updateBatchStatus,
} from '../src/data/repositories/multiChapterBatchRepository';
import { SCHEMA_MANIFEST } from '../src/services/database/schemaManifest';
import {
  encodeContinuationBatchAnchor,
  encodeContinuationBatchExecutionPolicy,
  defaultContinuationBatchExecutionPolicy,
} from '../src/services/multiChapterBatch/batchMode';

async function tableColumnsOf(
  db: InMemorySqliteDb,
  table: string,
): Promise<Set<string>> {
  const [res] = await db.executeSql(`PRAGMA table_info(${table})`, []);
  const columns = new Set<string>();
  for (let i = 0; i < res.rows.length; i += 1) {
    columns.add(String(res.rows.item(i).name));
  }
  return columns;
}

describe('continuation batch schema 53/54', () => {
  let db: InMemorySqliteDb;

  afterAll(async () => {
    __resetForTest();
    db?.close();
  });

  it('SCHEMA_VERSION includes the Final-body artifact hash migration', () => {
    expect(SCHEMA_VERSION).toBe(58);
  });

  describe('fresh install', () => {
    beforeAll(async () => {
      db = await createCanonInMemoryDb();
      __setDatabaseForTest(db as any);
      await db.executeSql(
        `INSERT INTO projects (id, name, mode, created_at, updated_at)
         VALUES (1, '测试项目', 'outline', 0, 0)`,
      );
    });

    it('carries the new batch columns', async () => {
      const columns = await tableColumnsOf(db, 'multi_chapter_batches');
      expect(columns.has('writing_mode')).toBe(true);
      expect(columns.has('continuation_anchor_json')).toBe(true);
      expect(columns.has('continuation_execution_policy_json')).toBe(true);
      expect(columns.has('execution_profile')).toBe(true);
      const itemColumns = await tableColumnsOf(db, 'multi_chapter_batch_items');
      expect(itemColumns.has('active_continuation_run_id')).toBe(true);
    });

    it('Schema 54 defaults execution_profile to standard (one-shot freeze column)', async () => {
      await createBatch({
        id: 'b54',
        projectId: 1,
        sourcePrompt: '极速批次',
        chapterCount: 1,
        targetWordsPerChapter: 3000,
        pipelineMode: 'full',
        executionProfile: 'one_shot',
      });
      const rows = await db.executeSql(
        `SELECT id, execution_profile FROM multi_chapter_batches
         WHERE id IN ('b54')`,
      );
      expect(rows[0].rows.item(0).execution_profile).toBe('one_shot');
      const batch = await getBatchById('b54');
      expect(batch?.executionProfile).toBe('one_shot');
    });

    it('round-trips a continuation batch with anchor and policy', async () => {
      const anchor = encodeContinuationBatchAnchor({
        schemaVersion: 1,
        sourceId: 7,
        sourceVersion: 3,
        sourceSha256: 'sha-abc',
        boundaryPosition: 119,
        boundaryChapterId: 120,
        boundaryCharOffsetExclusive: 123456,
        canonSnapshotId: 'snap-1',
        canonRevision: 8,
        startingContinuationTailPosition: 3,
        startingContinuationTailChapterId: 42,
      });
      const policy = encodeContinuationBatchExecutionPolicy(
        defaultContinuationBatchExecutionPolicy(),
      );
      await createBatch({
        id: 'batch_ct1',
        projectId: 1,
        sourcePrompt: '本批目标',
        chapterCount: 2,
        targetWordsPerChapter: 3000,
        pipelineMode: 'full',
        writingMode: 'continuation',
        continuationAnchorJson: anchor,
        continuationExecutionPolicyJson: policy,
      });
      const batch = await getBatchById('batch_ct1');
      expect(batch?.writingMode).toBe('continuation');
      expect(batch?.continuationAnchorJson).toBe(anchor);
      expect(batch?.continuationExecutionPolicyJson).toBe(policy);
    });

    it('defaults to outline when writingMode is omitted (legacy callers)', async () => {
      await createBatch({
        id: 'batch_legacy_fresh',
        projectId: 1,
        sourcePrompt: 's',
        chapterCount: 1,
        targetWordsPerChapter: 3000,
        pipelineMode: 'full',
      });
      const batch = await getBatchById('batch_legacy_fresh');
      expect(batch?.writingMode).toBe('outline');
      expect(batch?.continuationAnchorJson).toBeNull();
    });

    it('binds a continuation run exactly once and never onto a pipeline task', async () => {
      await createBatch({
        id: 'batch_bind',
        projectId: 1,
        sourcePrompt: 's',
        chapterCount: 1,
        targetWordsPerChapter: 3000,
        pipelineMode: 'full',
        writingMode: 'continuation',
      });
      await createBatchItem({
        batchId: 'batch_bind',
        ordinal: 1,
        title: '第 1 章',
        synopsis: 's',
        keyBeatsJson: '[]',
        targetWords: 3000,
      });
      // A real chapter row (items.chapter_id has an FK to chapters).
      const now = new Date(0).toISOString();
      await db.executeSql(
        `INSERT INTO chapters (id, project_id, position, title, synopsis, content, status, created_at, updated_at)
         VALUES (99, 1, 0, '第 1 章', 's', '', 'planned', ?, ?)`,
        [now, now],
      );
      await updateBatchItem('batch_bind', 1, { chapterId: 99 });
      const first = await bindContinuationRunForItem({
        batchId: 'batch_bind',
        ordinal: 1,
        chapterId: 99,
        continuationRunId: 'ct_run_1',
      });
      expect(first).toBe(true);
      // Re-bind attempts are rejected (no duplicate binding).
      const second = await bindContinuationRunForItem({
        batchId: 'batch_bind',
        ordinal: 1,
        chapterId: 99,
        continuationRunId: 'ct_run_2',
      });
      expect(second).toBe(false);
      const items = await getBatchItems('batch_bind');
      expect(items[0].activeContinuationRunId).toBe('ct_run_1');
      expect(items[0].activePipelineTaskId).toBeNull();
    });

    it('continuation item success commits counters via the shared adoption commit', async () => {
      await createBatch({
        id: 'batch_commit',
        projectId: 1,
        sourcePrompt: 's',
        chapterCount: 1,
        targetWordsPerChapter: 3000,
        pipelineMode: 'full',
        writingMode: 'continuation',
      });
      await createBatchItem({
        batchId: 'batch_commit',
        ordinal: 1,
        title: '第 1 章',
        synopsis: 's',
        keyBeatsJson: '[]',
        targetWords: 3000,
      });
      await updateBatchStatus('batch_commit', 'running');
      await commitBatchItemAdoption({
        batchId: 'batch_commit',
        ordinal: 1,
        chapterCount: 1,
        completionQuality: 'full_pipeline',
        adoptionFingerprint: 'fp-ct-1',
        adoptedRevisionId: null,
        options: { enforceFingerprintMatch: false },
      });
      let [batch] = [await getBatchById('batch_commit')];
      expect(batch?.status).toBe('completed');
      expect(batch?.completedCount).toBe(1);
      // Idempotent: same fingerprint → no double count.
      await commitBatchItemAdoption({
        batchId: 'batch_commit',
        ordinal: 1,
        chapterCount: 1,
        completionQuality: 'full_pipeline',
        adoptionFingerprint: 'fp-ct-1',
        adoptedRevisionId: null,
      });
      batch = (await getBatchById('batch_commit'))!;
      expect(batch.completedCount).toBe(1);
    });
  });

  describe('upgrade 52 → 53', () => {
    beforeAll(async () => {
      db = await createEmptyInMemoryDb();
      __setDatabaseForTest(db as any);
      // Minimal FK parents for the Schema-42 batch tables.
      await db.executeSql(
        `CREATE TABLE IF NOT EXISTS projects (
           id INTEGER PRIMARY KEY, name TEXT, mode TEXT,
           created_at INTEGER, updated_at INTEGER)`,
      );
      await db.executeSql(
        `CREATE TABLE IF NOT EXISTS chapters (
           id INTEGER PRIMARY KEY, project_id INTEGER, position INTEGER,
           title TEXT, synopsis TEXT, content TEXT, status TEXT,
           created_at TEXT, updated_at TEXT)`,
      );
      await db.executeSql(
        `CREATE TABLE IF NOT EXISTS pipeline_tasks (
           id TEXT PRIMARY KEY, target_type TEXT, target_id INTEGER,
           status TEXT, stage_results TEXT, final_text TEXT, error TEXT,
           created_at INTEGER, updated_at INTEGER, resolved_at INTEGER)`,
      );
      await db.executeSql(
        `INSERT INTO projects (id, name, mode, created_at, updated_at)
         VALUES (1, '升级项目', 'outline', 0, 0)`,
      );
    });

    it('adds the columns to a pre-53 database, backfills outline, and is idempotent', async () => {
      // Build the Schema 42 shape (pre-53, no continuation columns).
      for (const sql of buildSchema42CreateSqls()) {
        await db.executeSql(sql);
      }
      // A legacy outline batch row created BEFORE the upgrade.
      await db.executeSql(
        `INSERT INTO multi_chapter_batches (
           id, project_id, status, source_prompt, chapter_count,
           target_words_per_chapter, pipeline_mode,
           created_at, updated_at
         ) VALUES ('batch_old', 1, 'completed', '旧批次', 2, 3000, 'full', 0, 0)`,
      );
      await db.executeSql(
        `INSERT INTO multi_chapter_batch_items (
           batch_id, ordinal, title, synopsis, key_beats_json,
           carry_in, carry_out, target_words, status, created_at, updated_at
         ) VALUES ('batch_old', 1, 't', 's', '[]', NULL, NULL, 3000, 'succeeded', 0, 0)`,
      );

      await migrateV52ToV53(db as any);

      const columns = await tableColumnsOf(db, 'multi_chapter_batches');
      expect(columns.has('writing_mode')).toBe(true);
      const itemColumns = await tableColumnsOf(db, 'multi_chapter_batch_items');
      expect(itemColumns.has('active_continuation_run_id')).toBe(true);

      // Old rows are readable with their historical semantics intact.
      const [rows] = await db.executeSql(
        'SELECT status, writing_mode FROM multi_chapter_batches WHERE id = ?',
        ['batch_old'],
      ) as any;
      expect(rows.rows.length).toBe(1);
      expect(rows.rows.item(0).writing_mode).toBe('outline');
      expect(rows.rows.item(0).status).toBe('completed');

      const [itemRows] = await db.executeSql(
        'SELECT status, active_continuation_run_id FROM multi_chapter_batch_items WHERE batch_id = ?',
        ['batch_old'],
      ) as any;
      expect(itemRows.rows.item(0).active_continuation_run_id).toBeNull();
      expect(itemRows.rows.item(0).status).toBe('succeeded');

      // Repo mapping reads upgraded rows without drift.
      __setDatabaseForTest(db as any);
      const batch = await getBatchById('batch_old');
      expect(batch?.writingMode).toBe('outline');

      // Idempotent re-run.
      await migrateV52ToV53(db as any);
      const columnsAgain = await tableColumnsOf(db, 'multi_chapter_batches');
      expect(columnsAgain.has('writing_mode')).toBe(true);
    });
  });

  describe('backup manifest (doc §31)', () => {
    it('enumerates the new columns for backup/restore', () => {
      const batches = SCHEMA_MANIFEST.find(
        table => table.name === 'multi_chapter_batches',
      );
      expect(batches?.backup).toBe(true);
      for (const column of [
        'writing_mode',
        'continuation_anchor_json',
        'continuation_execution_policy_json',
      ]) {
        expect(batches?.columns).toContain(column);
      }
      const items = SCHEMA_MANIFEST.find(
        table => table.name === 'multi_chapter_batch_items',
      );
      expect(items?.backup).toBe(true);
      expect(items?.columns).toContain('active_continuation_run_id');
    });
  });
});
