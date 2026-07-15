import type SQLite from 'react-native-sqlite-storage';
import { applyMigration } from './helpers';
import type { SqlStatement } from '../database/transaction';

function now(): string {
  return new Date().toISOString();
}

export function buildV4toV5Statements(): SqlStatement[] {
  return [
    {
      sql: `INSERT INTO worldbook_collections (
        project_id, name, enabled, max_tokens, estimated_tokens, created_at
      )
      SELECT ?, ?, 1, 50000, 0, ?
      WHERE NOT EXISTS (SELECT 1 FROM worldbook_collections)`,
      params: [0, '未分组/手动条目', now()],
    },
    {
      sql: 'UPDATE worldbook_entries SET collection_id = (SELECT id FROM worldbook_collections ORDER BY id ASC LIMIT 1) WHERE collection_id = 0',
    },
  ];
}

/** Backward-compatible direct entry point for migration unit tests. */
export async function migrateV4toV5(
  database: SQLite.SQLiteDatabase,
): Promise<void> {
  await applyMigration(database, buildV4toV5Statements());
}
