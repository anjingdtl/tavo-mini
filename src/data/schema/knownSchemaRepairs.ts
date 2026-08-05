/**
 * Idempotent, check-then-ALTER repair for the known Schema 32→33 provenance
 * drift on `canon_evidence`.
 *
 * Why this exists separately from the versioned migrations:
 *   - The 32→33 migration's fixed `ALTER TABLE ADD COLUMN` statements throw
 *     `duplicate column name` on a database that already has the columns.
 *   - A recorded-39 database with a partially-migrated `canon_evidence`
 *     (columns or index missing) will never re-enter the 32→33 migration, so
 *     the drift persists forever and breaks the startup validation chain.
 *
 * This module is the single, reusable, dynamic repair used by:
 *   1. The versioned 32→33 logic migration (`migrateV32ToV33`).
 *   2. The versioned 39→40 migration.
 *   3. The startup known-repair hook (every launch, idempotent).
 *
 * It NEVER creates an empty `canon_evidence` table. If the table is entirely
 * missing, it returns a structured failure so the caller blocks startup
 * instead of masking data loss.
 */
import type SQLite from 'react-native-sqlite-storage';
import { execute } from '../connection/execute';
import {
  executeTransaction,
  type SqlStatement,
} from '../../services/database/transaction';
import {
  inspectKnownSchemaDrift,
  type SchemaDriftReport,
} from './schemaDriftInspector';

export const EVIDENCE_SOURCE_ORIGIN_BATCH = 'batch';

export type SchemaRepairOutcomeCode =
  | 'CANON_EVIDENCE_TABLE_MISSING'
  | 'CANON_SOURCE_ORIGIN_MISSING'
  | 'CANON_RESCAN_OPERATION_ID_MISSING'
  | 'CANON_RESCAN_INDEX_MISSING'
  | 'NO_REPAIR_NEEDED';

export interface SchemaRepairResult {
  /** True when a repair was applied (or none was needed). */
  ok: boolean;
  /** Structured outcome codes (the defects handled). */
  codes: SchemaRepairOutcomeCode[];
  /** Before/after identity of canon_evidence rows (COUNT/MIN/MAX/SUM). */
  evidenceBefore?: CanonEvidenceIdentity;
  evidenceAfter?: CanonEvidenceIdentity;
  /** The drift report the repair was based on. */
  report: SchemaDriftReport;
  /** Human-readable diagnostic (non-sensitive). */
  message: string;
}

export interface CanonEvidenceIdentity {
  count: number;
  minId: number | null;
  maxId: number | null;
  sumId: number;
}

async function canonEvidenceIdentity(
  database: SQLite.SQLiteDatabase,
): Promise<CanonEvidenceIdentity | null> {
  try {
    const result = await execute(
      database,
      'SELECT COUNT(*) AS count, MIN(id) AS min_id, MAX(id) AS max_id, COALESCE(SUM(id), 0) AS sum_id FROM canon_evidence',
    );
    if (result.rows.length === 0) return null;
    const row = result.rows.item(0);
    return {
      count: Number(row.count ?? 0),
      minId: row.min_id === null ? null : Number(row.min_id),
      maxId: row.max_id === null ? null : Number(row.max_id),
      sumId: Number(row.sum_id ?? 0),
    };
  } catch {
    return null;
  }
}

/**
 * Dynamically ensure `canon_evidence` has `source_origin` and
 * `rescan_operation_id` columns and the `idx_canon_evidence_rescan_op` index.
 *
 * Checks PRAGMA first, only ALTERs what's actually missing, backfills
 * `source_origin = 'batch'` for NULL/empty rows, and creates the index.
 * Repeated invocation is a no-op.
 *
 * Returns `false` (no-op) when `canon_evidence` does not exist at all — this
 * happens on pre-Schema-20 databases and on test doubles that do not track the
 * Canon tables. The hard "refuse to create an empty table" guard lives in
 * {@link repairKnownSchemaDrift}, which uses the drift inspector to decide
 * whether a missing table is a real corruption (recorded version ≥ 20) or a
 * benign pre-Canon install.
 */
export async function ensureCanonEvidenceProvenanceSchema(
  database: SQLite.SQLiteDatabase,
): Promise<boolean> {
  // 1. Table existence check — no-op if the table does not exist.
  const tableCheck = await execute(
    database,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'canon_evidence'",
  );
  if (tableCheck.rows.length === 0) {
    return false;
  }

  // 2. Column check → conditional ALTER
  const colResult = await execute(
    database,
    'PRAGMA table_info(canon_evidence)',
  );
  const cols = new Set<string>();
  for (let i = 0; i < colResult.rows.length; i++) {
    cols.add(colResult.rows.item(i).name);
  }

  const statements: SqlStatement[] = [];
  if (!cols.has('source_origin')) {
    statements.push({
      sql: `ALTER TABLE canon_evidence ADD COLUMN source_origin TEXT NOT NULL DEFAULT '${EVIDENCE_SOURCE_ORIGIN_BATCH}'`,
    });
  }
  if (!cols.has('rescan_operation_id')) {
    statements.push({
      sql: 'ALTER TABLE canon_evidence ADD COLUMN rescan_operation_id TEXT',
    });
  }
  if (statements.length > 0) {
    await executeTransaction(database, statements, {
      faultDomain: 'restore',
    });
  }

  // 3. Backfill NULL / empty source_origin (only if column now exists)
  await execute(
    database,
    `UPDATE canon_evidence SET source_origin = '${EVIDENCE_SOURCE_ORIGIN_BATCH}' WHERE source_origin IS NULL OR TRIM(source_origin) = ''`,
  );

  // 4. Index check → conditional CREATE
  await execute(
    database,
    `CREATE INDEX IF NOT EXISTS idx_canon_evidence_rescan_op
     ON canon_evidence(snapshot_id, analysis_run_id, source_origin, rescan_operation_id)`,
  );
  return true;
}

/**
 * Repair all known schema drift defects detected by
 * {@link inspectKnownSchemaDrift}. Idempotent and safe to call every launch.
 *
 * Captures canon_evidence identity before and after so the caller can assert
 * no evidence rows were lost.
 */
export async function repairKnownSchemaDrift(
  database: SQLite.SQLiteDatabase,
  report?: SchemaDriftReport,
): Promise<SchemaRepairResult> {
  const drift = report ?? (await inspectKnownSchemaDrift(database));

  if (!drift.needsRepair) {
    return {
      ok: true,
      codes: ['NO_REPAIR_NEEDED'],
      report: drift,
      message: 'No known schema drift detected.',
    };
  }

  // Hard-fail on a missing table — do NOT create an empty replacement.
  if (drift.repairCodes.includes('CANON_EVIDENCE_TABLE_MISSING')) {
    return {
      ok: false,
      codes: ['CANON_EVIDENCE_TABLE_MISSING'],
      report: drift,
      message:
        'canon_evidence table is entirely missing. The database may be corrupted; refusing to create an empty table.',
    };
  }

  const evidenceBefore = (await canonEvidenceIdentity(database)) ?? undefined;

  await ensureCanonEvidenceProvenanceSchema(database);

  const evidenceAfter = (await canonEvidenceIdentity(database)) ?? undefined;

  // Verify identity preservation (columns/index added, no rows lost).
  const identityPreserved =
    evidenceBefore !== undefined &&
    evidenceAfter !== undefined &&
    evidenceBefore.count === evidenceAfter.count &&
    evidenceBefore.minId === evidenceAfter.minId &&
    evidenceBefore.maxId === evidenceAfter.maxId &&
    evidenceBefore.sumId === evidenceAfter.sumId;

  const codes: SchemaRepairOutcomeCode[] = [];
  if (drift.repairCodes.includes('CANON_SOURCE_ORIGIN_MISSING')) {
    codes.push('CANON_SOURCE_ORIGIN_MISSING');
  }
  if (drift.repairCodes.includes('CANON_RESCAN_OPERATION_ID_MISSING')) {
    codes.push('CANON_RESCAN_OPERATION_ID_MISSING');
  }
  if (drift.repairCodes.includes('CANON_RESCAN_INDEX_MISSING')) {
    codes.push('CANON_RESCAN_INDEX_MISSING');
  }

  return {
    ok: identityPreserved,
    codes,
    evidenceBefore,
    evidenceAfter,
    report: drift,
    message: identityPreserved
      ? `Repaired canon_evidence provenance (${codes.join(', ')}).`
      : 'canon_evidence identity changed during repair — possible data loss.',
  };
}
