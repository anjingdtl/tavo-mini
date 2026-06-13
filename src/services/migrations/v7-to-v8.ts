import type SQLite from 'react-native-sqlite-storage';

async function execute(db: SQLite.SQLiteDatabase, sql: string, params: any[] = []) {
  const [result] = await db.executeSql(sql, params);
  return result;
}

export async function migrateV7toV8(db: SQLite.SQLiteDatabase): Promise<void> {
  await execute(
    db,
    `ALTER TABLE llm_usage_logs ADD COLUMN model_name TEXT NOT NULL DEFAULT ''`,
  );

  await execute(
    db,
    `CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_month
     ON llm_usage_logs(project_id, created_at)`,
  );
}
