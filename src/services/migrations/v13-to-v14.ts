import type SQLite from 'react-native-sqlite-storage';
import { applyMigration, tableColumns } from './helpers';
import type { SqlStatement } from '../database/transaction';

export async function buildV13toV14Statements(
  database: SQLite.SQLiteDatabase,
): Promise<SqlStatement[]> {
  const columns = await tableColumns(database, 'project_note_config');
  if (columns.has('retrieval_fragment_chars')) return [];
  return [
    {
      sql: 'ALTER TABLE project_note_config ADD COLUMN retrieval_fragment_chars INTEGER NOT NULL DEFAULT 1000',
    },
  ];
}

/** Backward-compatible direct entry point for migration unit tests. */
export async function migrateV13ToV14(
  database: SQLite.SQLiteDatabase,
): Promise<void> {
  await applyMigration(database, await buildV13toV14Statements(database));
}
