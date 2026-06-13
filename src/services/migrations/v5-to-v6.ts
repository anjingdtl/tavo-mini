import type SQLite from 'react-native-sqlite-storage';

async function execute(db: SQLite.SQLiteDatabase, sql: string, params: any[] = []) {
  const [result] = await db.executeSql(sql, params);
  return result;
}

export async function migrateV5toV6(db: SQLite.SQLiteDatabase): Promise<void> {
  await execute(
    db,
    `CREATE TABLE IF NOT EXISTS content_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      target_type TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL,
      source_ref TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )`,
  );

  await execute(
    db,
    `CREATE INDEX IF NOT EXISTS idx_content_revisions_target
     ON content_revisions(target_type, target_id, created_at DESC)`,
  );
}
