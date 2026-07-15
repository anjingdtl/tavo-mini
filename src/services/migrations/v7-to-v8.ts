import type SQLite from 'react-native-sqlite-storage';
import { applyMigration, tableColumns } from './helpers';
import type { SqlStatement } from '../database/transaction';

export async function buildV7toV8Statements(
  database: SQLite.SQLiteDatabase,
): Promise<SqlStatement[]> {
  const columns = await tableColumns(database, 'llm_usage_logs');
  const statements: SqlStatement[] = [];
  if (!columns.has('model_name')) {
    statements.push({
      sql: "ALTER TABLE llm_usage_logs ADD COLUMN model_name TEXT NOT NULL DEFAULT ''",
    });
  }
  if (!columns.has('project_id')) {
    statements.push({
      sql: 'ALTER TABLE llm_usage_logs ADD COLUMN project_id INTEGER NOT NULL DEFAULT 0',
    });
  }
  statements.push({
    sql: `CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_month
      ON llm_usage_logs(project_id, created_at)`,
  });
  return statements;
}

/** Backward-compatible direct entry point for migration unit tests. */
export async function migrateV7toV8(
  database: SQLite.SQLiteDatabase,
): Promise<void> {
  await applyMigration(database, await buildV7toV8Statements(database));
}
