import type SQLite from 'react-native-sqlite-storage';

async function execute(db: SQLite.SQLiteDatabase, sql: string, params: any[] = []) {
  const [result] = await db.executeSql(sql, params);
  return result;
}

function now(): string {
  return new Date().toISOString();
}

export async function migrateV4toV5(db: SQLite.SQLiteDatabase): Promise<void> {
  const existing = await execute(db, 'SELECT id FROM worldbook_collections ORDER BY id ASC LIMIT 1');
  let collectionId: number | null = existing.rows.length > 0 ? existing.rows.item(0).id : null;
  if (!collectionId) {
    const result = await execute(
      db,
      'INSERT INTO worldbook_collections (project_id, name, enabled, max_tokens, estimated_tokens, created_at) VALUES (?, ?, 1, 50000, 0, ?)',
      [0, '未分组/手动条目', now()],
    );
    collectionId = result.insertId!;
  }
  await execute(db, 'UPDATE worldbook_entries SET collection_id = ? WHERE collection_id = 0', [collectionId]);
}
