import type SQLite from 'react-native-sqlite-storage';
import { applyMigration } from './helpers';
import type { SqlStatement } from '../database/transaction';

export function buildV5toV6Statements(): SqlStatement[] {
  return [
    {
      sql: `CREATE TABLE IF NOT EXISTS content_revisions (
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
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_content_revisions_target
        ON content_revisions(target_type, target_id, created_at DESC)`,
    },
  ];
}

/** Backward-compatible direct entry point for migration unit tests. */
export async function migrateV5toV6(
  database: SQLite.SQLiteDatabase,
): Promise<void> {
  await applyMigration(database, buildV5toV6Statements());
}
