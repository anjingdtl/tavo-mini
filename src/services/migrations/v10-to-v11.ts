import type SQLite from 'react-native-sqlite-storage';
import { applyMigration, tableColumns } from './helpers';
import type { SqlStatement } from '../database/transaction';

export async function buildV10toV11Statements(
  database: SQLite.SQLiteDatabase,
): Promise<SqlStatement[]> {
  const characterColumns = await tableColumns(database, 'characters');
  const statements: SqlStatement[] = [
    {
      sql: `CREATE TABLE IF NOT EXISTS character_collections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        max_tokens INTEGER NOT NULL DEFAULT 50000,
        estimated_tokens INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )`,
    },
  ];
  if (!characterColumns.has('collection_id')) {
    statements.push({
      sql: 'ALTER TABLE characters ADD COLUMN collection_id INTEGER NOT NULL DEFAULT 0',
    });
  }
  statements.push(
    {
      sql: `INSERT INTO character_collections (
        project_id, name, enabled, max_tokens, estimated_tokens, created_at
      )
      SELECT 0, '全部人物卡', 1, 50000, COALESCE(SUM(estimated_tokens), 0), ?
      FROM characters
      WHERE NOT EXISTS (SELECT 1 FROM character_collections LIMIT 1)`,
      params: [new Date().toISOString()],
    },
    {
      sql: `UPDATE characters
        SET collection_id = (SELECT id FROM character_collections ORDER BY id ASC LIMIT 1)
        WHERE collection_id = 0`,
    },
  );
  return statements;
}

/** Backward-compatible direct entry point for migration unit tests. */
export async function migrateV10toV11(
  database: SQLite.SQLiteDatabase,
): Promise<void> {
  await applyMigration(database, await buildV10toV11Statements(database));
}
