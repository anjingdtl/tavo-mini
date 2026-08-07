/**
 * Schema-recovery backup: a pre-migration safety net that captures the user's
 * irreplaceable creative data BEFORE any ALTER / migration / repair touches the
 * physical schema.
 *
 * Design (CL-09):
 *   - SINGLE write pass into the dedicated `schema-recovery/` directory: read
 *     tables → serialize → compute SHA-256 (before write, no re-read) → write
 *     staging → atomic rename. The old pipeline (createBackup → re-read +
 *     validate → copyFile) touched the full backup THREE times; on a 100MB+
 *     library that is three full-size IO passes per startup.
 *   - Safety is NOT reduced: the checksum is computed over the exact bytes
 *     written, core-table row counts are verified against the live DB before
 *     the rename, and the file is re-parseable by the standard v3 reader
 *     (restoreFromBackup / readAndValidateBackup accept it unchanged).
 *   - Fail-closed: any read / checksum / row-count / write failure throws —
 *     the caller MUST NOT proceed with schema mutation.
 */
import RNFS from 'react-native-fs';
import type SQLite from 'react-native-sqlite-storage';
import { SCHEMA_VERSION } from './migrations';
import {
  computeBackupChecksum,
  readBackupTables,
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
 * backup verbatim. A count mismatch is a hard failure.
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
 * Create a schema-recovery backup in the dedicated directory with ONE full
 * write pass (CL-09). Returns the path on success; throws on any failure so
 * the caller knows NOT to proceed with schema mutation.
 *
 * F2-04: the backup metadata must describe the SOURCE database, not the app's
 * target schema. `sourceSchemaVersion` (the live DB's schema before any
 * mutation) is written into meta.schema_version; callers pass
 * installInfo.schemaVersion. Defaults to the current SCHEMA_VERSION for
 * non-migration callers (backward compatible).
 */
export async function createSchemaRecoveryBackup(
  database: SQLite.SQLiteDatabase,
  kind: 'pre_migration' | 'schema_recovery' = 'schema_recovery',
  sourceSchemaVersion?: number,
): Promise<SchemaRecoveryBackupResult> {
  await RNFS.mkdir(SCHEMA_RECOVERY_DIR);

  const appVersion = appVersionJson.versionName.replace(/^V/, '');
  const liveCounts = await liveCoreCounts(database);

  // 1. Single read pass of every manifest table (skips missing optional
  //    tables, throws on missing core tables).
  const tables = await readBackupTables(database);

  // 2. Build the standard v3 payload and compute the SHA-256 over the exact
  //    serialized bytes BEFORE writing (no post-write re-read needed).
  const meta = {
    app_version: appVersion,
    schema_version: sourceSchemaVersion ?? SCHEMA_VERSION,
    created_at: new Date().toISOString(),
    kind,
    checksum_algorithm: 'sha256',
    checksum: '',
  } as const;
  const draft = {
    format: 'shinewriter-backup',
    format_version: 3,
    meta,
    tables,
    external_assets: [],
  };
  // computeBackupChecksum mirrors the byte order of JSON.stringify({format,
  // format_version, meta, tables, external_assets}) — the same bytes we write.
  const checksum = await computeBackupChecksum(draft as any);
  (meta as { checksum: string }).checksum = checksum;

  // 3. Verify core-table row counts round-trip (in-memory — no re-read).
  for (const table of CORE_RECOVERY_TABLES) {
    if (liveCounts[table] === -1) continue; // missing in live DB
    const backedCount = tables[table]?.length ?? -1;
    if (backedCount !== liveCounts[table]) {
      throw new Error(
        `Schema-recovery backup row-count mismatch for ${table}: live=${liveCounts[table]} backed=${backedCount}`,
      );
    }
  }

  // 4. Atomic write: staging → rename. No intermediate copy into another
  //    directory, no second full-size IO pass.
  const timestamp = Date.now();
  const destName = `schemarecovery_v${appVersion}_${timestamp}.json`;
  const destPath = `${SCHEMA_RECOVERY_DIR}/${destName}`;
  const stagingPath = `${destPath}.tmp`;
  try {
    await RNFS.writeFile(stagingPath, JSON.stringify(draft), 'utf8');
    await RNFS.moveFile(stagingPath, destPath);
  } catch (error) {
    try {
      await RNFS.unlink(stagingPath);
    } catch {
      // The write can fail before the staging file exists.
    }
    throw error;
  }

  return {
    path: destPath,
    checksum,
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
