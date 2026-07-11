import type SQLite from 'react-native-sqlite-storage';

async function execute(
  db: SQLite.SQLiteDatabase,
  sql: string,
  params: any[] = [],
) {
  const [result] = await db.executeSql(sql, params);
  return result;
}

export async function migrateV13ToV14(
  db: SQLite.SQLiteDatabase,
): Promise<void> {
  const [result] = await db.executeSql(
    'PRAGMA table_info(project_note_config)',
  );
  const columns = new Set<string>();
  for (let i = 0; i < result.rows.length; i += 1)
    columns.add(result.rows.item(i).name);
  if (!columns.has('retrieval_fragment_chars')) {
    await execute(
      db,
      'ALTER TABLE project_note_config ADD COLUMN retrieval_fragment_chars INTEGER NOT NULL DEFAULT 1000',
    );
  }
}
