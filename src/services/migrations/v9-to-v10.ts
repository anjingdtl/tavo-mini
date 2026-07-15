import type SQLite from 'react-native-sqlite-storage';
import { applyMigration, tableColumns } from './helpers';
import type { SqlStatement } from '../database/transaction';

export async function buildV9toV10Statements(
  database: SQLite.SQLiteDatabase,
): Promise<SqlStatement[]> {
  const columns = await tableColumns(database, 'llm_usage_logs');
  const statements: SqlStatement[] = [];
  if (!columns.has('llm_config_id')) {
    statements.push({
      sql: 'ALTER TABLE llm_usage_logs ADD COLUMN llm_config_id INTEGER NOT NULL DEFAULT 0',
    });
  }
  if (!columns.has('llm_config_name')) {
    statements.push({
      sql: "ALTER TABLE llm_usage_logs ADD COLUMN llm_config_name TEXT NOT NULL DEFAULT ''",
    });
  }
  statements.push({
    sql: `CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_config
      ON llm_usage_logs(llm_config_id, created_at)`,
  });
  return statements;
}

/** Backward-compatible direct entry point for migration unit tests. */
export async function migrateV9toV10(
  database: SQLite.SQLiteDatabase,
): Promise<void> {
  await applyMigration(database, await buildV9toV10Statements(database));
}
