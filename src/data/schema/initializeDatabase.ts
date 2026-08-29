import type SQLite from 'react-native-sqlite-storage';
import appVersionJson from '../../constants/version.json';
import { execute } from '../connection/execute';
import {
  runMigrations,
  SCHEMA_VERSION,
  MIN_COMPATIBLE_SCHEMA_VERSION,
} from '../migrations';
import type {
  InstallInfo,
  InstallType,
  MigrationResult,
} from '../migrations/types';
import { assertValidSchema, validateSchema } from './schemaValidator';
import { createCurrentSchema } from './createCurrentSchema';
import { now } from '../repositories/shared';
import { ensureDefaultPreset } from '../repositories/presetRepository';
import { inspectKnownSchemaDrift } from './schemaDriftInspector';
import { repairKnownSchemaDrift } from './knownSchemaRepairs';
import {
  captureUserDataRecallSnapshot,
  compareRecallSnapshots,
  type UserDataRecallSnapshot,
  type RecallMismatch,
} from './userDataRecallSnapshot';
import {
  captureUserContentFingerprint,
  compareUserContentFingerprints,
  type UserContentFingerprint,
  type ContentFingerprintMismatch,
} from './userContentFingerprint';
import {
  createSchemaRecoveryBackup,
  type SchemaRecoveryBackupResult,
} from '../../services/schemaRecoveryBackup';
import {
  makeSchemaRecoveryError,
  type SchemaRecoveryError,
} from './schemaRecoveryError';
import type { StartupPhase } from '../../services/startupProgress';
import {
  attachWritingGovernorProfilePersistence,
  hydrateWritingGovernorProfiles,
} from '../../services/writing/governor/writingGovernorProfileRepository';

const GLOBAL_PROJECT_ID = 0;
const GLOBAL_PROJECT_NAME = '__tavo_global_workspace__';

/** CL-04: optional real-phase callback consumed by the App startup UI. */
export interface InitializeDatabaseOptions {
  onPhase?: (phase: StartupPhase) => void;
}

async function ensureMetadataTable(
  database: SQLite.SQLiteDatabase,
): Promise<void> {
  await execute(
    database,
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    )`,
  );
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
 * A failed first-install schema creation can leave `settings` and `projects`
 * behind before the schema version is recorded.  It contains no user project,
 * so completing the idempotent current schema is safe.  Do not use this as a
 * general Schema 0 migration path: any user project keeps the existing
 * fail-closed compatibility guard.
 */
async function isRecoverableInterruptedFreshInstall(
  database: SQLite.SQLiteDatabase,
  installInfo: InstallInfo,
): Promise<boolean> {
  if (
    installInfo.installType !== 'upgrade' ||
    installInfo.previousVersion !== null ||
    installInfo.schemaVersion !== 0
  ) {
    return false;
  }
  const result = await execute(
    database,
    'SELECT COUNT(*) AS count FROM projects WHERE id != ?',
    [GLOBAL_PROJECT_ID],
  );
  return Number(result.rows.item(0)?.count ?? 0) === 0;
}

async function ensureCurrentIndexes(
  database: SQLite.SQLiteDatabase,
): Promise<void> {
  await execute(
    database,
    'CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_month ON llm_usage_logs(project_id, created_at)',
  );
  await execute(
    database,
    'CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_config ON llm_usage_logs(llm_config_id, created_at)',
  );
}

const STARTUP_REPAIRABLE_INDEXES = new Set([
  'idx_llm_usage_logs_month',
  'idx_llm_usage_logs_config',
]);

async function validateSchemaBeforeStartup(
  database: SQLite.SQLiteDatabase,
): Promise<void> {
  const validation = await validateSchema(database, {
    requireActiveLlmConfig: false,
  });
  if (validation.valid) return;

  // Some older builds shipped a current-schema database without the
  // deterministic usage-log indexes. Repair only those known index defects;
  // missing tables, columns, foreign keys, or data-integrity issues must still
  // stop startup instead of being silently repaired here.
  const canRepairIndexes =
    validation.issues.length > 0 &&
    validation.issues.every(
      issue =>
        issue.code === 'MISSING_INDEX' &&
        issue.index !== undefined &&
        STARTUP_REPAIRABLE_INDEXES.has(issue.index),
    );
  if (!canRepairIndexes) {
    assertValidSchema(validation);
    return;
  }

  console.warn(
    '[database] repairing missing deterministic usage-log indexes before startup validation',
  );
  await ensureCurrentIndexes(database);
  assertValidSchema(
    await validateSchema(database, { requireActiveLlmConfig: false }),
  );
}

async function seedDefaults(database: SQLite.SQLiteDatabase): Promise<void> {
  await ensureGlobalProject(database);
  await execute(
    database,
    `INSERT OR IGNORE INTO llm_config (
      id, name, provider_type, base_url, api_key, model_name, is_active,
      context_window, max_output_tokens
    ) VALUES (1, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ['默认配置', 'openai_compatible', '', '', '', 0, 0],
  );
  await execute(
    database,
    "UPDATE llm_config SET name = '默认配置' WHERE id = 1 AND name = ''",
  );
  const active = await execute(database, 'SELECT id FROM llm_config WHERE is_active = 1 ORDER BY id ASC LIMIT 1');
  if (active.rows.length === 0) {
    const usable = await execute(
      database,
      'SELECT id FROM llm_config ORDER BY id ASC LIMIT 1',
    );
    if (usable.rows.length > 0) {
      await execute(
        database,
        'UPDATE llm_config SET is_active = 1 WHERE id = ?',
        [usable.rows.item(0).id],
      );
    } else {
      await execute(
        database,
        `INSERT INTO llm_config (
          name, provider_type, base_url, api_key, model_name, is_active,
          context_window, max_output_tokens
        ) VALUES (?, 'openai_compatible', '', '', '', 1, 0, 0)`,
        ['默认配置'],
      );
    }
  }
  await ensureDefaultPreset(database);
}

async function ensureGlobalProject(
  database: SQLite.SQLiteDatabase,
): Promise<void> {
  const timestamp = now();
  await execute(
    database,
    'INSERT OR IGNORE INTO projects (id, name, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [GLOBAL_PROJECT_ID, GLOBAL_PROJECT_NAME, 'outline', timestamp, timestamp],
  );
}

export async function detectInstallType(
  database: SQLite.SQLiteDatabase,
): Promise<InstallInfo> {
  const currentVersion = appVersionJson.versionName.replace(/^V/, '');
  const storedVersionResult = await execute(
    database,
    'SELECT value FROM settings WHERE key = ?',
    ['app_version'],
  );
  const storedVersion =
    storedVersionResult.rows.length > 0
      ? storedVersionResult.rows.item(0).value
      : null;
  const firstInstallResult = await execute(
    database,
    'SELECT value FROM settings WHERE key = ?',
    ['first_install_version'],
  );
  const firstInstallVersion =
    firstInstallResult.rows.length > 0
      ? firstInstallResult.rows.item(0).value
      : currentVersion;
  const schemaVersionResult = await execute(
    database,
    'SELECT value FROM settings WHERE key = ?',
    ['schema_version'],
  );
  const schemaVersion =
    schemaVersionResult.rows.length > 0
      ? Number.parseInt(schemaVersionResult.rows.item(0).value, 10)
      : 0;
  const hasProjects = await tableExists(database, 'projects');
  let installType: InstallType;
  let previousVersion: string | null = null;
  if (!storedVersion && schemaVersion === 0 && !hasProjects) {
    installType = 'fresh';
  } else if (!storedVersion || storedVersion !== currentVersion) {
    installType = 'upgrade';
    previousVersion = storedVersion;
  } else {
    installType = 'same';
  }
  return {
    installType,
    currentVersion,
    previousVersion,
    firstInstallVersion,
    schemaVersion: Number.isFinite(schemaVersion) ? schemaVersion : 0,
  };
}
async function finalizeInstallInfo(
  database: SQLite.SQLiteDatabase,
  installInfo: InstallInfo,
): Promise<void> {
  const firstInstall = await execute(
    database,
    'SELECT value FROM settings WHERE key = ?',
    ['first_install_version'],
  );
  if (firstInstall.rows.length === 0) {
    await execute(
      database,
      'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
      ['first_install_version', installInfo.currentVersion],
    );
  }
  if (installInfo.installType === 'upgrade' && installInfo.previousVersion) {
    await execute(
      database,
      'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
      ['previous_version', installInfo.previousVersion],
    );
  }
  await execute(
    database,
    'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
    ['app_version', installInfo.currentVersion],
  );
  await execute(
    database,
    'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
    ['app_version_code', String(appVersionJson.versionCode)],
  );
  await execute(
    database,
    'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
    ['install_type', installInfo.installType],
  );
}
export let lastInstallInfo: InstallInfo | null = null;
export let lastMigrationResult: MigrationResult | null = null;
/**
 * Schema-recovery state surfaced to the UI. Populated whenever the startup
 * chain performs a drift inspection, backup, or repair. `null` on a clean
 * fresh install with no drift.
 */
export interface SchemaRecoveryState {
  /** Whether a schema-recovery backup was created this launch. */
  backupCreated: boolean;
  /** Path to the schema-recovery backup file (when created). */
  backupPath?: string;
  /** Whether a known drift repair was applied. */
  repaired: boolean;
  /** Before/after recall snapshot equality (true = no data lost). */
  recallVerified: boolean;
  /** First recall mismatch (when verification fails). */
  mismatch?: RecallMismatch;
  /** Before/after core-data counts for the UI summary. */
  beforeCounts?: Record<string, number>;
  afterCounts?: Record<string, number>;
  /** The drift report that triggered the repair (when any). */
  driftCodes?: string[];
  /** Structured error (when the recovery failed). */
  error?: SchemaRecoveryError;
}

export let lastSchemaRecovery: SchemaRecoveryState | null = null;
export async function initializeDatabase(
  database: SQLite.SQLiteDatabase,
  options?: InitializeDatabaseOptions,
): Promise<void> {
  const onPhase = options?.onPhase;
  lastMigrationResult = null;
  lastSchemaRecovery = null;
  await execute(database, 'PRAGMA foreign_keys = ON');
  await ensureMetadataTable(database);
  const installInfo = await detectInstallType(database);
  lastInstallInfo = installInfo;
  const recoverInterruptedFreshInstall =
    await isRecoverableInterruptedFreshInstall(database, installInfo);

  // beforeSnapshot is captured for the non-fresh path so we can verify after
  // the repair that no user data was lost.
  let beforeSnapshot: UserDataRecallSnapshot | null = null;
  // CL-03: content-level fingerprint of the irreplaceable data. Compared
  // strictly after migration/repair — a same-count content rewrite now blocks
  // startup instead of passing the legacy count/sum check.
  let beforeContentFingerprint: UserContentFingerprint | null = null;
  let recoveryBackup: SchemaRecoveryBackupResult | null = null;
  let repairApplied = false;
  let driftCodes: string[] = [];

  if (installInfo.installType === 'fresh' || recoverInterruptedFreshInstall) {
    onPhase?.('checking_schema');
    await createCurrentSchema(database);
    await execute(
      database,
      'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
      ['schema_version', String(SCHEMA_VERSION)],
    );
  } else {
    if (installInfo.schemaVersion < MIN_COMPATIBLE_SCHEMA_VERSION) {
      throw new Error(
        `无法从 Schema ${installInfo.schemaVersion} 安全升级；最低支持版本为 ${MIN_COMPATIBLE_SCHEMA_VERSION}。`,
      );
    }
    if (installInfo.schemaVersion > SCHEMA_VERSION) {
      throw new Error(
        `当前数据库 Schema ${installInfo.schemaVersion} 高于应用支持的版本 ${SCHEMA_VERSION}。`,
      );
    }

    // ── Upgrade / same-version path: inspect → backup → repair → migrate ──
    // Even a recorded-version-equals-current database may have physical drift
    // (the core incident). We always inspect before touching the schema.
    const drift = await inspectKnownSchemaDrift(database);
    const needsMigration = installInfo.schemaVersion < SCHEMA_VERSION;
    const needsSchemaMutation = needsMigration || drift.needsRepair;
    driftCodes = drift.repairCodes;

    // 1. Capture BEFORE recall snapshot (user's irreplaceable data identity)
    //    + content-level fingerprint (CL-03). Both are captured before any
    //    schema mutation. A fingerprint read failure throws — fail-closed.
    onPhase?.('capturing_fingerprint');
    beforeSnapshot = await captureUserDataRecallSnapshot(database);
    beforeContentFingerprint = await captureUserContentFingerprint(database);

    // 2. Create + verify a schema-recovery backup BEFORE any schema mutation.
    if (needsSchemaMutation) {
      onPhase?.('creating_backup');
      try {
        recoveryBackup = await createSchemaRecoveryBackup(
          database,
          needsMigration ? 'pre_migration' : 'schema_recovery',
          // F2-04: the backup describes the SOURCE database — the schema
          // version of the DB as found on disk, not the migration target.
          installInfo.schemaVersion,
        );
      } catch (backupError) {
        const err = makeSchemaRecoveryError(
          'RECOVERY_BACKUP_FAILED',
          backupError instanceof Error
            ? backupError.message
            : String(backupError),
        );
        lastSchemaRecovery = {
          backupCreated: false,
          repaired: false,
          recallVerified: false,
          driftCodes,
          error: err,
        };
        throw err;
      }
    }

    // 3. Pre-migration known repair (idempotent — heals drift the versioned
    //    migration engine would skip on a recorded-version-equals DB).
    if (drift.needsRepair) {
      const repairResult = await repairKnownSchemaDrift(database, drift);
      if (!repairResult.ok) {
        const err = makeSchemaRecoveryError(
          'KNOWN_SCHEMA_REPAIR_FAILED',
          repairResult.message,
        );
        lastSchemaRecovery = {
          backupCreated: recoveryBackup !== null,
          backupPath: recoveryBackup?.path,
          repaired: false,
          recallVerified: false,
          driftCodes,
          error: err,
        };
        throw err;
      }
      repairApplied = true;
    }

    // 4. Run versioned migrations (to Schema 40). 32→33 is now idempotent.
    if (needsMigration) {
      onPhase?.('migrating');
      lastMigrationResult = await runMigrations(
        database,
        installInfo.schemaVersion,
      );
    }

    // 5. Post-migration known repair (idempotent — covers a recorded-40 DB
    //    whose physical columns drifted again after a backup restore).
    const postDrift = await inspectKnownSchemaDrift(database);
    if (postDrift.needsRepair) {
      const postRepair = await repairKnownSchemaDrift(database, postDrift);
      if (!postRepair.ok) {
        const err = makeSchemaRecoveryError(
          'KNOWN_SCHEMA_REPAIR_FAILED',
          postRepair.message,
        );
        lastSchemaRecovery = {
          backupCreated: recoveryBackup !== null,
          backupPath: recoveryBackup?.path,
          repaired: repairApplied,
          recallVerified: false,
          driftCodes: postDrift.repairCodes,
          error: err,
        };
        throw err;
      }
      repairApplied = true;
      driftCodes = [...new Set([...driftCodes, ...postDrift.repairCodes])];
    }
  }

  // 6. Strict schema validation (now AFTER repair so a drifted DB can pass).
  onPhase?.('validating_schema');
  await validateSchemaBeforeStartup(database);

  // 7. Seed defaults + indexes + note repair.
  await seedDefaults(database);
  await ensureCurrentIndexes(database);
  // RB-16 fix (V2.11.34): the previous implementation called
  // `repairOversizedNotes(database)` here on every cold start. That was
  // destructive (it splits oversized notes, deletes the original note
  // and replaces it with chunks), could leave the database in an
  // inconsistent state if it crashed mid-repair, and had no user
  // confirmation / rollback path. The V2.11.34 plan moves this to an
  // explicit maintenance action under Settings → 数据维护 (gated by
  // the `startup_note_repair_enabled` feature flag). We deliberately
  // do NOT read the flag here, because reading it would force the
  // settingsRepository to call `openDatabase()` on the cached singleton
  // and break the startup path. Future maintenance UI will invoke
  // `repairOversizedNotes` explicitly with its own safety backup.
  //
  // Function `repairOversizedNotes` is still exported from
  // `noteRepository.ts` for the future maintenance screen to consume.

  // 8. Final strict validation.
  assertValidSchema(await validateSchema(database));

  // C3 P0: hydrate the bounded Governor aggregate before any writing entry
  // can use production recommendations, then bind future known-result writes
  // to this already-open database. The repository never reads or writes
  // prompts, messages, manuscript text, Canon, Memory, or credentials.
  await hydrateWritingGovernorProfiles(database);
  attachWritingGovernorProfilePersistence(database);

  // 9. After-repair recall snapshot + comparison. When we captured a before
  //    snapshot, assert no user data was lost. A mismatch blocks startup.
  if (beforeSnapshot) {
    const afterSnapshot = await captureUserDataRecallSnapshot(database);
    const mismatch = compareRecallSnapshots(beforeSnapshot, afterSnapshot);
    if (mismatch) {
      const err = makeSchemaRecoveryError(
        'USER_DATA_RECALL_MISMATCH',
        `用户资料召回校验失败：${mismatch.table} ${mismatch.reason}（before=${mismatch.beforeCount}, after=${mismatch.afterCount}）`,
        { mismatch },
      );
      lastSchemaRecovery = {
        backupCreated: recoveryBackup !== null,
        backupPath: recoveryBackup?.path,
        repaired: repairApplied,
        recallVerified: false,
        mismatch,
        driftCodes,
        error: err,
      };
      throw err;
    }
    // Surface recovery state to the UI when a backup or repair happened.
    if (recoveryBackup || repairApplied) {
      lastSchemaRecovery = {
        backupCreated: recoveryBackup !== null,
        backupPath: recoveryBackup?.path,
        repaired: repairApplied,
        recallVerified: true,
        beforeCounts: snapshotCounts(beforeSnapshot),
        afterCounts: snapshotCounts(afterSnapshot),
        driftCodes,
      };
    }
  }

  // 9b. CL-03: content-level fingerprint strict compare. Any content rewrite
  //     of projects / chapters / characters / worldbook_entries / notes /
  //     project_resources / project_collection_settings across the upgrade
  //     blocks startup — the original DB and the schema-recovery backup stay
  //     untouched for the user.
  if (beforeContentFingerprint) {
    onPhase?.('verifying_content');
    const afterContentFingerprint = await captureUserContentFingerprint(database);
    // v4→v5 / v10→v11 normalize collection_id = 0 → real binding; those
    // migrations only run for libraries below Schema 11.
    const allowCollectionIdMigration = installInfo.schemaVersion < 11;
    const contentMismatch: ContentFingerprintMismatch | null =
      compareUserContentFingerprints(beforeContentFingerprint, afterContentFingerprint, {
        allowCollectionIdMigration,
      });
    if (contentMismatch) {
      const err = makeSchemaRecoveryError(
        'USER_CONTENT_FINGERPRINT_MISMATCH',
        `升级前后内容指纹不一致，已停止启动并保留原数据库与安全备份：${contentMismatch.detail}`,
        { mismatch: contentMismatch as unknown as RecallMismatch },
      );
      lastSchemaRecovery = {
        backupCreated: recoveryBackup !== null,
        backupPath: recoveryBackup?.path,
        repaired: repairApplied,
        recallVerified: false,
        mismatch: contentMismatch as unknown as RecallMismatch,
        driftCodes,
        error: err,
      };
      throw err;
    }
  }

  await finalizeInstallInfo(database, installInfo);
  lastInstallInfo = installInfo;
}

/**
 * Extract a compact count summary from a recall snapshot for UI display.
 */
function snapshotCounts(
  snapshot: UserDataRecallSnapshot,
): Record<string, number> {
  return {
    projects: snapshot.projects.count,
    chapters: snapshot.chapters.count,
    character_collections: snapshot.characterCollections.count,
    characters: snapshot.characters.count,
    worldbook_collections: snapshot.worldbookCollections.count,
    worldbook_entries: snapshot.worldbookEntries.count,
    notes: snapshot.notes.count,
    project_resources: snapshot.projectResources.count,
    project_collection_settings: snapshot.projectCollectionSettings.count,
  };
}

export async function repairKnownSchemaDefects(
  database: SQLite.SQLiteDatabase,
  schemaVersion: number,
): Promise<void> {
  // Historical column additions are now owned by their versioned migration.
  // This diagnostic keeps the old compatibility hook explicit without
  // becoming a second, unbounded migration engine.
  if (schemaVersion <= 0 || schemaVersion >= SCHEMA_VERSION) return;
  const result = await execute(
    database,
    'SELECT value FROM settings WHERE key = ?',
    ['schema_version'],
  );
  const recordedVersion =
    result.rows.length > 0 ? result.rows.item(0).value : 'missing';
  console.debug(
    `[database] schema ${schemaVersion} repairs are migration-owned; ` +
      `validated schema_version=${String(recordedVersion)}`,
  );
}
