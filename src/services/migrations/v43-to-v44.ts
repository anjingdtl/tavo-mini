/**
 * Schema 43 → 44: pipeline task / batch version freeze columns.
 *
 * Adds the frozen protocol-version columns to `pipeline_tasks` and
 * `multi_chapter_batches`:
 *   outline_workflow_version INTEGER NOT NULL DEFAULT 1
 *   context_budget_version   INTEGER NOT NULL DEFAULT 1
 *
 * The DEFAULT is 1 (Legacy) on purpose: every task/batch that existed before
 * this upgrade is naturally Legacy without scanning creation time. New
 * tasks/batches created by the new app version must EXPLICITLY write 2 — they
 * must never rely on the column default, because the default exists for
 * pre-upgrade rows (§4.2 of the default-capabilities plan).
 *
 * Idempotent: each ALTER runs only when the column is missing, so re-running
 * the migration (or an upgrade chain where the fresh-install DDL already
 * carries the columns) never fails.
 *
 * Non-breaking: adds nullable-defaulted columns only; backup format and
 * restore column projection tolerate missing columns (restore only inserts
 * keys present in the backup rows).
 */
import type SQLite from 'react-native-sqlite-storage';
import type { SqlStatement } from '../database/transaction';
import { executeTransaction } from '../database/transaction';
import { tableColumns } from './helpers';

export const OUTLINE_WORKFLOW_VERSION_COLUMN = 'outline_workflow_version';
export const CONTEXT_BUDGET_VERSION_COLUMN = 'context_budget_version';

export const VERSION_COLUMN_DDL: ReadonlyArray<{
  table: string;
  column: string;
  ddl: string;
}> = [
  {
    table: 'pipeline_tasks',
    column: OUTLINE_WORKFLOW_VERSION_COLUMN,
    ddl: `ALTER TABLE pipeline_tasks ADD COLUMN ${OUTLINE_WORKFLOW_VERSION_COLUMN} INTEGER NOT NULL DEFAULT 1`,
  },
  {
    table: 'pipeline_tasks',
    column: CONTEXT_BUDGET_VERSION_COLUMN,
    ddl: `ALTER TABLE pipeline_tasks ADD COLUMN ${CONTEXT_BUDGET_VERSION_COLUMN} INTEGER NOT NULL DEFAULT 1`,
  },
  {
    table: 'multi_chapter_batches',
    column: OUTLINE_WORKFLOW_VERSION_COLUMN,
    ddl: `ALTER TABLE multi_chapter_batches ADD COLUMN ${OUTLINE_WORKFLOW_VERSION_COLUMN} INTEGER NOT NULL DEFAULT 1`,
  },
  {
    table: 'multi_chapter_batches',
    column: CONTEXT_BUDGET_VERSION_COLUMN,
    ddl: `ALTER TABLE multi_chapter_batches ADD COLUMN ${CONTEXT_BUDGET_VERSION_COLUMN} INTEGER NOT NULL DEFAULT 1`,
  },
];

/**
 * Static statements for tooling that mirrors the migration chain
 * (generate-migration-fixtures / emit-migration-fixture-sql). The runtime
 * engine uses `migrateV43ToV44` (idempotent) instead.
 */
export function buildV43toV44Statements(): SqlStatement[] {
  return VERSION_COLUMN_DDL.map(({ ddl }) => ({ sql: ddl }));
}

/** Idempotent logic migration — add each version column only if missing. */
export async function migrateV43ToV44(
  db: SQLite.SQLiteDatabase,
): Promise<void> {
  const statements: SqlStatement[] = [];
  for (const { table, column, ddl } of VERSION_COLUMN_DDL) {
    const existing = await tableColumns(db, table);
    if (existing.has(column)) continue;
    statements.push({ sql: ddl });
  }
  if (statements.length > 0) {
    await executeTransaction(db, statements, { faultDomain: 'migration' });
  }
}
