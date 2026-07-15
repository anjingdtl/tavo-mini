import type SQLite from 'react-native-sqlite-storage';
import { applyMigration } from './helpers';
import type { SqlStatement } from '../database/transaction';

export function buildV8toV9Statements(): SqlStatement[] {
  return [
    {
      sql: `CREATE TABLE IF NOT EXISTS project_note_config (
        project_id INTEGER PRIMARY KEY,
        mode TEXT NOT NULL DEFAULT 'none',
        style_weights TEXT NOT NULL DEFAULT '{}',
        retrieval_top_k INTEGER NOT NULL DEFAULT 5,
        retrieval_fragment_chars INTEGER NOT NULL DEFAULT 1000,
        enabled_note_ids TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS note_style_profiles (
        note_id INTEGER PRIMARY KEY,
        profile_text TEXT NOT NULL DEFAULT '',
        profile_json TEXT NOT NULL DEFAULT '{}',
        analyzed_at TEXT NOT NULL,
        source_hash TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
      )`,
    },
  ];
}

/** Backward-compatible direct entry point for migration unit tests. */
export async function migrateV8toV9(
  database: SQLite.SQLiteDatabase,
): Promise<void> {
  await applyMigration(database, buildV8toV9Statements());
}
