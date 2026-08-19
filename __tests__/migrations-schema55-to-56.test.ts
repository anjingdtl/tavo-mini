/**
 * Phase 4 (二 §7.2) — Schema 55 → 56 migration: `unified_qa` ledger node.
 *
 * The compact Standard continuation driver writes its ONE QA report to the
 * `unified_qa` ledger node. Schema 56 rebuilds
 * `continuation_generation_stage_results` with an extended CHECK so that
 * value is allowed. This test drives the real sql.js path:
 *   - legacy CHECK (no unified_qa) → migrate → CHECK contains unified_qa
 *   - data preserved across the table rebuild
 *   - idempotent: re-running migrateV55ToV56 is a no-op
 *   - fresh-install DDL already carries the extended CHECK
 */
import { createEmptyInMemoryDb, type InMemorySqliteDb } from './helpers/canonInMemoryDb';
import { __resetForTest } from '../src/data/connection/openDatabase';
import { migrateV55ToV56 } from '../src/services/migrations/v55-to-v56';
import { createCurrentSchemaStatements } from '../src/data/schema/createCurrentSchema';

describe('Phase 4 — Schema 55→56 unified_qa CHECK migration', () => {
  let db: InMemorySqliteDb;

  beforeEach(async () => {
    __resetForTest();
    db = await createEmptyInMemoryDb();
  });

  afterEach(() => {
    __resetForTest();
  });

  /** Build a Schema-55-shaped stage_results table (CHECK WITHOUT unified_qa). */
  async function seedLegacyStageResults(): Promise<void> {
    // Parent tables referenced by the stage_results FKs (created by earlier
    // schema versions in a real DB; the v56 rebuild validates them).
    await db.executeSql(`
      CREATE TABLE continuation_generation_runs (
        id TEXT PRIMARY KEY,
        project_id INTEGER NOT NULL,
        chapter_id INTEGER NOT NULL,
        target_position INTEGER NOT NULL,
        source_id INTEGER,
        source_snapshot_json TEXT NOT NULL,
        canon_snapshot_id TEXT,
        canon_revision INTEGER NOT NULL,
        story_memory_fingerprint TEXT NOT NULL,
        story_memory_through_position INTEGER NOT NULL,
        input_revision_hash TEXT NOT NULL,
        user_instruction TEXT NOT NULL,
        settings_snapshot_json TEXT NOT NULL,
        context_snapshot_json TEXT,
        context_trace_json TEXT,
        token_usage_json TEXT NOT NULL DEFAULT '{}',
        state TEXT NOT NULL,
        stage TEXT NOT NULL,
        completion_reason TEXT,
        adopted_revision_hash TEXT,
        finalized_revision_hash TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      )`);
    await db.executeSql(`
      CREATE TABLE continuation_generation_artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        repair_round INTEGER NOT NULL DEFAULT 0,
        parent_artifact_id TEXT,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        eligibility_status TEXT NOT NULL DEFAULT 'eligible',
        rejection_code TEXT,
        created_at TEXT NOT NULL
      )`);
    await db.executeSql(`
      CREATE TABLE llm_config (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        model_name TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        context_window INTEGER,
        max_output_tokens INTEGER
      )`);
    await db.executeSql(`
      CREATE TABLE continuation_generation_stage_results (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        status TEXT NOT NULL,
        request_reserved INTEGER NOT NULL DEFAULT 0,
        request_count INTEGER NOT NULL DEFAULT 0,
        model_config_id INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        min_output_tokens INTEGER,
        max_output_tokens INTEGER,
        output_json TEXT,
        artifact_id TEXT,
        error_code TEXT,
        error_message TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(stage IN ('draft_writer','narrative_architect','revision_writer',
          'adversarial_auditor','final_reviser','final_validate')),
        CHECK(status IN ('queued','running','success','failed','interrupted','skipped')),
        UNIQUE(run_id, stage),
        FOREIGN KEY(run_id) REFERENCES continuation_generation_runs(id) ON DELETE CASCADE,
        FOREIGN KEY(model_config_id) REFERENCES llm_config(id) ON DELETE SET NULL,
        FOREIGN KEY(artifact_id) REFERENCES continuation_generation_artifacts(id) ON DELETE SET NULL
      )`);
    await db.executeSql(`
      INSERT INTO continuation_generation_runs
        (id, project_id, chapter_id, target_position, source_snapshot_json,
         canon_revision, story_memory_fingerprint, story_memory_through_position,
         input_revision_hash, user_instruction, settings_snapshot_json, state,
         stage, token_usage_json, created_at, updated_at)
      VALUES
        ('run1', 1, 1, 0, '{}', 1, 'f', 0, 'h', '', '{}', 'completed', 'completed',
         '{}', 't1', 't1')`);
    await db.executeSql(`
      INSERT INTO continuation_generation_stage_results
        (id, run_id, stage, status, request_reserved, request_count,
         created_at, updated_at)
      VALUES
        ('sr1','run1','draft_writer','success',0,1,'t1','t1'),
        ('sr2','run1','adversarial_auditor','success',0,1,'t1','t1')`);
  }

  test('migration extends the stage CHECK with unified_qa and keeps rows', async () => {
    await seedLegacyStageResults();
    await migrateV55ToV56(db as any);

    const [probe] = await db.executeSql(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='continuation_generation_stage_results'",
    );
    const sql = String(probe.rows.item(0).sql);
    expect(sql).toContain("'unified_qa'");
    expect(sql).toContain("'adversarial_auditor'");

    const [rows] = await db.executeSql(
      'SELECT id, stage FROM continuation_generation_stage_results ORDER BY id',
    );
    expect(rows.rows.length).toBe(2);
    expect(rows.rows.item(0).stage).toBe('draft_writer');
    expect(rows.rows.item(1).stage).toBe('adversarial_auditor');
  });

  test('new node is insertable after migration', async () => {
    await seedLegacyStageResults();
    await migrateV55ToV56(db as any);
    await db.executeSql(`
      INSERT INTO continuation_generation_stage_results
        (id, run_id, stage, status, request_reserved, request_count,
         created_at, updated_at)
      VALUES
        ('sr3','run1','unified_qa','success',0,1,'t1','t1')`);
    const [rows] = await db.executeSql(
      "SELECT stage FROM continuation_generation_stage_results WHERE id='sr3'",
    );
    expect(rows.rows.item(0).stage).toBe('unified_qa');
  });

  test('migration is idempotent (probe short-circuits on second run)', async () => {
    await seedLegacyStageResults();
    await migrateV55ToV56(db as any);
    await migrateV55ToV56(db as any);
    const [rows] = await db.executeSql(
      'SELECT COUNT(*) AS n FROM continuation_generation_stage_results',
    );
    expect(Number(rows.rows.item(0).n)).toBe(2);
  });

  test('drifted DB without the continuation table is skipped, not crashed', async () => {
    // Minimal schema-50-shaped DB (no continuation V5 tables) must migrate
    // past 55→56 without "no such table" (regression found by
    // migrations-v50-v51 running the full chain against a partial seed).
    await migrateV55ToV56(db as any);
    const [probe] = await db.executeSql(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='continuation_generation_stage_results'",
    );
    expect(probe.rows.length).toBe(0);
  });

  test('fresh-install DDL already carries the extended CHECK', () => {
    const ddl = createCurrentSchemaStatements().join('\n');
    expect(ddl).toContain("'unified_qa'");
    const rebuildIndex = ddl.indexOf('continuation_generation_stage_results__v56');
    const baseIndex = ddl.indexOf(
      'CREATE TABLE IF NOT EXISTS continuation_generation_stage_results',
    );
    // The v56 rebuild must come AFTER the base table creation in the fresh DDL.
    expect(rebuildIndex).toBeGreaterThan(baseIndex);
  });
});
