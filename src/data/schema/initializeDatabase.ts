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
import { repairOversizedNotes } from '../repositories/noteRepository';

const GLOBAL_PROJECT_ID = 0;
const GLOBAL_PROJECT_NAME = '__tavo_global_workspace__';

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
      local_model_id, local_backend, context_window, max_output_tokens
    ) VALUES (1, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    ['默认配置', 'openai_compatible', '', '', '', null, null, 4096, 4000],
  );
  await execute(
    database,
    "UPDATE llm_config SET name = '默认配置' WHERE id = 1 AND name = ''",
  );
  const active = await execute(
    database,
    `SELECT c.id
     FROM llm_config c
     LEFT JOIN local_llm_models m ON m.id = c.local_model_id
     WHERE c.is_active = 1
       AND (
         COALESCE(c.provider_type, 'openai_compatible') NOT IN ('llama_cpp', 'local_litertlm')
         OR (c.local_model_id IS NOT NULL AND m.status = 'ready')
       )
     ORDER BY c.id ASC
     LIMIT 1`,
  );
  if (active.rows.length === 0) {
    const usable = await execute(
      database,
      `SELECT c.id
       FROM llm_config c
       LEFT JOIN local_llm_models m ON m.id = c.local_model_id
       WHERE COALESCE(c.provider_type, 'openai_compatible') NOT IN ('llama_cpp', 'local_litertlm')
          OR (c.local_model_id IS NOT NULL AND m.status = 'ready')
       ORDER BY c.id ASC
       LIMIT 1`,
    );
    if (usable.rows.length > 0) {
      await execute(
        database,
        'UPDATE llm_config SET is_active = 1 WHERE id = ?',
        [usable.rows.item(0).id],
      );
    } else {
      // A restore may contain only a local configuration whose GGUF file is
      // absent. Keep that configuration inactive and seed a blank online
      // fallback so the next startup remains usable and can prompt for
      // re-import instead of activating a broken local model.
      await execute(
        database,
        `INSERT INTO llm_config (
          name, provider_type, base_url, api_key, model_name, is_active,
          local_model_id, local_backend, context_window, max_output_tokens
        ) VALUES (?, 'openai_compatible', '', '', '', 1, NULL, NULL, 4096, 4000)`,
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
export async function initializeDatabase(
  database: SQLite.SQLiteDatabase,
): Promise<void> {
  lastMigrationResult = null;
  await execute(database, 'PRAGMA foreign_keys = ON');
  await ensureMetadataTable(database);
  const installInfo = await detectInstallType(database);
  lastInstallInfo = installInfo;
  if (installInfo.installType === 'fresh') {
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
    if (installInfo.schemaVersion < SCHEMA_VERSION) {
      lastMigrationResult = await runMigrations(
        database,
        installInfo.schemaVersion,
      );
    }
  }
  await validateSchemaBeforeStartup(database);
  await repairKnownSchemaDefects(database, installInfo.schemaVersion);
  await seedDefaults(database);
  // Indexes are deterministic, idempotent schema artifacts. Keep this after
  // validation and seeding so index creation cannot mask a migration defect.
  await ensureCurrentIndexes(database);
  await repairOversizedNotes(database);
  assertValidSchema(await validateSchema(database));
  await finalizeInstallInfo(database, installInfo);
  // Keep the detected source schema for the upgrade screen and automatic
  // backup flow; lastMigrationResult carries the successful target version.
  lastInstallInfo = installInfo;
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
