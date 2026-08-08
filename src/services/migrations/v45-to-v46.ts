/**
 * Schema 45 → 46: freeze the V2 pipeline reasoning tier on batch headers.
 *
 * Existing batches remain NULL so a pre-upgrade batch cannot silently acquire
 * a new Thinking request semantic when it is resumed. New V2 batches write
 * low/medium/high explicitly and copy that value into each child task's first
 * execution snapshot.
 */
import type SQLite from 'react-native-sqlite-storage';
import type { SqlStatement } from '../database/transaction';
import { executeTransaction } from '../database/transaction';
import { tableColumns } from './helpers';

export const BATCH_REASONING_EFFORT_COLUMN = 'reasoning_effort';

export function buildV45toV46Statements(): SqlStatement[] {
  return [
    {
      sql: `ALTER TABLE multi_chapter_batches ADD COLUMN ${BATCH_REASONING_EFFORT_COLUMN} TEXT`,
    },
  ];
}

/** Idempotent migration for recorded-45 databases, including drifted rows. */
export async function migrateV45ToV46(
  db: SQLite.SQLiteDatabase,
): Promise<void> {
  const columns = await tableColumns(db, 'multi_chapter_batches');
  if (columns.has(BATCH_REASONING_EFFORT_COLUMN)) return;
  await executeTransaction(db, buildV45toV46Statements(), {
    faultDomain: 'migration',
  });
}
