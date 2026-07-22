import type SQLite from 'react-native-sqlite-storage';
import { applyMigration } from './helpers';
import type { SqlStatement } from '../database/transaction';

export function buildV16toV17Statements(): SqlStatement[] {
  return [
    {
      sql: `CREATE TABLE IF NOT EXISTS note_collections (
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
    {
      sql: 'ALTER TABLE notes ADD COLUMN collection_id INTEGER NOT NULL DEFAULT 0',
    },
    {
      sql: 'CREATE INDEX IF NOT EXISTS idx_notes_collection_id ON notes(collection_id)',
    },
  ];
}

export async function migrateV16ToV17(
  database: SQLite.SQLiteDatabase,
): Promise<void> {
  await applyMigration(database, buildV16toV17Statements());
}
