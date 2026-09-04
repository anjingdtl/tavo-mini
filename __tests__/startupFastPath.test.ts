/* eslint-env jest */

import * as fingerprintModule from '../src/data/schema/userContentFingerprint';
import * as recallModule from '../src/data/schema/userDataRecallSnapshot';
import appVersionJson from '../src/constants/version.json';
import {
  initializeDatabase,
  lastMigrationResult,
  lastSchemaRecovery,
  lastStartupDeepReason,
  lastStartupPath,
  lastStartupTimings,
} from '../src/data/schema/initializeDatabase';
import {
  createEmptyInMemoryDb,
  type InMemorySqliteDb,
} from './helpers/canonInMemoryDb';
import {
  dropProvenanceColumns,
  setupInMemoryFs,
} from './schema40-fixture-helpers';
import { SCHEMA_VERSION } from '../src/services/migrations';

describe('database startup Fast Path / deep-path safety boundary', () => {
  let database: InMemorySqliteDb | null = null;

  beforeEach(() => {
    setupInMemoryFs();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (database) {
      database.close();
      database = null;
    }
  });

  async function createCleanDatabase(): Promise<InMemorySqliteDb> {
    database = await createEmptyInMemoryDb();
    await initializeDatabase(database as any);
    return database;
  }

  it('首次安装走 deep，并在全部校验完成后写入 clean marker', async () => {
    const db = await createCleanDatabase();

    const [state] = await db.executeSql(
      `SELECT key, value FROM settings
       WHERE key IN ('startup_db_state', 'startup_integrity_marker',
         'last_verified_schema_version', 'last_successful_schema_version',
         'migration_in_progress', 'recovery_required')
       ORDER BY key`,
    );
    const values = new Map<string, string>();
    for (let index = 0; index < state.rows.length; index += 1) {
      const row = state.rows.item(index);
      values.set(String(row.key), String(row.value));
    }

    expect(lastStartupPath).toBe('deep');
    expect(lastStartupDeepReason).toBe('fresh_install');
    expect(values.get('startup_db_state')).toBe('clean');
    expect(values.get('startup_integrity_marker')).toBe('v1:verified');
    expect(values.get('last_verified_schema_version')).toBe(
      String(SCHEMA_VERSION),
    );
    expect(values.get('last_successful_schema_version')).toBe(
      String(SCHEMA_VERSION),
    );
    expect(values.get('migration_in_progress')).toBe('false');
    expect(values.get('recovery_required')).toBe('false');

    const [metadata] = await db.executeSql(
      `SELECT key, value FROM settings
       WHERE key IN ('first_install_version', 'app_version',
         'app_version_code', 'install_type')
       ORDER BY key`,
    );
    const metadataValues = new Map<string, string>();
    for (let index = 0; index < metadata.rows.length; index += 1) {
      const row = metadata.rows.item(index);
      metadataValues.set(String(row.key), String(row.value));
    }
    expect(metadataValues.get('first_install_version')).toBe(
      appVersionJson.versionName.replace(/^V/, ''),
    );
    expect(metadataValues.get('app_version')).toBe(
      appVersionJson.versionName.replace(/^V/, ''),
    );
    expect(metadataValues.get('app_version_code')).toBe(
      String(appVersionJson.versionCode),
    );
    expect(metadataValues.get('install_type')).toBe('fresh');
  });

  it('current clean schema uses Fast Path without recall/fingerprint/full validation', async () => {
    const db = await createCleanDatabase();
    const fingerprintSpy = jest.spyOn(
      fingerprintModule,
      'captureUserContentFingerprint',
    );
    const recallSpy = jest.spyOn(recallModule, 'captureUserDataRecallSnapshot');

    await initializeDatabase(db as any);

    expect(lastStartupPath).toBe('fast');
    expect(lastStartupDeepReason).toBeNull();
    expect(lastMigrationResult).toBeNull();
    expect(lastSchemaRecovery).toBeNull();
    expect(fingerprintSpy).not.toHaveBeenCalled();
    expect(recallSpy).not.toHaveBeenCalled();
    expect(lastStartupTimings).toEqual(
      expect.objectContaining({
        fingerprint: 0,
        recall: 0,
        deep_validation: 0,
        total: expect.any(Number),
      }),
    );
  });

  it('app version changes alone do not force a deep scan', async () => {
    const db = await createCleanDatabase();
    await db.executeSql(
      `INSERT OR REPLACE INTO settings (key, value)
       VALUES ('app_version', '0.0.0-test')`,
    );
    const fingerprintSpy = jest.spyOn(
      fingerprintModule,
      'captureUserContentFingerprint',
    );

    await initializeDatabase(db as any);

    expect(lastStartupPath).toBe('fast');
    expect(fingerprintSpy).not.toHaveBeenCalled();
    const [version] = await db.executeSql(
      `SELECT value FROM settings WHERE key = 'app_version'`,
    );
    expect(version.rows.item(0).value).toBe(
      appVersionJson.versionName.replace(/^V/, ''),
    );
  });

  it('schema upgrade is deep and keeps backup plus before/after content checks', async () => {
    const db = await createCleanDatabase();
    await db.executeSql(
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '60')`,
    );
    const fingerprintSpy = jest.spyOn(
      fingerprintModule,
      'captureUserContentFingerprint',
    );
    const recallSpy = jest.spyOn(recallModule, 'captureUserDataRecallSnapshot');

    await initializeDatabase(db as any);

    expect(lastStartupPath).toBe('deep');
    expect(lastStartupDeepReason).toBe('schema_version_mismatch');
    expect(lastMigrationResult?.fromVersion).toBe(60);
    expect(lastMigrationResult?.toVersion).toBe(SCHEMA_VERSION);
    expect(lastMigrationResult?.migrationsRun).toBe(1);
    expect(lastSchemaRecovery?.backupCreated).toBe(true);
    expect(fingerprintSpy).toHaveBeenCalledTimes(2);
    expect(recallSpy).toHaveBeenCalledTimes(2);
  });

  it('known physical drift invalidates the fast marker and takes the repair path', async () => {
    const db = await createCleanDatabase();
    await dropProvenanceColumns(db);

    await initializeDatabase(db as any);

    expect(lastStartupPath).toBe('deep');
    expect(lastStartupDeepReason).toBe('schema_signature_mismatch');
    expect(lastSchemaRecovery?.backupCreated).toBe(true);
    expect(lastSchemaRecovery?.repaired).toBe(true);
    expect(lastSchemaRecovery?.recallVerified).toBe(true);
  });

  it.each([
    'migration_in_progress',
    'recovery_required',
    'database_restore_pending',
    'database_import_pending',
    'schema_recovery_pending',
  ])('%s always forces deep recovery', async key => {
    const db = await createCleanDatabase();
    await db.executeSql(
      `INSERT OR REPLACE INTO settings (key, value)
       VALUES (?, 'true')`,
      [key],
    );
    const fingerprintSpy = jest.spyOn(
      fingerprintModule,
      'captureUserContentFingerprint',
    );

    await initializeDatabase(db as any);

    expect(lastStartupPath).toBe('deep');
    expect(lastStartupDeepReason).toBe(`${key}_pending`);
    expect(fingerprintSpy).toHaveBeenCalledTimes(2);
    const [state] = await db.executeSql(
      `SELECT value FROM settings WHERE key = 'startup_db_state'`,
    );
    expect(state.rows.item(0).value).toBe('clean');
  });

  it('an interrupted startup marker forces deep recovery', async () => {
    const db = await createCleanDatabase();
    await db.executeSql(
      `INSERT OR REPLACE INTO settings (key, value)
       VALUES ('startup_db_state', 'in_progress')`,
    );

    await initializeDatabase(db as any);

    expect(lastStartupPath).toBe('deep');
    expect(lastStartupDeepReason).toBe('startup_state_in_progress');
  });
});
