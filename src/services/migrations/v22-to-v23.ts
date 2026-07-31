import type SQLite from 'react-native-sqlite-storage';
import { applyMigration } from './helpers';
import type { SqlStatement } from '../database/transaction';

/**
 * Schema 22 → 23: Canon request-group protocol.
 *
 * Schema 22 work items use five legacy material names. New analysis runs use
 * a single `full_extraction` request group (v3), while the existing rows are
 * copied unchanged so interrupted pre-upgrade runs retain their exact
 * retry/resume semantics.
 */
export function buildSchema23CreateSqls(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS continuation_analysis_work_items (
      run_id TEXT NOT NULL,
      batch_index INTEGER NOT NULL,
      material_type TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      result_json TEXT,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      PRIMARY KEY (run_id, batch_index, material_type),
      CHECK(material_type IN (
        'world_rules', 'characters', 'relationships', 'plot_threads', 'experiences',
        'character_state', 'world_plot', 'full_extraction'
      )),
      CHECK(state IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
      CHECK(attempt_count >= 0),
      FOREIGN KEY(run_id, batch_index)
        REFERENCES continuation_analysis_batches(run_id, batch_index) ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_continuation_analysis_work_items_state
      ON continuation_analysis_work_items(run_id, state, batch_index, material_type)`,
  ];
}

export async function migrateV22ToV23(
  database: SQLite.SQLiteDatabase,
): Promise<void> {
  await applyMigration(database, buildV22toV23Statements());
}

export function buildV22toV23Statements(): SqlStatement[] {
  const [createTableSql, createIndexSql] = buildSchema23CreateSqls();
  return [
    {
      sql: 'ALTER TABLE continuation_analysis_work_items RENAME TO continuation_analysis_work_items_v22',
    },
    { sql: createTableSql },
    {
      sql: `INSERT INTO continuation_analysis_work_items (
        run_id, batch_index, material_type, state, attempt_count, result_json,
        error_code, error_message, created_at, updated_at, completed_at
      ) SELECT
        run_id, batch_index, material_type, state, attempt_count, result_json,
        error_code, error_message, created_at, updated_at, completed_at
      FROM continuation_analysis_work_items_v22`,
    },
    { sql: 'DROP TABLE continuation_analysis_work_items_v22' },
    { sql: createIndexSql },
  ];
}
