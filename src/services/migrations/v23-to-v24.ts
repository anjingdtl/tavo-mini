import type SQLite from 'react-native-sqlite-storage';
import { applyMigration } from './helpers';
import type { SqlStatement } from '../database/transaction';

/**
 * Schema 23 → 24: historical, non-Canon memory for scoped continuation.
 *
 * Digest text is deliberately stored outside the Canon/evidence tables. It is
 * a weak contextual reference only and can never be promoted to evidence.
 */
export function buildSchema24CreateSqls(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS continuation_historical_digests (
      id TEXT PRIMARY KEY,
      project_id INTEGER NOT NULL,
      source_id INTEGER NOT NULL,
      source_version INTEGER NOT NULL,
      source_sha256 TEXT NOT NULL,
      parser_version TEXT NOT NULL,
      normalization_version TEXT NOT NULL,
      boundary_chapter_id INTEGER NOT NULL,
      boundary_position INTEGER NOT NULL,
      boundary_char_offset_exclusive INTEGER NOT NULL,
      start_position INTEGER NOT NULL,
      end_position INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      summary TEXT NOT NULL DEFAULT '',
      keywords_json TEXT NOT NULL DEFAULT '[]',
      model_config_id INTEGER,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE(project_id, source_id, boundary_char_offset_exclusive, start_position, end_position),
      CHECK(status IN ('queued', 'running', 'ready', 'failed', 'outdated', 'cancelled')),
      CHECK(source_version >= 1),
      CHECK(boundary_position >= 0),
      CHECK(boundary_char_offset_exclusive >= 0),
      CHECK(start_position >= 0),
      CHECK(end_position > start_position),
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(source_id) REFERENCES continuation_sources(id) ON DELETE CASCADE,
      FOREIGN KEY(boundary_chapter_id) REFERENCES continuation_source_chapters(id) ON DELETE CASCADE,
      FOREIGN KEY(model_config_id) REFERENCES llm_config(id) ON DELETE SET NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_historical_digests_lookup
      ON continuation_historical_digests(project_id, source_id, status, start_position, end_position)`,
    `CREATE TABLE IF NOT EXISTS continuation_historical_digest_chapters (
      digest_id TEXT NOT NULL,
      chapter_id INTEGER NOT NULL,
      chapter_position INTEGER NOT NULL,
      chapter_title TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(digest_id, chapter_id),
      CHECK(chapter_position >= 0),
      FOREIGN KEY(digest_id) REFERENCES continuation_historical_digests(id) ON DELETE CASCADE,
      FOREIGN KEY(chapter_id) REFERENCES continuation_source_chapters(id) ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_historical_digest_chapters_position
      ON continuation_historical_digest_chapters(chapter_id, chapter_position)`,
    `CREATE TABLE IF NOT EXISTS continuation_historical_index_terms (
      digest_id TEXT NOT NULL,
      chapter_id INTEGER NOT NULL,
      chapter_position INTEGER NOT NULL,
      term_normalized TEXT NOT NULL,
      term_display TEXT NOT NULL,
      term_kind TEXT NOT NULL DEFAULT 'keyword',
      PRIMARY KEY(digest_id, chapter_id, term_normalized),
      CHECK(term_kind IN ('title', 'name', 'keyword')),
      CHECK(chapter_position >= 0),
      FOREIGN KEY(digest_id) REFERENCES continuation_historical_digests(id) ON DELETE CASCADE,
      FOREIGN KEY(chapter_id) REFERENCES continuation_source_chapters(id) ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_historical_index_terms_lookup
      ON continuation_historical_index_terms(term_normalized, chapter_position DESC)`,
  ];
}

export async function migrateV23ToV24(
  database: SQLite.SQLiteDatabase,
): Promise<void> {
  await applyMigration(database, buildV23toV24Statements());
}

export function buildV23toV24Statements(): SqlStatement[] {
  return buildSchema24CreateSqls().map(sql => ({ sql }));
}
