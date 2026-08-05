/**
 * Schema drift inspector: dynamically detect known physical-schema defects that
 * `settings.schema_version` alone cannot reveal.
 *
 * Background: a database can record schema_version=39 while its
 * `canon_evidence` table is still missing `source_origin` /
 * `rescan_operation_id` (the Schema 32→33 provenance columns). The versioned
 * migration engine skips 32→33 on a recorded-39 database, so the drift is
 * invisible until `validateSchema` (or a Canon rescan query) trips over the
 * missing column and breaks the startup chain — hiding the user's still-intact
 * characters and worldbook behind a "no such column" error.
 *
 * This module reads `PRAGMA table_info` / `PRAGMA index_list` only and NEVER
 * mutates the database. It produces a structured {@link SchemaDriftReport}
 * that drives the known-repair flow in `knownSchemaRepairs.ts`.
 */
import type SQLite from 'react-native-sqlite-storage';
import { execute } from '../connection/execute';

export type SchemaRepairCode =
  | 'CANON_EVIDENCE_TABLE_MISSING'
  | 'CANON_SOURCE_ORIGIN_MISSING'
  | 'CANON_RESCAN_OPERATION_ID_MISSING'
  | 'CANON_RESCAN_INDEX_MISSING';

export interface SchemaDriftReport {
  /** The schema_version recorded in settings (may be stale / optimistic). */
  recordedSchemaVersion: number;
  /** Whether `canon_evidence` table exists at all. */
  canonEvidenceExists: boolean;
  /** Whether `source_origin` column is present. */
  sourceOriginExists: boolean;
  /** Whether `rescan_operation_id` column is present. */
  rescanOperationIdExists: boolean;
  /** Whether `idx_canon_evidence_rescan_op` index exists. */
  rescanIndexExists: boolean;
  /** True when one or more known drift defects need repair. */
  needsRepair: boolean;
  /** Structured codes describing the specific defects. */
  repairCodes: SchemaRepairCode[];
}

async function tableInfo(
  database: SQLite.SQLiteDatabase,
  table: string,
): Promise<Set<string>> {
  try {
    const result = await execute(database, `PRAGMA table_info(${table})`);
    const cols = new Set<string>();
    for (let i = 0; i < result.rows.length; i++) {
      cols.add(result.rows.item(i).name);
    }
    return cols;
  } catch {
    return new Set();
  }
}

async function indexExists(
  database: SQLite.SQLiteDatabase,
  table: string,
  indexName: string,
): Promise<boolean> {
  try {
    const result = await execute(
      database,
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name = ?",
      [table, indexName],
    );
    return result.rows.length > 0;
  } catch {
    return false;
  }
}

async function tableExists(
  database: SQLite.SQLiteDatabase,
  table: string,
): Promise<boolean> {
  const result = await execute(
    database,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    [table],
  );
  return result.rows.length > 0;
}

/**
 * Inspect the database for known Schema 32→33 provenance drift.
 *
 * Reads recorded schema_version from settings (returns 0 when unset/missing)
 * and checks the live physical structure of `canon_evidence`. A recorded-39
 * database with a missing column will report `needsRepair: true`.
 */
export async function inspectKnownSchemaDrift(
  database: SQLite.SQLiteDatabase,
): Promise<SchemaDriftReport> {
  // Recorded schema version
  let recordedSchemaVersion = 0;
  try {
    const versionResult = await execute(
      database,
      'SELECT value FROM settings WHERE key = ?',
      ['schema_version'],
    );
    if (versionResult.rows.length > 0) {
      const parsed = Number.parseInt(versionResult.rows.item(0).value, 10);
      if (Number.isFinite(parsed)) recordedSchemaVersion = parsed;
    }
  } catch {
    // settings table may not exist on a very early interrupted install; treat
    // as version 0 so the caller falls through to the fresh-install path.
  }

  const canonEvidenceExists = await tableExists(database, 'canon_evidence');

  let sourceOriginExists = false;
  let rescanOperationIdExists = false;
  if (canonEvidenceExists) {
    const cols = await tableInfo(database, 'canon_evidence');
    sourceOriginExists = cols.has('source_origin');
    rescanOperationIdExists = cols.has('rescan_operation_id');
  }
  const rescanIndexExists = await indexExists(
    database,
    'canon_evidence',
    'idx_canon_evidence_rescan_op',
  );

  const repairCodes: SchemaRepairCode[] = [];
  if (!canonEvidenceExists) {
    // The table is expected to exist from Schema 20 onward. A missing table is
    // NOT a repair target — creating an empty one would mask data loss.
    repairCodes.push('CANON_EVIDENCE_TABLE_MISSING');
  } else {
    if (!sourceOriginExists) repairCodes.push('CANON_SOURCE_ORIGIN_MISSING');
    if (!rescanOperationIdExists) {
      repairCodes.push('CANON_RESCAN_OPERATION_ID_MISSING');
    }
    if (!rescanIndexExists) repairCodes.push('CANON_RESCAN_INDEX_MISSING');
  }

  return {
    recordedSchemaVersion,
    canonEvidenceExists,
    sourceOriginExists,
    rescanOperationIdExists,
    rescanIndexExists,
    needsRepair: repairCodes.length > 0,
    repairCodes,
  };
}
