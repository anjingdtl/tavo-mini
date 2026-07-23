import type SQLite from 'react-native-sqlite-storage';
import { applyMigration } from './helpers';
import type { SqlStatement } from '../database/transaction';

export function buildV17toV18Statements(): SqlStatement[] {
  return [
    {
      sql: `CREATE TABLE IF NOT EXISTS project_collection_settings (
        project_id INTEGER NOT NULL,
        resource_type TEXT NOT NULL,
        collection_id INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (project_id, resource_type, collection_id),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )`,
    },
    {
      sql: 'CREATE INDEX IF NOT EXISTS idx_project_collection_settings_lookup ON project_collection_settings(project_id, resource_type, collection_id)',
    },
  ];
}

export async function migrateV17ToV18(
  database: SQLite.SQLiteDatabase,
): Promise<void> {
  await applyMigration(database, buildV17toV18Statements());
}
