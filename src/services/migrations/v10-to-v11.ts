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

export async function migrateV10toV11(db: SQLite.SQLiteDatabase): Promise<void> {
  await execute(
    db,
    `CREATE TABLE IF NOT EXISTS character_collections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      max_tokens INTEGER NOT NULL DEFAULT 50000,
      estimated_tokens INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )`,
  );

  const characterColumns = await tableColumns(db, 'characters');
  if (!characterColumns.has('collection_id')) {
    await execute(db, 'ALTER TABLE characters ADD COLUMN collection_id INTEGER NOT NULL DEFAULT 0');
  }

  const createdAt = new Date().toISOString();
  await execute(
    db,
    `INSERT INTO character_collections (project_id, name, enabled, max_tokens, estimated_tokens, created_at)
     SELECT 0, '全部人物卡', 1, 50000, COALESCE(SUM(estimated_tokens), 0), ?
     FROM characters
     WHERE NOT EXISTS (SELECT 1 FROM character_collections LIMIT 1)`,
    [createdAt],
  );
  await execute(
    db,
    `UPDATE characters
     SET collection_id = (SELECT id FROM character_collections ORDER BY id ASC LIMIT 1)
     WHERE collection_id = 0`,
  );
}
