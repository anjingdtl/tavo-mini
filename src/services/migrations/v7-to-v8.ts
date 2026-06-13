import type SQLite from 'react-native-sqlite-storage';

async function execute(db: SQLite.SQLiteDatabase, sql: string, params: any[] = []) {
  const [result] = await db.executeSql(sql, params);
  return result;
}

// NOTE: The model_name and project_id columns on llm_usage_logs are added by
// ensureSchemaCompatibility() (which runs before migrations) using PRAGMA-based
// idempotent ALTER. We do NOT re-ALTER here: react-native-sqlite-storage marks
// a transaction as failed when any executeSql inside it throws, so even a
// caught "duplicate column name" error would abort the whole migration
// transaction. ensureSchemaCompatibility is the single source of truth for
// column additions; this migration only creates the index.
export async function migrateV7toV8(db: SQLite.SQLiteDatabase): Promise<void> {
  await execute(
    db,
    `CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_month
     ON llm_usage_logs(project_id, created_at)`,
  );
}
