import type SQLite from 'react-native-sqlite-storage';
import { execute } from '../connection/execute';
import {
  executeTransaction,
  type SqlStatement,
} from '../../services/database/transaction';
import { sha256Hex } from '../../services/continuation/hashUtils';

/**
 * Durable startup markers.  A clean marker is written only after the whole
 * startup chain has completed successfully.  Any process death during a
 * migration, repair, restore, or validation therefore leaves the next launch
 * on the deep/safe path.
 */
export const STARTUP_DB_STATE_KEY = 'startup_db_state';
export const STARTUP_INTEGRITY_MARKER_KEY = 'startup_integrity_marker';
export const LAST_VERIFIED_SCHEMA_VERSION_KEY = 'last_verified_schema_version';
export const LAST_SUCCESSFUL_SCHEMA_VERSION_KEY =
  'last_successful_schema_version';
export const SCHEMA_SIGNATURE_KEY = 'schema_signature';
export const MIGRATION_IN_PROGRESS_KEY = 'migration_in_progress';
export const RECOVERY_REQUIRED_KEY = 'recovery_required';
export const DATABASE_RESTORE_PENDING_KEY = 'database_restore_pending';
export const DATABASE_IMPORT_PENDING_KEY = 'database_import_pending';
export const SCHEMA_RECOVERY_PENDING_KEY = 'schema_recovery_pending';

export const STARTUP_DB_STATE_CLEAN = 'clean';
export const STARTUP_DB_STATE_IN_PROGRESS = 'in_progress';
export const STARTUP_DB_STATE_DEEP_REQUIRED = 'deep_required';

export const STARTUP_INTEGRITY_VERIFIED = 'v1:verified';
export const STARTUP_INTEGRITY_CHECKING = 'v1:checking';
export const STARTUP_INTEGRITY_NEEDS_VERIFICATION = 'v1:needs_verification';

const TRUE_VALUE = 'true';
const FALSE_VALUE = 'false';

/** The metadata keys read by the fast-path decision. */
export const STARTUP_METADATA_KEYS = [
  STARTUP_DB_STATE_KEY,
  STARTUP_INTEGRITY_MARKER_KEY,
  LAST_VERIFIED_SCHEMA_VERSION_KEY,
  LAST_SUCCESSFUL_SCHEMA_VERSION_KEY,
  SCHEMA_SIGNATURE_KEY,
  MIGRATION_IN_PROGRESS_KEY,
  RECOVERY_REQUIRED_KEY,
  DATABASE_RESTORE_PENDING_KEY,
  DATABASE_IMPORT_PENDING_KEY,
  SCHEMA_RECOVERY_PENDING_KEY,
] as const;

/**
 * This is intentionally a small liveness probe, not a replacement for the
 * schema manifest validator.  The full schema signature below catches the
 * rest of the physical structure without scanning user content.
 */
export const STARTUP_REQUIRED_TABLES = [
  'settings',
  'projects',
  'chapters',
  'llm_config',
  'presets',
  'llm_usage_logs',
  'writing_governor_profiles',
  'writing_request_receipts',
] as const;

export interface StartupDatabaseState {
  state: string | null;
  integrityMarker: string | null;
  lastVerifiedSchemaVersion: string | null;
  lastSuccessfulSchemaVersion: string | null;
  schemaSignature: string | null;
  migrationInProgress: string | null;
  recoveryRequired: string | null;
  databaseRestorePending: string | null;
  databaseImportPending: string | null;
  schemaRecoveryPending: string | null;
}

export interface StartupDatabaseStateWriteOptions {
  state?: string;
  integrityMarker?: string;
  lastVerifiedSchemaVersion?: number | string;
  lastSuccessfulSchemaVersion?: number | string;
  schemaSignature?: string;
  migrationInProgress?: boolean;
  recoveryRequired?: boolean;
  databaseRestorePending?: boolean;
  databaseImportPending?: boolean;
  schemaRecoveryPending?: boolean;
}

function valueForBoolean(value: boolean): string {
  return value ? TRUE_VALUE : FALSE_VALUE;
}

function pushSetting(
  statements: SqlStatement[],
  key: string,
  value: string | number,
): void {
  statements.push({
    sql: 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
    params: [key, String(value)],
  });
}

export function buildStartupDatabaseStateStatements(
  options: StartupDatabaseStateWriteOptions,
): SqlStatement[] {
  const statements: SqlStatement[] = [];
  if (options.state !== undefined) {
    pushSetting(statements, STARTUP_DB_STATE_KEY, options.state);
  }
  if (options.integrityMarker !== undefined) {
    pushSetting(
      statements,
      STARTUP_INTEGRITY_MARKER_KEY,
      options.integrityMarker,
    );
  }
  if (options.lastVerifiedSchemaVersion !== undefined) {
    pushSetting(
      statements,
      LAST_VERIFIED_SCHEMA_VERSION_KEY,
      options.lastVerifiedSchemaVersion,
    );
  }
  if (options.lastSuccessfulSchemaVersion !== undefined) {
    pushSetting(
      statements,
      LAST_SUCCESSFUL_SCHEMA_VERSION_KEY,
      options.lastSuccessfulSchemaVersion,
    );
  }
  if (options.schemaSignature !== undefined) {
    pushSetting(statements, SCHEMA_SIGNATURE_KEY, options.schemaSignature);
  }
  if (options.migrationInProgress !== undefined) {
    pushSetting(
      statements,
      MIGRATION_IN_PROGRESS_KEY,
      valueForBoolean(options.migrationInProgress),
    );
  }
  if (options.recoveryRequired !== undefined) {
    pushSetting(
      statements,
      RECOVERY_REQUIRED_KEY,
      valueForBoolean(options.recoveryRequired),
    );
  }
  if (options.databaseRestorePending !== undefined) {
    pushSetting(
      statements,
      DATABASE_RESTORE_PENDING_KEY,
      valueForBoolean(options.databaseRestorePending),
    );
  }
  if (options.databaseImportPending !== undefined) {
    pushSetting(
      statements,
      DATABASE_IMPORT_PENDING_KEY,
      valueForBoolean(options.databaseImportPending),
    );
  }
  if (options.schemaRecoveryPending !== undefined) {
    pushSetting(
      statements,
      SCHEMA_RECOVERY_PENDING_KEY,
      valueForBoolean(options.schemaRecoveryPending),
    );
  }
  return statements;
}

export async function readStartupDatabaseState(
  database: SQLite.SQLiteDatabase,
): Promise<StartupDatabaseState> {
  const placeholders = STARTUP_METADATA_KEYS.map(() => '?').join(', ');
  const result = await execute(
    database,
    `SELECT key, value FROM settings WHERE key IN (${placeholders})`,
    [...STARTUP_METADATA_KEYS],
  );
  const values = new Map<string, string>();
  for (let index = 0; index < result.rows.length; index += 1) {
    const row = result.rows.item(index);
    if (row?.key !== undefined)
      values.set(String(row.key), String(row.value ?? ''));
  }
  return {
    state: values.get(STARTUP_DB_STATE_KEY) ?? null,
    integrityMarker: values.get(STARTUP_INTEGRITY_MARKER_KEY) ?? null,
    lastVerifiedSchemaVersion:
      values.get(LAST_VERIFIED_SCHEMA_VERSION_KEY) ?? null,
    lastSuccessfulSchemaVersion:
      values.get(LAST_SUCCESSFUL_SCHEMA_VERSION_KEY) ?? null,
    schemaSignature: values.get(SCHEMA_SIGNATURE_KEY) ?? null,
    migrationInProgress: values.get(MIGRATION_IN_PROGRESS_KEY) ?? null,
    recoveryRequired: values.get(RECOVERY_REQUIRED_KEY) ?? null,
    databaseRestorePending: values.get(DATABASE_RESTORE_PENDING_KEY) ?? null,
    databaseImportPending: values.get(DATABASE_IMPORT_PENDING_KEY) ?? null,
    schemaRecoveryPending: values.get(SCHEMA_RECOVERY_PENDING_KEY) ?? null,
  };
}

export async function markStartupDatabaseInProgress(
  database: SQLite.SQLiteDatabase,
  options: {
    migrationInProgress: boolean;
    recoveryRequired: boolean;
  },
): Promise<void> {
  await executeTransaction(
    database,
    buildStartupDatabaseStateStatements({
      state: STARTUP_DB_STATE_IN_PROGRESS,
      integrityMarker: STARTUP_INTEGRITY_CHECKING,
      migrationInProgress: options.migrationInProgress,
      recoveryRequired: options.recoveryRequired,
      databaseRestorePending: false,
      databaseImportPending: false,
      schemaRecoveryPending: false,
    }),
  );
}

export async function markStartupDatabaseClean(
  database: SQLite.SQLiteDatabase,
  schemaVersion: number,
  schemaSignature: string,
): Promise<void> {
  await executeTransaction(
    database,
    buildStartupDatabaseStateStatements({
      state: STARTUP_DB_STATE_CLEAN,
      integrityMarker: STARTUP_INTEGRITY_VERIFIED,
      lastVerifiedSchemaVersion: schemaVersion,
      lastSuccessfulSchemaVersion: schemaVersion,
      schemaSignature,
      migrationInProgress: false,
      recoveryRequired: false,
      databaseRestorePending: false,
      databaseImportPending: false,
      schemaRecoveryPending: false,
    }),
  );
}

export async function markStartupDatabaseDeepRequired(
  database: SQLite.SQLiteDatabase,
): Promise<void> {
  await executeTransaction(
    database,
    buildStartupDatabaseStateStatements({
      state: STARTUP_DB_STATE_DEEP_REQUIRED,
      integrityMarker: STARTUP_INTEGRITY_NEEDS_VERIFICATION,
      migrationInProgress: false,
      recoveryRequired: true,
      databaseRestorePending: true,
      databaseImportPending: false,
      schemaRecoveryPending: true,
    }),
  );
}

export async function findMissingStartupTables(
  database: SQLite.SQLiteDatabase,
): Promise<string[]> {
  const placeholders = STARTUP_REQUIRED_TABLES.map(() => '?').join(', ');
  const result = await execute(
    database,
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name IN (${placeholders})`,
    [...STARTUP_REQUIRED_TABLES],
  );
  const present = new Set<string>();
  for (let index = 0; index < result.rows.length; index += 1) {
    const name = result.rows.item(index)?.name;
    if (name !== undefined) present.add(String(name));
  }
  return STARTUP_REQUIRED_TABLES.filter(table => !present.has(table));
}

/**
 * Hash SQLite's physical schema metadata only.  This intentionally reads no
 * user rows and is therefore suitable for the normal-launch fast path.
 */
export async function captureDatabaseSchemaSignature(
  database: SQLite.SQLiteDatabase,
): Promise<string> {
  const result = await execute(
    database,
    `SELECT type, name, tbl_name, COALESCE(sql, '') AS sql
       FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
        AND type IN ('table', 'index', 'trigger', 'view')
      ORDER BY type ASC, name ASC, tbl_name ASC, sql ASC`,
  );
  const rows: string[] = [];
  for (let index = 0; index < result.rows.length; index += 1) {
    const row = result.rows.item(index);
    rows.push(
      [row?.type, row?.name, row?.tbl_name, row?.sql]
        .map(value => String(value ?? ''))
        .join('\u001f'),
    );
  }
  return sha256Hex(rows.join('\u001e'));
}
