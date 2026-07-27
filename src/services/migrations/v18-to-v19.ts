import type SQLite from 'react-native-sqlite-storage';
import { applyMigration } from './helpers';
import type { SqlStatement } from '../database/transaction';

/**
 * Schema 18 → 19: continuation project foundation (Spec §9).
 *
 * Adds the five continuation tables:
 *   - continuation_sources              (one active source per project; versioned)
 *   - continuation_source_text_chunks   (normalized full text, the offset authority)
 *   - continuation_source_chapters      (parsed chapter metadata, read-only)
 *   - continuation_settings             (active source pointer + boundary, 1:1 project)
 *   - continuation_import_jobs          (resumable import tasks; backup:false)
 *
 * Invariants enforced at the DB layer (Spec §5, §9):
 *   - at most one `ready` source per project (partial unique index)
 *   - at most one active import job per project (partial unique index)
 *   - boundary must point at the active source and a non-null chapter+offset
 *   - chunk ranges must be strictly increasing and non-empty
 *   - chapter offsets must satisfy source_start ≤ content_start ≤ source_end
 *
 * Foreign keys cascade on project deletion so deleteProject (which relies on
 * ON DELETE CASCADE) cleans up the whole continuation subtree.
 */
export function buildV18toV19Statements(): SqlStatement[] {
  return [
    {
      sql: `CREATE TABLE IF NOT EXISTS continuation_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(
          status IN ('staging', 'needs_review', 'ready', 'failed', 'superseded')
        ),
        display_name TEXT NOT NULL,
        original_file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL DEFAULT 'text/plain',
        detected_encoding TEXT NOT NULL,
        file_size_bytes INTEGER NOT NULL,
        raw_sha256 TEXT NOT NULL,
        normalized_sha256 TEXT NOT NULL,
        normalized_char_count INTEGER NOT NULL,
        normalized_byte_count INTEGER NOT NULL,
        chapter_count INTEGER NOT NULL DEFAULT 0,
        parser_version TEXT NOT NULL,
        normalization_version TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        activated_at TEXT,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
        UNIQUE(project_id, version),
        UNIQUE(project_id, id)
      )`,
    },
    {
      // Spec §9.2: at most one `ready` source per project. Partial unique
      // index — SQLite supports this via the WHERE clause on CREATE UNIQUE
      // INDEX. Prevents two active sources for the same project at the DB
      // layer, independent of service-level transactions.
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_continuation_sources_one_ready
        ON continuation_sources(project_id)
        WHERE status = 'ready'`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS continuation_source_text_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL CHECK(chunk_index >= 0),
        char_start_offset INTEGER NOT NULL CHECK(char_start_offset >= 0),
        char_end_offset INTEGER NOT NULL CHECK(char_end_offset > char_start_offset),
        content TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        FOREIGN KEY(source_id) REFERENCES continuation_sources(id) ON DELETE CASCADE,
        UNIQUE(source_id, chunk_index),
        UNIQUE(source_id, char_start_offset)
      )`,
    },
    {
      // Range lookup index for the bounded SourceReader (Spec §9.3, §12.3).
      sql: `CREATE INDEX IF NOT EXISTS idx_continuation_text_chunks_range
        ON continuation_source_text_chunks(source_id, char_start_offset, char_end_offset)`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS continuation_source_chapters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL,
        position INTEGER NOT NULL CHECK(position >= 0),
        volume_title TEXT,
        detected_title TEXT NOT NULL,
        title TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        char_count INTEGER NOT NULL,
        paragraph_count INTEGER NOT NULL,
        source_start_offset INTEGER NOT NULL,
        content_start_offset INTEGER NOT NULL,
        source_end_offset INTEGER NOT NULL,
        is_excluded INTEGER NOT NULL DEFAULT 0 CHECK(is_excluded IN (0, 1)),
        exclusion_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(source_id) REFERENCES continuation_sources(id) ON DELETE CASCADE,
        UNIQUE(source_id, position),
        UNIQUE(source_id, id),
        CHECK(char_count >= 0),
        CHECK(paragraph_count >= 0),
        CHECK(source_start_offset >= 0),
        CHECK(content_start_offset >= source_start_offset),
        CHECK(source_end_offset >= content_start_offset)
      )`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS continuation_settings (
        project_id INTEGER PRIMARY KEY,
        active_source_id INTEGER,
        boundary_source_id INTEGER,
        boundary_chapter_id INTEGER,
        boundary_char_offset_global INTEGER,
        boundary_mode TEXT NOT NULL DEFAULT 'end_of_source',
        import_completed INTEGER NOT NULL DEFAULT 0,
        analysis_status TEXT NOT NULL DEFAULT 'not_started',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(project_id, active_source_id)
          REFERENCES continuation_sources(project_id, id),
        FOREIGN KEY(boundary_source_id, boundary_chapter_id)
          REFERENCES continuation_source_chapters(source_id, id),
        CHECK(boundary_mode IN ('end_of_source', 'end_of_chapter', 'custom_offset')),
        CHECK(import_completed IN (0, 1)),
        CHECK(analysis_status IN ('not_started', 'running', 'ready', 'outdated', 'failed')),
        CHECK(
          (active_source_id IS NULL AND boundary_source_id IS NULL
            AND boundary_chapter_id IS NULL AND boundary_char_offset_global IS NULL)
          OR
          (active_source_id IS NOT NULL AND boundary_source_id = active_source_id
            AND boundary_chapter_id IS NOT NULL AND boundary_char_offset_global IS NOT NULL)
        ),
        CHECK(active_source_id IS NULL OR boundary_source_id = active_source_id),
        CHECK(boundary_char_offset_global IS NULL OR boundary_char_offset_global >= 0)
      )`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS continuation_import_jobs (
        id TEXT PRIMARY KEY,
        project_id INTEGER NOT NULL,
        source_id INTEGER NOT NULL,
        source_version INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(
          state IN (
            'queued', 'running', 'paused', 'awaiting_review',
            'completed', 'failed', 'cancelled', 'interrupted'
          )
        ),
        stage TEXT NOT NULL,
        progress_current INTEGER NOT NULL DEFAULT 0,
        progress_total INTEGER NOT NULL DEFAULT 0,
        parser_version TEXT NOT NULL,
        normalization_version TEXT NOT NULL,
        input_copy_relative_path TEXT,
        checkpoint_json TEXT,
        error_code TEXT,
        error_message TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        CHECK(stage IN (
          'reading', 'decoding', 'normalizing', 'detecting_chapters',
          'persisting', 'validating', 'awaiting_review', 'activating'
        )),
        CHECK(progress_current >= 0),
        CHECK(progress_total >= 0),
        CHECK(progress_total = 0 OR progress_current <= progress_total),
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(source_id) REFERENCES continuation_sources(id) ON DELETE CASCADE
      )`,
    },
    {
      // Spec §9.6: at most one active (non-terminal) import job per project.
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_continuation_import_one_active
        ON continuation_import_jobs(project_id)
        WHERE state IN ('queued', 'running', 'paused', 'awaiting_review', 'interrupted')`,
    },
  ];
}

export async function migrateV18ToV19(
  database: SQLite.SQLiteDatabase,
): Promise<void> {
  await applyMigration(database, buildV18toV19Statements());
}
