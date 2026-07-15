import type SQLite from 'react-native-sqlite-storage';
import { applyMigration } from './helpers';
import type { SqlStatement } from '../database/transaction';

export function buildV6toV7Statements(): SqlStatement[] {
  return [
    {
      sql: `CREATE TABLE IF NOT EXISTS generation_drafts (
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
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_generation_drafts_target
        ON generation_drafts(target_type, target_id, created_at DESC)`,
    },
  ];
}

/** Backward-compatible direct entry point for migration unit tests. */
export async function migrateV6toV7(
  database: SQLite.SQLiteDatabase,
): Promise<void> {
  await applyMigration(database, buildV6toV7Statements());
}
