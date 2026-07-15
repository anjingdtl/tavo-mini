import type SQLite from 'react-native-sqlite-storage';
import { applyMigration, tableColumns } from './helpers';
import type { SqlStatement } from '../database/transaction';

export async function buildV11toV12Statements(
  database: SQLite.SQLiteDatabase,
): Promise<SqlStatement[]> {
  const columns = await tableColumns(database, 'llm_config');
  const statements: SqlStatement[] = [
    {
      sql: `CREATE TABLE IF NOT EXISTS local_llm_models (
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
      )`,
    },
    {
      sql: 'CREATE INDEX IF NOT EXISTS idx_local_llm_models_status ON local_llm_models(status)',
    },
    {
      sql: 'CREATE INDEX IF NOT EXISTS idx_local_llm_models_last_used ON local_llm_models(last_used_at)',
    },
  ];
  if (!columns.has('provider_type')) {
    statements.push({
      sql: "ALTER TABLE llm_config ADD COLUMN provider_type TEXT NOT NULL DEFAULT 'openai_compatible'",
    });
  }
  if (!columns.has('local_model_id')) {
    statements.push({
      sql: 'ALTER TABLE llm_config ADD COLUMN local_model_id TEXT',
    });
  }
  if (!columns.has('local_backend')) {
    statements.push({
      sql: 'ALTER TABLE llm_config ADD COLUMN local_backend TEXT',
    });
  }
  if (!columns.has('context_window')) {
    statements.push({
      sql: 'ALTER TABLE llm_config ADD COLUMN context_window INTEGER NOT NULL DEFAULT 4096',
    });
  }
  if (!columns.has('max_output_tokens')) {
    statements.push({
      sql: 'ALTER TABLE llm_config ADD COLUMN max_output_tokens INTEGER NOT NULL DEFAULT 4000',
    });
  }
  return statements;
}

/** Backward-compatible direct entry point for migration unit tests. */
export async function migrateV11toV12(
  database: SQLite.SQLiteDatabase,
): Promise<void> {
  await applyMigration(database, await buildV11toV12Statements(database));
}
