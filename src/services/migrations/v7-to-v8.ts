import type SQLite from 'react-native-sqlite-storage';

async function execute(db: SQLite.SQLiteDatabase, sql: string, params: any[] = []) {
  const [result] = await db.executeSql(sql, params);
  return result;
}

async function columnExists(db: SQLite.SQLiteDatabase, table: string, column: string): Promise<boolean> {
  const result = await execute(db, `PRAGMA table_info(${table})`);
  for (let i = 0; i < result.rows.length; i++) {
    if (result.rows.item(i).name === column) return true;
  }
  return false;
}

// SQLite has no IF NOT EXISTS for ADD COLUMN; guard each ALTER with a PRAGMA check
// so the migration is idempotent if re-run (e.g. after a settings reset).
export async function migrateV7toV8(db: SQLite.SQLiteDatabase): Promise<void> {
  if (!(await columnExists(db, 'llm_usage_logs', 'model_name'))) {
    await execute(db, `ALTER TABLE llm_usage_logs ADD COLUMN model_name TEXT NOT NULL DEFAULT ''`);
  }
  if (!(await columnExists(db, 'llm_usage_logs', 'project_id'))) {
    await execute(db, `ALTER TABLE llm_usage_logs ADD COLUMN project_id INTEGER NOT NULL DEFAULT 0`);
  }

  await execute(
    db,
    `CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_month
     ON llm_usage_logs(project_id, created_at)`,
  );
}
