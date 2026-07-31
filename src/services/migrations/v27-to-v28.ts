import type { SqlStatement } from '../database/transaction';
import { buildSchema23CreateSqls } from './v22-to-v23';

/**
 * Schema 27 → 28: widen continuation_analysis_work_items CHECK constraint.
 *
 * Schema 23 changed the Canon analysis protocol to a single `full_extraction`
 * request group, but the CHECK constraint on `material_type` was never updated
 * to accept it. Existing installations that already upgraded past Schema 23
 * therefore fail with "CHECK constraint failed" whenever a new analysis run
 * inserts work items. This migration rebuilds the table with the corrected
 * CHECK list while preserving all existing rows and their resume semantics.
 */
export function buildV27toV28Statements(): SqlStatement[] {
  const [createTableSql, createIndexSql] = buildSchema23CreateSqls();
  return [
    {
      sql: 'ALTER TABLE continuation_analysis_work_items RENAME TO continuation_analysis_work_items_v27',
    },
    { sql: createTableSql },
    {
      sql: `INSERT INTO continuation_analysis_work_items (
        run_id, batch_index, material_type, state, attempt_count, result_json,
        error_code, error_message, created_at, updated_at, completed_at
      ) SELECT
        run_id, batch_index, material_type, state, attempt_count, result_json,
        error_code, error_message, created_at, updated_at, completed_at
      FROM continuation_analysis_work_items_v27`,
    },
    { sql: 'DROP TABLE continuation_analysis_work_items_v27' },
    { sql: createIndexSql },
  ];
}
