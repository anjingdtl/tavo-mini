/**
 * Schema 52 → 53: continuation-mode multi-chapter batch columns.
 *
 * Adds (doc §6, additive only):
 *   multi_chapter_batches
 *     writing_mode TEXT NOT NULL DEFAULT 'outline'
 *     continuation_anchor_json TEXT NULL
 *     continuation_execution_policy_json TEXT NULL
 *   multi_chapter_batch_items
 *     active_continuation_run_id TEXT NULL
 *
 * `writing_mode` defaults to 'outline' so every historical batch keeps its
 * existing semantics without a data migration. `active_continuation_run_id`
 * is deliberately a separate column from `active_pipeline_task_id` — the two
 * execution systems must never share an identifier namespace (doc §6.2).
 *
 * Idempotent: each ALTER runs only when the column is missing, so re-running
 * (or a fresh-install DDL chain that already carries the columns) is a no-op.
 * Non-breaking: nullable / defaulted columns only.
 */
import type SQLite from 'react-native-sqlite-storage';
import type { SqlStatement } from '../database/transaction';
import { executeTransaction } from '../database/transaction';
import { tableColumns } from './helpers';

export const BATCH_WRITING_MODE_COLUMN = 'writing_mode';
export const BATCH_CONTINUATION_ANCHOR_COLUMN = 'continuation_anchor_json';
export const BATCH_CONTINUATION_POLICY_COLUMN =
  'continuation_execution_policy_json';
export const ITEM_ACTIVE_CONTINUATION_RUN_ID_COLUMN =
  'active_continuation_run_id';

export const SCHEMA53_COLUMN_DDL: ReadonlyArray<{
  table: string;
  column: string;
  ddl: string;
}> = [
  {
    table: 'multi_chapter_batches',
    column: BATCH_WRITING_MODE_COLUMN,
    ddl: `ALTER TABLE multi_chapter_batches ADD COLUMN ${BATCH_WRITING_MODE_COLUMN} TEXT NOT NULL DEFAULT 'outline'`,
  },
  {
    table: 'multi_chapter_batches',
    column: BATCH_CONTINUATION_ANCHOR_COLUMN,
    ddl: `ALTER TABLE multi_chapter_batches ADD COLUMN ${BATCH_CONTINUATION_ANCHOR_COLUMN} TEXT`,
  },
  {
    table: 'multi_chapter_batches',
    column: BATCH_CONTINUATION_POLICY_COLUMN,
    ddl: `ALTER TABLE multi_chapter_batches ADD COLUMN ${BATCH_CONTINUATION_POLICY_COLUMN} TEXT`,
  },
  {
    table: 'multi_chapter_batch_items',
    column: ITEM_ACTIVE_CONTINUATION_RUN_ID_COLUMN,
    ddl: `ALTER TABLE multi_chapter_batch_items ADD COLUMN ${ITEM_ACTIVE_CONTINUATION_RUN_ID_COLUMN} TEXT`,
  },
];

export function buildSchema53CreateSqls(): string[] {
  return SCHEMA53_COLUMN_DDL.map(column => column.ddl);
}

export async function migrateV52ToV53(db: SQLite.SQLiteDatabase): Promise<void> {
  const batchColumns = await tableColumns(db, 'multi_chapter_batches');
  const itemColumns = await tableColumns(db, 'multi_chapter_batch_items');
  const statements: SqlStatement[] = [
    ...(batchColumns.size > 0
      ? SCHEMA53_COLUMN_DDL.filter(
          column =>
            column.table === 'multi_chapter_batches' &&
            !batchColumns.has(column.column),
        )
      : []),
    ...(itemColumns.size > 0
      ? SCHEMA53_COLUMN_DDL.filter(
          column =>
            column.table === 'multi_chapter_batch_items' &&
            !itemColumns.has(column.column),
        )
      : []),
  ].map(column => ({ sql: column.ddl }));
  if (statements.length > 0) {
    await executeTransaction(db, statements, { faultDomain: 'migration' });
  }
}
