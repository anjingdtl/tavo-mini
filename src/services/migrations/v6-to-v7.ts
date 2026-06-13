import type SQLite from 'react-native-sqlite-storage';

async function execute(db: SQLite.SQLiteDatabase, sql: string, params: any[] = []) {
  const [result] = await db.executeSql(sql, params);
  return result;
}

export async function migrateV6toV7(db: SQLite.SQLiteDatabase): Promise<void> {
  await execute(
    db,
    `CREATE TABLE IF NOT EXISTS generation_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      target_type TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL,
      pipeline_task_id TEXT,
      token_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )`,
  );

  await execute(
    db,
    `CREATE INDEX IF NOT EXISTS idx_generation_drafts_target
     ON generation_drafts(target_type, target_id, created_at DESC)`,
  );
}
