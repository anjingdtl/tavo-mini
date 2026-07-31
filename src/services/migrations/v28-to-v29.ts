import type { SqlStatement } from '../database/transaction';

/**
 * Schema 28 → 29: multi-file TXT import for continuation sources.
 *
 * Adds source_files_json / is_multi_file / file_count to continuation_sources
 * for recording multi-file metadata; adds file_index to chunks and chapters
 * tables as provenance markers. Non-breaking: all new columns have defaults
 * that preserve single-file semantics for existing rows.
 */
export function buildV28toV29Statements(): SqlStatement[] {
  return [
    {
      sql: `ALTER TABLE continuation_sources
        ADD COLUMN source_files_json TEXT`,
    },
    {
      sql: `ALTER TABLE continuation_sources
        ADD COLUMN is_multi_file INTEGER NOT NULL DEFAULT 0
        CHECK(is_multi_file IN (0, 1))`,
    },
    {
      sql: `ALTER TABLE continuation_sources
        ADD COLUMN file_count INTEGER NOT NULL DEFAULT 1
        CHECK(file_count >= 1)`,
    },
    {
      sql: `ALTER TABLE continuation_source_text_chunks
        ADD COLUMN file_index INTEGER NOT NULL DEFAULT 0
        CHECK(file_index >= 0)`,
    },
    {
      sql: `ALTER TABLE continuation_source_chapters
        ADD COLUMN file_index INTEGER NOT NULL DEFAULT 0
        CHECK(file_index >= 0)`,
    },
  ];
}
