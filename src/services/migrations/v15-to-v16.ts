import type SQLite from 'react-native-sqlite-storage';
import { applyMigration } from './helpers';
import type { SqlStatement } from '../database/transaction';

export function buildV15toV16Statements(): SqlStatement[] {
  return [
    {
      sql: `CREATE TABLE IF NOT EXISTS project_story_memory_policy (
        project_id INTEGER PRIMARY KEY,
        mode TEXT NOT NULL DEFAULT 'smart',
        interval_chapters INTEGER NOT NULL DEFAULT 3,
        pending_token_soft_limit INTEGER NOT NULL DEFAULT 2400,
        update_on_key_chapter INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS story_memory_batches (
        batch_id TEXT PRIMARY KEY,
        project_id INTEGER NOT NULL,
        from_chapter_id INTEGER NOT NULL,
        from_position INTEGER NOT NULL,
        through_chapter_id INTEGER NOT NULL,
        through_position INTEGER NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 2,
        source_fingerprint TEXT NOT NULL,
        base_state_fingerprint TEXT NOT NULL,
        result_state_fingerprint TEXT NOT NULL DEFAULT '',
        patch_json TEXT NOT NULL DEFAULT '{}',
        chapter_summaries_json TEXT NOT NULL DEFAULT '[]',
        estimated_tokens INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'generated',
        last_error TEXT NOT NULL DEFAULT '',
        generated_at TEXT NOT NULL,
        applied_at TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (from_chapter_id) REFERENCES chapters(id) ON DELETE CASCADE,
        FOREIGN KEY (through_chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
      )`,
    },
    {
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_story_memory_batches_project_range
        ON story_memory_batches(project_id, from_position, through_position)`,
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_story_memory_batches_project_through
        ON story_memory_batches(project_id, through_position DESC)`,
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_story_memory_batches_status
        ON story_memory_batches(status)`,
    },
  ];
}

export async function migrateV15ToV16(
  database: SQLite.SQLiteDatabase,
): Promise<void> {
  await applyMigration(database, buildV15toV16Statements());
}
