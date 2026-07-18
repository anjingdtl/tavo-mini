import type SQLite from 'react-native-sqlite-storage';
import { applyMigration } from './helpers';
import type { SqlStatement } from '../database/transaction';

export function buildV14toV15Statements(): SqlStatement[] {
  return [
    {
      sql: `CREATE TABLE IF NOT EXISTS project_story_memory (
        project_id INTEGER PRIMARY KEY,
        schema_version INTEGER NOT NULL DEFAULT 1,
        through_chapter_id INTEGER,
        through_chapter_position INTEGER NOT NULL DEFAULT -1,
        memory_json TEXT NOT NULL DEFAULT '{}',
        estimated_tokens INTEGER NOT NULL DEFAULT 0,
        state_fingerprint TEXT NOT NULL DEFAULT '',
        last_applied_patch_id TEXT,
        status TEXT NOT NULL DEFAULT 'empty',
        source TEXT NOT NULL DEFAULT 'native',
        dirty_from_position INTEGER,
        last_error TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (through_chapter_id) REFERENCES chapters(id) ON DELETE SET NULL
      )`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS chapter_memory_patches (
        chapter_id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL,
        chapter_position INTEGER NOT NULL,
        patch_id TEXT NOT NULL UNIQUE,
        schema_version INTEGER NOT NULL DEFAULT 1,
        source_fingerprint TEXT NOT NULL,
        base_memory_fingerprint TEXT NOT NULL DEFAULT '',
        result_memory_fingerprint TEXT NOT NULL DEFAULT '',
        episodic_summary_json TEXT NOT NULL DEFAULT '{}',
        patch_json TEXT NOT NULL DEFAULT '{}',
        estimated_tokens INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'generated',
        last_error TEXT NOT NULL DEFAULT '',
        generated_at TEXT NOT NULL,
        applied_at TEXT,
        FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS story_memory_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        through_chapter_id INTEGER NOT NULL,
        through_chapter_position INTEGER NOT NULL,
        memory_json TEXT NOT NULL,
        estimated_tokens INTEGER NOT NULL DEFAULT 0,
        state_fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(project_id, through_chapter_position),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (through_chapter_id) REFERENCES chapters(id) ON DELETE CASCADE
      )`,
    },
    { sql: 'CREATE INDEX IF NOT EXISTS idx_project_story_memory_status ON project_story_memory(status)' },
    { sql: 'CREATE INDEX IF NOT EXISTS idx_project_story_memory_dirty ON project_story_memory(dirty_from_position)' },
    { sql: 'CREATE INDEX IF NOT EXISTS idx_chapter_memory_patches_project_position ON chapter_memory_patches(project_id, chapter_position)' },
    { sql: 'CREATE INDEX IF NOT EXISTS idx_chapter_memory_patches_status ON chapter_memory_patches(status)' },
    { sql: 'CREATE INDEX IF NOT EXISTS idx_story_memory_snapshots_project_position ON story_memory_snapshots(project_id, through_chapter_position DESC)' },
  ];
}

export async function migrateV14ToV15(
  database: SQLite.SQLiteDatabase,
): Promise<void> {
  await applyMigration(database, buildV14toV15Statements());
}
