import {
  createCanonInMemoryDb,
  createEmptyInMemoryDb,
} from './helpers/canonInMemoryDb';
import {
  migrateV50ToV51,
  V51_LLM_USAGE_LOGS_COLUMNS,
  V51_PIPELINE_STAGE_ATTEMPTS_COLUMNS,
} from '../src/services/migrations/v50-to-v51';
import { runMigrations, SCHEMA_VERSION } from '../src/services/migrations';

// Schema-50 shape of llm_usage_logs (before the Schema 51 cache columns).
const LLM_USAGE_LOGS_DDL_V50 = `
  CREATE TABLE llm_usage_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scenario TEXT NOT NULL DEFAULT '',
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT '',
    error_code TEXT NOT NULL DEFAULT '',
    model_name TEXT NOT NULL DEFAULT '',
    project_id INTEGER NOT NULL DEFAULT 0,
    llm_config_id INTEGER NOT NULL DEFAULT 0,
    llm_config_name TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`;

// Schema-50 shape of pipeline_stage_attempts (before the Schema 51 cache
// columns). Kept minimal — the migration only needs the table to exist so the
// idempotent ALTERs can run.
const PIPELINE_STAGE_ATTEMPTS_DDL_V50 = `
  CREATE TABLE pipeline_stage_attempts (
    id TEXT PRIMARY KEY,
    pipeline_task_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    attempt_no INTEGER NOT NULL,
    request_version INTEGER NOT NULL DEFAULT 1,
    request_fingerprint TEXT NOT NULL DEFAULT '',
    input_tokens INTEGER,
    output_tokens INTEGER,
    total_tokens INTEGER,
    reasoning_tokens INTEGER,
    status TEXT NOT NULL DEFAULT 'started'
  )`;

async function tableColumnNames(db: any, table: string): Promise<Set<string>> {
  const [result] = await db.executeSql(`PRAGMA table_info(${table})`);
  return new Set(result.rows.raw().map((row: any) => row.name));
}

describe('Schema 50 → 51 prompt-cache telemetry', () => {
  test('upgrades both target tables and remains idempotent', async () => {
    const db = await createEmptyInMemoryDb();
    try {
      await db.executeSql('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
      await db.executeSql(LLM_USAGE_LOGS_DDL_V50);
      await db.executeSql(PIPELINE_STAGE_ATTEMPTS_DDL_V50);
      await db.executeSql(
        "INSERT INTO settings (key, value) VALUES ('schema_version', '50')",
      );
      // Seed historical rows (pre-telemetry) — must survive the migration.
      await db.executeSql(
        `INSERT INTO llm_usage_logs (scenario, input_tokens, output_tokens, total_tokens, status, model_name, project_id, created_at)
         VALUES ('chat', 100, 20, 120, 'success', 'deepseek-v4-flash', 1, '2026-08-11')`,
      );
      await db.executeSql(
        `INSERT INTO pipeline_stage_attempts (id, pipeline_task_id, stage, attempt_no, request_fingerprint, input_tokens, output_tokens, total_tokens, status)
         VALUES ('t1:draft:1', 't1', 'draft', 1, 'fp', 100, 20, 120, 'succeeded')`,
      );

      const result = await runMigrations(db as any, 50);
      expect(result).toMatchObject({
        fromVersion: 50,
        toVersion: SCHEMA_VERSION,
        migrationsRun: SCHEMA_VERSION - 50,
        hadBreaking: false,
      });

      // Idempotent: running the migration again must not throw.
      await migrateV50ToV51(db as any);
      await migrateV50ToV51(db as any);

      const usageNames = await tableColumnNames(db, 'llm_usage_logs');
      for (const column of V51_LLM_USAGE_LOGS_COLUMNS) {
        expect(usageNames.has(column.name)).toBe(true);
      }
      const attemptNames = await tableColumnNames(
        db,
        'pipeline_stage_attempts',
      );
      for (const column of V51_PIPELINE_STAGE_ATTEMPTS_COLUMNS) {
        expect(attemptNames.has(column.name)).toBe(true);
      }

      // Historical rows preserved with NULL cache telemetry (never backfilled).
      const [usageRow] = await db.executeSql(
        'SELECT scenario, model_name, prompt_cache_hit_tokens, prompt_cache_miss_tokens FROM llm_usage_logs WHERE id = 1',
      );
      expect(usageRow.rows.item(0)).toEqual({
        scenario: 'chat',
        model_name: 'deepseek-v4-flash',
        prompt_cache_hit_tokens: null,
        prompt_cache_miss_tokens: null,
      });
      const [attemptRow] = await db.executeSql(
        'SELECT request_fingerprint, prompt_cache_hit_tokens, prompt_cache_miss_tokens FROM pipeline_stage_attempts WHERE id = ?',
        ['t1:draft:1'],
      );
      expect(attemptRow.rows.item(0)).toEqual({
        request_fingerprint: 'fp',
        prompt_cache_hit_tokens: null,
        prompt_cache_miss_tokens: null,
      });

      const [version] = await db.executeSql(
        "SELECT value FROM settings WHERE key = 'schema_version'",
      );
      expect(version.rows.item(0).value).toBe(String(SCHEMA_VERSION));
    } finally {
      db.close();
    }
  });

  test('fresh-install schema contains the Schema 51 cache columns', async () => {
    const db = await createCanonInMemoryDb();
    try {
      const usageNames = await tableColumnNames(db, 'llm_usage_logs');
      expect(usageNames.has('prompt_cache_hit_tokens')).toBe(true);
      expect(usageNames.has('prompt_cache_miss_tokens')).toBe(true);

      const attemptNames = await tableColumnNames(
        db,
        'pipeline_stage_attempts',
      );
      expect(attemptNames.has('prompt_cache_hit_tokens')).toBe(true);
      expect(attemptNames.has('prompt_cache_miss_tokens')).toBe(true);
    } finally {
      db.close();
    }
  });

  test('forbidden tables are untouched (no cache columns added)', async () => {
    const db = await createCanonInMemoryDb();
    try {
      // story_memory_request_attempts must remain transport-only metadata.
      const smNames = await tableColumnNames(
        db,
        'story_memory_request_attempts',
      );
      expect(smNames.has('prompt_cache_hit_tokens')).toBe(false);
      expect(smNames.has('prompt_cache_miss_tokens')).toBe(false);
      // No prompt/body/key/reasoning columns ever.
      expect(smNames.has('prompt')).toBe(false);
      expect(smNames.has('body')).toBe(false);
      expect(smNames.has('api_key')).toBe(false);
      expect(smNames.has('reasoning')).toBe(false);

      // pipeline_tasks must not gain cache columns.
      const taskNames = await tableColumnNames(db, 'pipeline_tasks');
      expect(taskNames.has('prompt_cache_hit_tokens')).toBe(false);
      expect(taskNames.has('prompt_cache_miss_tokens')).toBe(false);

      // chapters must not gain cache columns.
      const chapterNames = await tableColumnNames(db, 'chapters');
      expect(chapterNames.has('prompt_cache_hit_tokens')).toBe(false);
      expect(chapterNames.has('prompt_cache_miss_tokens')).toBe(false);
    } finally {
      db.close();
    }
  });

  test('no new cache indexes are introduced (aggregation-only columns)', async () => {
    const db = await createCanonInMemoryDb();
    try {
      const [result] = await db.executeSql(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('llm_usage_logs', 'pipeline_stage_attempts')",
      );
      const indexNames = new Set(
        result.rows.raw().map((row: any) => row.name),
      );
      const cacheIndexCandidates = [...indexNames].filter(name =>
        /cache/i.test(name),
      );
      expect(cacheIndexCandidates).toEqual([]);
    } finally {
      db.close();
    }
  });
});
