import type SQLite from 'react-native-sqlite-storage';
import { applyMigration } from './helpers';
import type { SqlStatement } from '../database/transaction';

export function buildV3toV4Statements(): SqlStatement[] {
  return [
    {
      sql: "INSERT OR IGNORE INTO project_resources (project_id, resource_type, resource_id, enabled) SELECT project_id, 'character', id, 1 FROM characters WHERE project_id > 0",
    },
    {
      sql: "INSERT OR IGNORE INTO project_resources (project_id, resource_type, resource_id, enabled) SELECT project_id, 'worldbook', id, enabled FROM worldbook_entries WHERE project_id > 0",
    },
    {
      sql: "INSERT OR IGNORE INTO project_resources (project_id, resource_type, resource_id, enabled) SELECT project_id, 'note', id, 1 FROM notes WHERE project_id > 0",
    },
    {
      sql: "INSERT OR IGNORE INTO project_resources (project_id, resource_type, resource_id, enabled) SELECT project_id, 'preset', id, 1 FROM presets WHERE project_id > 0",
    },
  ];
}

/** Backward-compatible direct entry point for migration unit tests. */
export async function migrateV3toV4(
  database: SQLite.SQLiteDatabase,
): Promise<void> {
  await applyMigration(database, buildV3toV4Statements());
}
