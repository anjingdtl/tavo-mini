import type SQLite from 'react-native-sqlite-storage';
import { applyMigration, tableColumns } from './helpers';
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

/**
 * Some V2.11.2 preview builds wrote one or more multi-file columns before
 * persisting schema_version=29. A later stable upgrade must therefore treat
 * every ADD COLUMN independently: SQLite has no IF NOT EXISTS for columns and
 * an unconditional statement blocks the whole app at startup.
 */
export async function migrateV28ToV29(
  database: SQLite.SQLiteDatabase,
): Promise<void> {
  const sourceColumns = await tableColumns(database, 'continuation_sources');
  const chunkColumns = await tableColumns(
    database,
    'continuation_source_text_chunks',
  );
  const chapterColumns = await tableColumns(
    database,
    'continuation_source_chapters',
  );
  const statements = buildV28toV29Statements().filter(statement => {
    if (statement.sql.includes('continuation_sources')) {
      if (statement.sql.includes('source_files_json')) {
        return !sourceColumns.has('source_files_json');
      }
      if (statement.sql.includes('is_multi_file')) {
        return !sourceColumns.has('is_multi_file');
      }
      if (statement.sql.includes('file_count')) {
        return !sourceColumns.has('file_count');
      }
    }
    if (statement.sql.includes('continuation_source_text_chunks')) {
      return !chunkColumns.has('file_index');
    }
    if (statement.sql.includes('continuation_source_chapters')) {
      return !chapterColumns.has('file_index');
    }
    return true;
  });
  await applyMigration(database, statements);
}
