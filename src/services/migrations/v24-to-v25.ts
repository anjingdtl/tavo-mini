import type SQLite from 'react-native-sqlite-storage';
import { applyMigration } from './helpers';
import type { SqlStatement } from '../database/transaction';

/** Schema 24 → 25: explicit continuation-only use of ordinary resources. */
export function buildSchema25CreateSqls(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS continuation_resource_bindings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      resource_kind TEXT NOT NULL,
      resource_id INTEGER NOT NULL,
      continuation_usage TEXT NOT NULL DEFAULT 'unclassified',
      enabled_for_continuation INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK(resource_kind IN ('character', 'worldbook', 'note', 'preset')),
      CHECK(continuation_usage IN ('unclassified', 'external_supplement', 'original_mirror', 'excluded')),
      CHECK(enabled_for_continuation IN (0, 1)),
      CHECK((continuation_usage = 'external_supplement' AND enabled_for_continuation = 1) OR (continuation_usage <> 'external_supplement' AND enabled_for_continuation = 0)),
      UNIQUE(project_id, resource_kind, resource_id),
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_continuation_resource_bindings_project_usage
      ON continuation_resource_bindings(project_id, resource_kind, continuation_usage, sort_order)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_continuation_resource_bindings_one_preset
      ON continuation_resource_bindings(project_id)
      WHERE resource_kind = 'preset' AND continuation_usage = 'external_supplement'
        AND enabled_for_continuation = 1`,
  ];
}

export async function migrateV24ToV25(database: SQLite.SQLiteDatabase): Promise<void> {
  await applyMigration(database, buildV24toV25Statements());
}

export function buildV24toV25Statements(): SqlStatement[] {
  return buildSchema25CreateSqls().map(sql => ({ sql }));
}
