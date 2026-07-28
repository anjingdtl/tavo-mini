import type SQLite from 'react-native-sqlite-storage';
import { applyMigration } from './helpers';
import type { SqlStatement } from '../database/transaction';

/**
 * Schema 21 → 22: resumable Canon material work items.
 *
 * A chapter batch remains the immutable source-input unit.  This table records
 * the five independently retriable LLM material requests that make up each
 * batch, so progress is truthful after backgrounding, process death and retry.
 */
export function buildSchema22CreateSqls(): string[] {
  return buildV21toV22Statements().map(statement => statement.sql);
}

export async function migrateV21ToV22(database: SQLite.SQLiteDatabase): Promise<void> {
  await applyMigration(database, buildV21toV22Statements());
}

export function buildV21toV22Statements(): SqlStatement[] {
  return [
    {
      sql: `CREATE TABLE IF NOT EXISTS continuation_analysis_work_items (
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
          'world_rules', 'characters', 'relationships', 'plot_threads', 'experiences'
        )),
        CHECK(state IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
        CHECK(attempt_count >= 0),
        FOREIGN KEY(run_id, batch_index)
          REFERENCES continuation_analysis_batches(run_id, batch_index) ON DELETE CASCADE
      )`,
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_continuation_analysis_work_items_state
        ON continuation_analysis_work_items(run_id, state, batch_index, material_type)`,
    },
    {
      // Preserve resumability for a task that was created just before upgrade.
      sql: `INSERT OR IGNORE INTO continuation_analysis_work_items (
        run_id, batch_index, material_type, state, attempt_count, created_at, updated_at
      )
      SELECT b.run_id, b.batch_index, material_type, 'queued', 0, b.updated_at, b.updated_at
      FROM continuation_analysis_batches b
      CROSS JOIN (
        SELECT 'world_rules' AS material_type UNION ALL
        SELECT 'characters' UNION ALL SELECT 'relationships' UNION ALL
        SELECT 'plot_threads' UNION ALL SELECT 'experiences'
      )`,
    },
  ];
}
