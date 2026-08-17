/**
 * Schema 53 → 54: One-Shot (极速) execution profile batch freeze.
 *
 * Adds (additive only):
 *   multi_chapter_batches
 *     execution_profile TEXT NOT NULL DEFAULT 'standard'
 *
 * `execution_profile` defaults to 'standard' so every historical batch keeps
 * its existing multi-stage semantics without a data migration. New 极速
 * batches freeze 'one_shot' at creation; every chapter of the batch then
 * inherits the frozen profile instead of re-reading the live setting.
 *
 * Idempotent: the ALTER runs only when the column is missing, so re-running
 * (or a fresh-install DDL chain that already carries the column) is a no-op.
 */
import type SQLite from 'react-native-sqlite-storage';
import type { SqlStatement } from '../database/transaction';
import { executeTransaction } from '../database/transaction';
import { tableColumns } from './helpers';

export const BATCH_EXECUTION_PROFILE_COLUMN = 'execution_profile';

export const SCHEMA54_COLUMN_DDL: ReadonlyArray<{
  table: string;
  column: string;
  ddl: string;
}> = [
  {
    table: 'multi_chapter_batches',
    column: BATCH_EXECUTION_PROFILE_COLUMN,
    ddl: `ALTER TABLE multi_chapter_batches ADD COLUMN ${BATCH_EXECUTION_PROFILE_COLUMN} TEXT NOT NULL DEFAULT 'standard'`,
  },
];

export function buildSchema54CreateSqls(): string[] {
  return SCHEMA54_COLUMN_DDL.map(column => column.ddl);
}

export async function migrateV53ToV54(db: SQLite.SQLiteDatabase): Promise<void> {
  const batchColumns = await tableColumns(db, 'multi_chapter_batches');
  const statements: SqlStatement[] =
    batchColumns.size > 0
      ? SCHEMA54_COLUMN_DDL.filter(
          column =>
            column.table === 'multi_chapter_batches' &&
            !batchColumns.has(column.column),
        ).map(column => ({ sql: column.ddl }))
      : [];
  if (statements.length > 0) {
    await executeTransaction(db, statements, { faultDomain: 'migration' });
  }
}
