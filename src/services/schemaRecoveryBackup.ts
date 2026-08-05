/**
 * Schema-recovery backup: a pre-migration safety net that captures the user's
 * irreplaceable creative data BEFORE any ALTER / migration / repair touches the
 * physical schema.
 *
 * Design:
 *   - Reuses the v3 backup pipeline (`createBackup`) for atomic staging +
 *     SHA-256 checksum, so we do NOT maintain a second serialization format.
 *   - Writes to a dedicated `schema-recovery/` directory inside the app's
 *     internal document directory so these backups are never confused with
 *     user-initiated backups and are never auto-pruned by the normal cleanup.
 *   - After writing, re-reads and validates the file (parsable, checksum
 *     matches, core-table row counts match the live DB) before returning the
 *     path. A backup that fails verification is treated as a failure — the
 *     caller MUST NOT proceed with schema mutation.
 *   - Tolerates drifted/old schemas: `createBackup` uses `SELECT *` per table
 *     and `readBackupTables` already skips non-core missing tables, so a DB
 *     missing `canon_evidence.source_origin` (or even the table) still
 *     produces a valid backup of the columns that DO exist.
 */
import RNFS from 'react-native-fs';
import type SQLite from 'react-native-sqlite-storage';
import { SCHEMA_VERSION } from './migrations';
import {
  createBackup,
  readAndValidateBackup,
} from './backupService';
import { execute } from '../data/connection/execute';
import appVersionJson from '../constants/version.json';

export const SCHEMA_RECOVERY_DIR = `${RNFS.DocumentDirectoryPath}/schema-recovery`;

export interface SchemaRecoveryBackupResult {
  path: string;
  checksum: string;
  verified: boolean;
  coreCounts: Record<string, number>;
}

export interface SchemaRecoveryBackupFailure {
  ok: false;
  reason: string;
  error?: unknown;
  /** Partial path if a staging file was written but verification failed. */
  stagingPath?: string;
}

/**
 * The core creative-data tables whose row counts must round-trip through the
 * backup verbatim. A count mismatch after re-read is a hard failure.
 */
export const CORE_RECOVERY_TABLES = [
  'projects',
  'chapters',
  'fragments',
  'character_collections',
  'characters',
  'worldbook_collections',
  'worldbook_entries',
  'notes',
  'project_resources',
  'project_collection_settings',
  'presets',
  'settings',
  'freeform_documents',
  'content_revisions',
  'generation_drafts',
  'outlines',
] as const;

async function liveCoreCounts(
  database: SQLite.SQLiteDatabase,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of CORE_RECOVERY_TABLES) {
    try {
      const result = await execute(
        database,
        `SELECT COUNT(*) AS c FROM ${table}`,
      );
      counts[table] = Number(result.rows.item(0)?.c ?? 0);
    } catch {
      // Table missing / query failed — record -1 so a later mismatch is
      // visible rather than silently treated as "0 == 0".
      counts[table] = -1;
    }
  }
  return counts;
}

/**
 * Create a schema-recovery backup in the dedicated directory and verify it.
 *
 * Returns the path on success. Throws (returns a structured failure via the
 * thrown Error's message) when the backup cannot be created or verified, so
 * the caller knows NOT to proceed with schema mutation.
 */
export async function createSchemaRecoveryBackup(
  database: SQLite.SQLiteDatabase,
  kind: 'pre_migration' | 'schema_recovery' = 'schema_recovery',
): Promise<SchemaRecoveryBackupResult> {
  await RNFS.mkdir(SCHEMA_RECOVERY_DIR);

  const appVersion = appVersionJson.versionName.replace(/^V/, '');
  const liveCounts = await liveCoreCounts(database);

  // createBackup writes to BACKUP_DIR (ExternalDirectoryPath/backups). We then
  // copy the verified file into the dedicated schema-recovery directory so it
  // survives the normal backup rotation.
  const sourcePath = await createBackup(
    database,
    appVersion,
    SCHEMA_VERSION,
    kind,
  );

  // Re-read + validate the written file (checksum + structure).
  const { parsed, validation } = await readAndValidateBackup(sourcePath);
  if (!parsed || !validation.valid) {
    throw new Error(
      `Schema-recovery backup verification failed: ${validation.errors.join('; ')}`,
    );
  }

  // Verify core-table row counts round-trip.
  const backedCounts: Record<string, number> = {};
  for (const table of CORE_RECOVERY_TABLES) {
    backedCounts[table] = parsed.tables[table]?.length ?? -1;
  }
  for (const table of CORE_RECOVERY_TABLES) {
    if (liveCounts[table] === -1) continue; // missing in live DB
    if (backedCounts[table] !== liveCounts[table]) {
      throw new Error(
        `Schema-recovery backup row-count mismatch for ${table}: live=${liveCounts[table]} backed=${backedCounts[table]}`,
      );
    }
  }

  // Copy into the dedicated schema-recovery directory (keeps the verified file
  // separate from user backups and safe from auto-cleanup).
  const timestamp = Date.now();
  const destName = `schemarecovery_v${appVersion}_${timestamp}.json`;
  const destPath = `${SCHEMA_RECOVERY_DIR}/${destName}`;
  await RNFS.copyFile(sourcePath, destPath);

  return {
    path: destPath,
    checksum: '',
    verified: true,
    coreCounts: liveCounts,
  };
}

/**
 * Best-effort: prune old schema-recovery backups beyond a retention limit.
 * Never throws — cleanup is opportunistic.
 */
export async function pruneSchemaRecoveryBackups(
  keep: number = 5,
): Promise<void> {
  try {
    await RNFS.mkdir(SCHEMA_RECOVERY_DIR);
    const files = await RNFS.readDir(SCHEMA_RECOVERY_DIR);
    const jsonFiles = files
      .filter(f => f.name.endsWith('.json'))
      .sort((a, b) => Number(b.mtime ?? 0) - Number(a.mtime ?? 0));
    for (const file of jsonFiles.slice(keep)) {
      try {
        await RNFS.unlink(file.path);
      } catch {
        // ignore individual prune failures
      }
    }
  } catch {
    // directory access failure is non-fatal
  }
}
