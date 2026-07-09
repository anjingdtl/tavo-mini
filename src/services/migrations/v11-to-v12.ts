import type SQLite from 'react-native-sqlite-storage';

async function execute(db: SQLite.SQLiteDatabase, sql: string, params: any[] = []) {
  const [result] = await db.executeSql(sql, params);
  return result;
}

async function tableColumns(db: SQLite.SQLiteDatabase, table: string): Promise<Set<string>> {
  const result = await execute(db, `PRAGMA table_info(${table})`);
  const columns = new Set<string>();
  for (let i = 0; i < result.rows.length; i += 1) {
    columns.add(result.rows.item(i).name);
  }
  return columns;
}

export async function migrateV11toV12(db: SQLite.SQLiteDatabase): Promise<void> {
  await execute(db, `
    CREATE TABLE IF NOT EXISTS local_llm_models (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      relative_path TEXT NOT NULL UNIQUE,
      file_size INTEGER NOT NULL DEFAULT 0,
      sha256 TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'importing',
      backend_preference TEXT NOT NULL DEFAULT 'auto',
      validated_backend TEXT,
      context_length INTEGER,
      max_output_tokens INTEGER,
      load_time_ms INTEGER,
      first_token_ms INTEGER,
      tokens_per_second REAL,
      imported_at TEXT NOT NULL,
      last_used_at TEXT,
      last_validated_at TEXT,
      error_code TEXT,
      error_message TEXT
    )
  `);

  await execute(db, `
    CREATE INDEX IF NOT EXISTS idx_local_llm_models_status
    ON local_llm_models(status)
  `);
  await execute(db, `
    CREATE INDEX IF NOT EXISTS idx_local_llm_models_last_used
    ON local_llm_models(last_used_at)
  `);

  const columns = await tableColumns(db, 'llm_config');
  if (!columns.has('provider_type')) {
    await execute(db, "ALTER TABLE llm_config ADD COLUMN provider_type TEXT NOT NULL DEFAULT 'openai_compatible'");
  }
  if (!columns.has('local_model_id')) {
    await execute(db, 'ALTER TABLE llm_config ADD COLUMN local_model_id TEXT');
  }
  if (!columns.has('local_backend')) {
    await execute(db, 'ALTER TABLE llm_config ADD COLUMN local_backend TEXT');
  }
  if (!columns.has('context_window')) {
    await execute(db, 'ALTER TABLE llm_config ADD COLUMN context_window INTEGER NOT NULL DEFAULT 4096');
  }
  if (!columns.has('max_output_tokens')) {
    await execute(db, 'ALTER TABLE llm_config ADD COLUMN max_output_tokens INTEGER NOT NULL DEFAULT 4000');
  }
}
