/**
 * Schema 54 → 55: Pipeline Topology Version freeze columns (二 Phase §5).
 *
 * Adds (additive only):
 *   pipeline_tasks
 *     pipeline_topology_version INTEGER NOT NULL DEFAULT 1
 *   multi_chapter_batches
 *     pipeline_topology_version INTEGER NOT NULL DEFAULT 1
 *
 * 1 = legacy_standard, 2 = compact_standard.
 *
 * The DEFAULT is 1 (legacy_standard) on purpose: every task/batch that
 * existed before this upgrade is naturally legacy_standard without scanning
 * creation time — so historical Frozen tasks are NEVER taken over by the
 * compact Standard topology. New tasks/batches must EXPLICITLY write 2 and
 * must never rely on the column default (§5.2/§5.4 of the phase-two plan).
 *
 * Idempotent: each ALTER runs only when the column is missing, so re-running
 * the migration (or an upgrade chain where the fresh-install DDL already
 * carries the column) never fails.
 *
 * Non-breaking: adds nullable-defaulted columns only; backup restore
 * column projection tolerates missing columns (restore only inserts keys
 * present in the backup rows), and the schema manifest is updated in
 * `schemaManifest.ts` so new backups carry the column.
 */
import type SQLite from 'react-native-sqlite-storage';
import type { SqlStatement } from '../database/transaction';
import { executeTransaction } from '../database/transaction';
import { tableColumns } from './helpers';

export const PIPELINE_TOPOLOGY_VERSION_COLUMN = 'pipeline_topology_version';

export const TOPOLOGY_COLUMN_DDL: ReadonlyArray<{
  table: string;
  column: string;
  ddl: string;
}> = [
  {
    table: 'pipeline_tasks',
    column: PIPELINE_TOPOLOGY_VERSION_COLUMN,
    ddl: `ALTER TABLE pipeline_tasks ADD COLUMN ${PIPELINE_TOPOLOGY_VERSION_COLUMN} INTEGER NOT NULL DEFAULT 1`,
  },
  {
    table: 'multi_chapter_batches',
    column: PIPELINE_TOPOLOGY_VERSION_COLUMN,
    ddl: `ALTER TABLE multi_chapter_batches ADD COLUMN ${PIPELINE_TOPOLOGY_VERSION_COLUMN} INTEGER NOT NULL DEFAULT 1`,
  },
];

/**
 * Static statements for tooling that mirrors the migration chain
 * (generate-migration-fixtures / emit-migration-fixture-sql).
 */
export function buildV54toV55Statements(): SqlStatement[] {
  return TOPOLOGY_COLUMN_DDL.map(({ ddl }) => ({ sql: ddl }));
}

/** Fresh-install SQL. `pipeline_tasks` already declares the column inline in
 * `createCurrentSchema`; only `multi_chapter_batches` (whose base table is
 * created by the Schema 42 DDL without the column) needs the idempotent ALTER
 * here. The upgrade migration ALTERs BOTH tables. */
export function buildSchema55CreateSqls(): string[] {
  return TOPOLOGY_COLUMN_DDL.filter(
    column => column.table === 'multi_chapter_batches',
  ).map(column => column.ddl);
}

/** Idempotent logic migration — add each topology column only if missing.
 * A table that does not exist on the source database (empty column set) is
 * skipped, exactly like the v53→v54 `execution_profile` migration. */
export async function migrateV54ToV55(
  db: SQLite.SQLiteDatabase,
): Promise<void> {
  const statements: SqlStatement[] = [];
  for (const { table, column, ddl } of TOPOLOGY_COLUMN_DDL) {
    const existing = await tableColumns(db, table);
    // sql.js `PRAGMA table_info(<missing>)` returns an empty set.
    if (existing.size === 0) continue;
    if (existing.has(column)) continue;
    statements.push({ sql: ddl });
  }
  if (statements.length > 0) {
    await executeTransaction(db, statements, { faultDomain: 'migration' });
  }
}
