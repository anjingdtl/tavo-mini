/**
 * Schema 43 → 44: pipeline task / batch version-freeze columns.
 *
 * Matrix (real sql.js SQLite, real `initializeDatabase` upgrade chain):
 *   M1  old pipeline_tasks rows get outline_workflow_version=1 / context_budget_version=1
 *   M2  old multi_chapter_batches rows get the same defaults
 *   M3  physically column-less (Schema 43 shape) tables are repaired with the columns
 *   M4  migration is idempotent when re-run
 *   M5  upgrade preserves every other table byte-identical
 *   M6  fresh-install DDL already carries the version columns
 *   M7  explicit INSERT of version=2 survives (new tasks freeze V2)
 */
import { createCanonInMemoryDb, createEmptyInMemoryDb } from './helpers/canonInMemoryDb';
import type { InMemorySqliteDb } from './helpers/canonInMemoryDb';
import { __setDatabaseForTest, __resetForTest } from '../src/data/connection/openDatabase';
import { initializeDatabase } from '../src/services/database';
import { SCHEMA_VERSION } from '../src/services/migrations';
import {
  buildV43toV44Statements,
  migrateV43ToV44,
  OUTLINE_WORKFLOW_VERSION_COLUMN,
  CONTEXT_BUDGET_VERSION_COLUMN,
} from '../src/services/migrations/v43-to-v44';

const T = '2026-08-01T00:00:00.000Z';

describe('Schema 43 → 44 version-freeze columns', () => {
  it('reports SCHEMA_VERSION >= 44', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(44);
  });

  it('builds 4 ALTER statements defaulting to 1 (Legacy)', () => {
    const stmts = buildV43toV44Statements();
    expect(stmts.length).toBe(4);
    const sqls = stmts.map(s => s.sql);
    for (const sql of sqls) {
      expect(sql).toContain('ALTER TABLE');
      expect(sql).toContain('NOT NULL DEFAULT 1');
    }
    expect(sqls.join('\n')).toContain('ALTER TABLE pipeline_tasks');
    expect(sqls.join('\n')).toContain('ALTER TABLE multi_chapter_batches');
  });

  it('fresh-install DDL already carries the version columns (M6)', () => {
    const {
      createCurrentSchemaStatements,
    } = require('../src/data/schema/createCurrentSchema');
    const sqls = createCurrentSchemaStatements().join('\n');
    expect(sqls).toContain('outline_workflow_version INTEGER NOT NULL DEFAULT 1');
    expect(sqls).toContain('context_budget_version INTEGER NOT NULL DEFAULT 1');
  });
});

describe('Schema 43 → 44 upgrade chain (real sql.js)', () => {
  let db: InMemorySqliteDb;

  beforeEach(async () => {
    __resetForTest();
    db = await createCanonInMemoryDb();
    __setDatabaseForTest(db as any);
    await db.executeSql(
      `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (0, '__tavo_global_workspace__', 'outline', ?, ?)`,
      [T, T],
    );
    await db.executeSql(
      `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, '小说A', 'outline', ?, ?)`,
      [T, T],
    );
    await db.executeSql(
      `INSERT INTO chapters (id, project_id, position, title, content, status, created_at, updated_at)
       VALUES (1, 1, 1, '第一章', '第一章正文内容', 'finalized', ?, ?)`,
      [T, T],
    );
    await db.executeSql(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '43')",
    );
    await db.executeSql(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('app_version', '2.11.38')",
    );
  });

  afterEach(() => {
    __resetForTest();
    try {
      db.close();
    } catch {
      /* ignore */
    }
  });

  async function seedLegacyTaskAndBatch(): Promise<void> {
    // INSERT without the version columns → DB defaults (1) apply, exactly
    // like every pre-upgrade row.
    await db.executeSql(
      `INSERT INTO pipeline_tasks (id, target_type, target_id, status, created_at, updated_at)
       VALUES ('task-legacy-1', 'chapter', 1, 'interrupted', ?, ?)`,
      [Date.now(), Date.now()],
    );
    await db.executeSql(
      `INSERT INTO multi_chapter_batches
        (id, project_id, status, source_prompt, chapter_count, target_words_per_chapter,
         pipeline_mode, planner_hash, current_ordinal, completed_count,
         used_llm_calls, used_input_tokens, used_output_tokens, row_version, created_at, updated_at)
       VALUES ('batch-legacy-1', 1, 'running', '写十章', 10, 2000, 'full',
               'planner-hash', 3, 2, 5, 100, 50, 1, ?, ?)`,
      [Date.now(), Date.now()],
    );
  }

  async function readColumns(table: string): Promise<Set<string>> {
    const [res] = await db.executeSql(`PRAGMA table_info(${table})`);
    const out = new Set<string>();
    for (let i = 0; i < res.rows.length; i += 1) {
      out.add(res.rows.item(i).name as string);
    }
    return out;
  }

  // M1 + M2: legacy rows get version 1 after the upgrade.
  it('M1/M2 legacy task and batch rows read version 1 after upgrade', async () => {
    await seedLegacyTaskAndBatch();
    await initializeDatabase(db as any);

    const [taskRows] = await db.executeSql(
      `SELECT outline_workflow_version, context_budget_version FROM pipeline_tasks WHERE id = 'task-legacy-1'`,
    );
    expect(Number(taskRows.rows.item(0).outline_workflow_version)).toBe(1);
    expect(Number(taskRows.rows.item(0).context_budget_version)).toBe(1);

    const [batchRows] = await db.executeSql(
      `SELECT outline_workflow_version, context_budget_version FROM multi_chapter_batches WHERE id = 'batch-legacy-1'`,
    );
    expect(Number(batchRows.rows.item(0).outline_workflow_version)).toBe(1);
    expect(Number(batchRows.rows.item(0).context_budget_version)).toBe(1);

    expect(
      Number((await db.executeSql("SELECT value FROM settings WHERE key = 'schema_version'"))[0].rows.item(0).value),
    ).toBe(SCHEMA_VERSION);
  });

  // M3: physically column-less tables are repaired (true Schema-43 DB shape).
  it('M3 column-less pipeline_tasks / batches are repaired with defaults', async () => {
    const raw = await createEmptyInMemoryDb();
    __resetForTest();
    __setDatabaseForTest(raw as any);
    // Schema 43 physical shape: no version columns.
    await raw.executeSql(`
      CREATE TABLE pipeline_tasks (
        id TEXT PRIMARY KEY,
        target_type TEXT NOT NULL,
        target_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle',
        stage_results TEXT NOT NULL DEFAULT '[]',
        final_text TEXT,
        error TEXT,
        input_fingerprint TEXT,
        pipeline_context_json TEXT,
        pipeline_context_version INTEGER,
        pipeline_context_hash TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        resolved_at INTEGER,
        resolved_action TEXT
      )`);
    await raw.executeSql(`
      CREATE TABLE multi_chapter_batches (
        id TEXT PRIMARY KEY,
        project_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        source_prompt TEXT NOT NULL,
        chapter_count INTEGER NOT NULL,
        target_words_per_chapter INTEGER NOT NULL,
        pipeline_mode TEXT NOT NULL,
        current_ordinal INTEGER NOT NULL DEFAULT 1,
        completed_count INTEGER NOT NULL DEFAULT 0,
        used_llm_calls INTEGER NOT NULL DEFAULT 0,
        used_input_tokens INTEGER NOT NULL DEFAULT 0,
        used_output_tokens INTEGER NOT NULL DEFAULT 0,
        row_version INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
    await raw.executeSql(
      `INSERT INTO pipeline_tasks (id, target_type, target_id, status, created_at, updated_at)
       VALUES ('t1', 'chapter', 1, 'idle', ?, ?)`,
      [1, 1],
    );
    await raw.executeSql(
      `INSERT INTO multi_chapter_batches
        (id, project_id, status, source_prompt, chapter_count, target_words_per_chapter,
         pipeline_mode, created_at, updated_at)
       VALUES ('b1', 1, 'draft', 'p', 3, 2000, 'full', ?, ?)`,
      [1, 1],
    );
    await migrateV43ToV44(raw as any);

    const taskCols = await readColumns('pipeline_tasks');
    expect(taskCols.has(OUTLINE_WORKFLOW_VERSION_COLUMN)).toBe(true);
    expect(taskCols.has(CONTEXT_BUDGET_VERSION_COLUMN)).toBe(true);
    const batchCols = await readColumns('multi_chapter_batches');
    expect(batchCols.has(OUTLINE_WORKFLOW_VERSION_COLUMN)).toBe(true);
    expect(batchCols.has(CONTEXT_BUDGET_VERSION_COLUMN)).toBe(true);

    const [t] = await raw.executeSql(
      `SELECT outline_workflow_version, context_budget_version FROM pipeline_tasks WHERE id = 't1'`,
    );
    expect(Number(t.rows.item(0).outline_workflow_version)).toBe(1);
    expect(Number(t.rows.item(0).context_budget_version)).toBe(1);
    const [b] = await raw.executeSql(
      `SELECT outline_workflow_version, context_budget_version FROM multi_chapter_batches WHERE id = 'b1'`,
    );
    expect(Number(b.rows.item(0).outline_workflow_version)).toBe(1);
    expect(Number(b.rows.item(0).context_budget_version)).toBe(1);
  });

  // M4: re-running the logic migration is a no-op.
  it('M4 migration is idempotent when re-run', async () => {
    const raw = await createEmptyInMemoryDb();
    __resetForTest();
    __setDatabaseForTest(raw as any);
    await raw.executeSql(`
      CREATE TABLE pipeline_tasks (
        id TEXT PRIMARY KEY,
        target_type TEXT NOT NULL,
        target_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle',
        stage_results TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
    await raw.executeSql(`
      CREATE TABLE multi_chapter_batches (
        id TEXT PRIMARY KEY,
        project_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        source_prompt TEXT NOT NULL,
        chapter_count INTEGER NOT NULL,
        target_words_per_chapter INTEGER NOT NULL,
        pipeline_mode TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
    await migrateV43ToV44(raw as any);
    // Second run must not throw ("column already exists").
    await expect(migrateV43ToV44(raw as any)).resolves.toBeUndefined();
    const cols = await readColumns('pipeline_tasks');
    expect(cols.has(OUTLINE_WORKFLOW_VERSION_COLUMN)).toBe(true);
    expect(cols.has(CONTEXT_BUDGET_VERSION_COLUMN)).toBe(true);
  });

  // M5: upgrade preserves every other table byte-identical.
  it('M5 other tables stay byte-identical across the upgrade', async () => {
    await seedLegacyTaskAndBatch();
    await db.executeSql(
      `INSERT INTO pipeline_stage_attempts
        (id, pipeline_task_id, stage, attempt_no, request_fingerprint,
         llm_config_snapshot_json, client_request_id, status, started_at)
       VALUES ('att-1', 'task-legacy-1', 'draft', 1, 'fp', '{}', 'cr-1', 'succeeded', ?)`,
      [Date.now()],
    );
    await db.executeSql(
      `INSERT INTO pipeline_stage_checkpoints
        (task_id, stage, status, updated_at, attempt_count)
       VALUES ('task-legacy-1', 'draft', 'succeeded', ?, 1)`,
      [Date.now()],
    );

    const snapshotTables = async (): Promise<Record<string, string>> => {
      const out: Record<string, string> = {};
      for (const table of [
        'projects',
        'chapters',
        'pipeline_tasks',
        'pipeline_stage_checkpoints',
        'pipeline_stage_attempts',
        'multi_chapter_batches',
      ]) {
        const [res] = await db.executeSql(`SELECT * FROM ${table} ORDER BY 1`);
        out[table] = JSON.stringify(res.rows.raw());
      }
      return out;
    };

    const before = await snapshotTables();
    await initializeDatabase(db as any);
    const after = await snapshotTables();
    // The two version columns are the ONLY additions; the pre-upgrade rows
    // already read 1 via defaults, so even the task/batch rows are stable.
    for (const table of Object.keys(before)) {
      expect(after[table]).toBe(before[table]);
    }
  });

  // M7: explicit V2 INSERT survives (new tasks freeze V2).
  it('M7 explicit version=2 INSERT is preserved and re-readable', async () => {
    await initializeDatabase(db as any);
    await db.executeSql(
      `INSERT INTO pipeline_tasks
        (id, target_type, target_id, status, outline_workflow_version,
         context_budget_version, created_at, updated_at)
       VALUES ('task-v2-1', 'chapter', 1, 'idle', 2, 2, ?, ?)`,
      [Date.now(), Date.now()],
    );
    const [rows] = await db.executeSql(
      `SELECT outline_workflow_version, context_budget_version FROM pipeline_tasks WHERE id = 'task-v2-1'`,
    );
    expect(Number(rows.rows.item(0).outline_workflow_version)).toBe(2);
    expect(Number(rows.rows.item(0).context_budget_version)).toBe(2);
  });
});
