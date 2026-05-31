import type SQLite from 'react-native-sqlite-storage';

async function execute(db: SQLite.SQLiteDatabase, sql: string, params: any[] = []) {
  const [result] = await db.executeSql(sql, params);
  return result;
}

export async function migrateV3toV4(db: SQLite.SQLiteDatabase): Promise<void> {
  await execute(
    db,
    "INSERT OR IGNORE INTO project_resources (project_id, resource_type, resource_id, enabled) SELECT project_id, 'character', id, 1 FROM characters WHERE project_id > 0",
  );
  await execute(
    db,
    "INSERT OR IGNORE INTO project_resources (project_id, resource_type, resource_id, enabled) SELECT project_id, 'worldbook', id, enabled FROM worldbook_entries WHERE project_id > 0",
  );
  await execute(
    db,
    "INSERT OR IGNORE INTO project_resources (project_id, resource_type, resource_id, enabled) SELECT project_id, 'note', id, 1 FROM notes WHERE project_id > 0",
  );
  await execute(
    db,
    "INSERT OR IGNORE INTO project_resources (project_id, resource_type, resource_id, enabled) SELECT project_id, 'preset', id, 1 FROM presets WHERE project_id > 0",
  );
}
