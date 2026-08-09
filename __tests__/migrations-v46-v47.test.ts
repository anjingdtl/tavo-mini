import { createEmptyInMemoryDb } from './helpers/canonInMemoryDb';
import { __resetForTest, __setDatabaseForTest } from '../src/data/connection/openDatabase';
import { PIPELINE_STAGE_ATTEMPTS_DDL } from '../src/services/migrations/v40-to-v41';
import {
  V31_ATTEMPT_DIAGNOSTIC_COLUMNS,
  migrateV46ToV47,
} from '../src/services/migrations/v46-to-v47';
import { runMigrations, SCHEMA_VERSION } from '../src/services/migrations';

describe('Schema 46 → 47 V3.1 fail-closed recovery migration', () => {
  afterEach(() => {
    __resetForTest();
  });

  async function seed() {
    const db = await createEmptyInMemoryDb();
    __setDatabaseForTest(db as any);
    await db.executeSql(`
      CREATE TABLE pipeline_tasks (
        id TEXT PRIMARY KEY,
        outline_workflow_version INTEGER NOT NULL DEFAULT 1,
        context_budget_version INTEGER NOT NULL DEFAULT 1,
        pipeline_context_json TEXT,
        stage_results TEXT NOT NULL DEFAULT '[]'
      )
    `);
    await db.executeSql(`
      CREATE TABLE pipeline_stage_checkpoints (
        task_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        status TEXT NOT NULL,
        PRIMARY KEY (task_id, stage)
      )
    `);
    await db.executeSql(PIPELINE_STAGE_ATTEMPTS_DDL);
    await db.executeSql('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
    await db.executeSql(
      `INSERT INTO pipeline_tasks
        (id, outline_workflow_version, context_budget_version, pipeline_context_json)
       VALUES
        ('old-v3', 3, 3, ?),
        ('new-v31', 3, 3, ?),
        ('keep-v2', 2, 2, ?)` ,
      [
        JSON.stringify({ version: 3, execution: { reasoningProfileVersion: 2 } }),
        JSON.stringify({ version: 3, execution: { reasoningProfileVersion: 3 } }),
        JSON.stringify({ version: 2, execution: { reasoningProfileVersion: 2 } }),
      ],
    );
    for (const taskId of ['old-v3', 'new-v31', 'keep-v2']) {
      await db.executeSql(
        `INSERT INTO pipeline_stage_checkpoints (task_id, stage, status)
         VALUES (?, 'review', 'succeeded')`,
        [taskId],
      );
      await db.executeSql(
        `INSERT INTO pipeline_stage_attempts
          (id, pipeline_task_id, stage, attempt_no, request_fingerprint,
           llm_config_snapshot_json, client_request_id, status, started_at)
         VALUES (?, ?, 'review', 1, 'fp', '{}', ?, 'succeeded', 1)`,
        [`${taskId}:review:1`, taskId, `${taskId}:client`],
      );
    }
    return db;
  }

  test('removes only old V3/profile2 chains and adds diagnostics atomically', async () => {
    const db = await seed();
    await migrateV46ToV47(db as any);
    await migrateV46ToV47(db as any);

    const [tasks] = await db.executeSql(
      'SELECT id FROM pipeline_tasks ORDER BY id',
    );
    expect(tasks.rows.raw().map((row: any) => row.id)).toEqual([
      'keep-v2',
      'new-v31',
    ]);
    const [attempts] = await db.executeSql(
      'SELECT pipeline_task_id FROM pipeline_stage_attempts ORDER BY pipeline_task_id',
    );
    expect(attempts.rows.raw().map((row: any) => row.pipeline_task_id)).toEqual([
      'keep-v2',
      'new-v31',
    ]);
    const [columns] = await db.executeSql(
      'PRAGMA table_info(pipeline_stage_attempts)',
    );
    const names = new Set(columns.rows.raw().map((row: any) => row.name));
    for (const column of V31_ATTEMPT_DIAGNOSTIC_COLUMNS) {
      expect(names.has(column.name)).toBe(true);
    }
  });

  test('schema runner requests backup before the breaking cleanup', async () => {
    const db = await seed();
    const backup = jest.fn(async () => 'schema-recovery/test.json');
    const result = await runMigrations(db as any, 46, backup);
    expect(SCHEMA_VERSION).toBe(48);
    expect(backup).toHaveBeenCalledTimes(1);
    expect(result.hadBreaking).toBe(true);
    expect(result.backupPath).toBe('schema-recovery/test.json');
    const [taskColumns] = await db.executeSql('PRAGMA table_info(pipeline_tasks)');
    const taskColumnNames = new Set(
      taskColumns.rows.raw().map((row: any) => row.name),
    );
    expect(taskColumnNames.has('parent_task_id')).toBe(true);
    expect(taskColumnNames.has('derived_kind')).toBe(true);
    expect(taskColumnNames.has('derived_instruction')).toBe(true);
    const [indexes] = await db.executeSql(
      `SELECT name FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_pipeline_tasks_parent_task'`,
    );
    expect(indexes.rows.length).toBe(1);
  });
});
