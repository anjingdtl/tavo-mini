/**
 * Schema 39 → 40: canon_evidence provenance drift repair migration.
 *
 * This migration exists to heal databases that recorded schema_version=39 (or
 * were advanced to 39) while the 32→33 ALTER for `canon_evidence.source_origin`
 * / `rescan_operation_id` never actually landed. On such a database the
 * versioned migration engine skips 32→33, the provenance columns stay missing,
 * and any query referencing `source_origin` (Canon rescan, evidence reads, and
 * the startup schema validator) throws `no such column` — hiding the user's
 * still-intact characters and worldbook behind a broken startup chain.
 *
 * The migration is a thin wrapper around the shared, idempotent
 * `ensureCanonEvidenceProvenanceSchema` so the exact same repair runs whether
 * the drift is discovered during a 39→40 upgrade, a re-launch of a recorded-40
 * drifted database, or the pre-migration known-repair hook.
 *
 * Non-breaking: only ADD COLUMN (conditional) + backfill + CREATE INDEX
 * (IF NOT EXISTS). No data is deleted or rewritten beyond the NULL/empty
 * source_origin backfill to 'batch'.
 */
import type SQLite from 'react-native-sqlite-storage';
import { ensureCanonEvidenceProvenanceSchema } from '../../data/schema/knownSchemaRepairs';

/**
 * Logic migration for Schema 39 → 40.
 *
 * Dynamically ensures `canon_evidence` has `source_origin` and
 * `rescan_operation_id` columns + the rescan index. Idempotent — safe to run
 * on a database that is already fully migrated (no-op) or on a partially
 * drifted one (only repairs what is missing).
 */
export async function migrateV39ToV40(
  db: SQLite.SQLiteDatabase,
): Promise<void> {
  await ensureCanonEvidenceProvenanceSchema(db);
}

/**
 * Build-statements path. Kept for engine compatibility — returns an empty
 * array because this migration's work is done via the logic migration
 * `migrateV39ToV40` (dynamic PRAGMA checks cannot be expressed as a static
 * statement batch).
 */
export function buildV39toV40Statements(): SqlStatementLike[] {
  return [];
}

// Local minimal type to avoid importing the transaction module just for the
// type when the array is always empty.
interface SqlStatementLike {
  sql: string;
  params?: unknown[];
}
