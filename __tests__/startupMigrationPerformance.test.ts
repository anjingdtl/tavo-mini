/* eslint-env jest */

import * as fingerprintModule from '../src/data/schema/userContentFingerprint';
import * as schemaRecoveryModule from '../src/services/schemaRecoveryBackup';
import {
  initializeDatabase,
  lastStartupDiagnostics,
  lastStartupPath,
} from '../src/data/schema/initializeDatabase';
import {
  captureUserContentFingerprint,
} from '../src/data/schema/userContentFingerprint';
import { captureUserDataRecallSnapshot } from '../src/data/schema/userDataRecallSnapshot';
import { createEmptyInMemoryDb, type InMemorySqliteDb } from './helpers/canonInMemoryDb';
import { setupInMemoryFs } from './schema40-fixture-helpers';
import { SCHEMA_VERSION } from '../src/services/migrations';

jest.setTimeout(120_000);

interface Dataset {
  name: string;
  chapters: number;
  notes: number;
  textBytes: number;
}

const DATASETS: Dataset[] = [
  { name: 'S', chapters: 100, notes: 500, textBytes: 256 },
  { name: 'M', chapters: 1_000, notes: 5_000, textBytes: 512 },
  // Keep the normal suite practical while still making L materially larger.
  // Set STARTUP_BENCHMARK_200MB=1 for the release-scale variant.
  process.env.STARTUP_BENCHMARK_200MB === '1'
    ? { name: 'L-200MB', chapters: 2_500, notes: 7_500, textBytes: 16 * 1024 }
    : { name: 'L', chapters: 2_000, notes: 6_000, textBytes: 2 * 1024 },
];

function makeText(bytes: number): string {
  return 'x'.repeat(bytes);
}

async function insertChapters(
  database: InMemorySqliteDb,
  count: number,
  text: string,
): Promise<void> {
  const chunkSize = 40;
  for (let start = 0; start < count; start += chunkSize) {
    const end = Math.min(start + chunkSize, count);
    const values: string[] = [];
    const params: Array<number | string | null> = [];
    for (let index = start; index < end; index += 1) {
      values.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      params.push(
        index + 1,
        1,
        index,
        `第${index + 1}章`,
        '',
        text,
        'planned',
        null,
        '2026-09-11',
        '2026-09-11',
      );
    }
    await database.executeSql(
      `INSERT INTO chapters (id, project_id, position, title, synopsis, content, status, summary_json, created_at, updated_at) VALUES ${values.join(',')}`,
      params,
    );
  }
}

async function insertNotes(
  database: InMemorySqliteDb,
  count: number,
  text: string,
): Promise<void> {
  const chunkSize = 50;
  for (let start = 0; start < count; start += chunkSize) {
    const end = Math.min(start + chunkSize, count);
    const values: string[] = [];
    const params: Array<number | string> = [];
    for (let index = start; index < end; index += 1) {
      values.push('(?, ?, ?, ?, ?, ?, ?, ?)');
      params.push(
        index + 1,
        1,
        0,
        `资料${index + 1}`,
        text,
        30_000,
        '2026-09-11',
        '2026-09-11',
      );
    }
    await database.executeSql(
      `INSERT INTO notes (id, project_id, collection_id, title, content, max_tokens, created_at, updated_at) VALUES ${values.join(',')}`,
      params,
    );
  }
}

async function seedDataset(
  database: InMemorySqliteDb,
  dataset: Dataset,
): Promise<number> {
  await database.executeSql(
    `INSERT INTO projects (id, name, mode, created_at, updated_at)
     VALUES (1, '基准项目', 'outline', '2026-09-11', '2026-09-11')`,
  );
  const text = makeText(dataset.textBytes);
  await insertChapters(database, dataset.chapters, text);
  await insertNotes(database, dataset.notes, text);
  return (dataset.chapters + dataset.notes) * dataset.textBytes;
}

async function runDatasetBenchmark(
  dataset: Dataset,
): Promise<Record<string, number | string | null>> {
  const database = await createEmptyInMemoryDb();
  try {
    await initializeDatabase(database as any);
    const payloadBytes = await seedDataset(database, dataset);

    // Measure the expensive V3.0.3-equivalent safety reads on the same data.
    // The optional backup benchmark is opt-in because it intentionally writes
    // a complete recovery JSON stream to the in-memory filesystem.
    const legacyScanStartedAt = Date.now();
    await captureUserDataRecallSnapshot(database as any);
    await captureUserContentFingerprint(database as any);
    let legacyBackupMs = 0;
    if (process.env.STARTUP_BENCHMARK_WITH_BACKUP === '1') {
      setupInMemoryFs();
      const backupStartedAt = Date.now();
      await schemaRecoveryModule.createSchemaRecoveryBackup(
        database as any,
        'pre_migration',
        SCHEMA_VERSION - 1,
      );
      legacyBackupMs = Date.now() - backupStartedAt;
    }
    const legacyScanMs = Date.now() - legacyScanStartedAt;

    await database.executeSql(
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', '61')`,
    );

    const fingerprintSpy = jest.spyOn(
      fingerprintModule,
      'captureUserContentFingerprint',
    );
    const backupSpy = jest.spyOn(
      schemaRecoveryModule,
      'createSchemaRecoveryBackup',
    );
    const executeSql = database.executeSql.bind(database);
    jest.spyOn(database, 'executeSql').mockImplementation((sql, params = []) => {
      if (
        /^\s*SELECT\b[\s\S]*\b(?:content|summary_json)\b[\s\S]*\bFROM\s+(?:chapters|notes|characters|worldbook_entries)\b/i.test(
          sql,
        )
      ) {
        throw new Error('benchmark guard: startup attempted a user-content scan');
      }
      return executeSql(sql, params);
    });

    const upgradeStartedAt = Date.now();
    await initializeDatabase(database as any);
    const lightUpgradeMs = Date.now() - upgradeStartedAt;

    expect(lastStartupPath).toBe('light');
    expect(lastStartupDiagnostics).toEqual(
      expect.objectContaining({
        path: 'light',
        sourceSchemaVersion: 61,
        targetSchemaVersion: SCHEMA_VERSION,
        migrationRisk: 'schema_only',
      }),
    );
    expect(fingerprintSpy).not.toHaveBeenCalled();
    expect(backupSpy).not.toHaveBeenCalled();

    return {
      dataset: dataset.name,
      payloadBytes,
      legacyScanMs,
      legacyBackupMs,
      lightUpgradeMs,
      finalDatabaseSizeBytes: lastStartupDiagnostics?.databaseSizeBytes ?? null,
      fingerprintCalls: fingerprintSpy.mock.calls.length,
      backupCalls: backupSpy.mock.calls.length,
    };
  } finally {
    database.close();
    jest.restoreAllMocks();
  }
}

describe('startup migration performance regression', () => {
  test('61→62 stays bounded across S/M/L datasets', async () => {
    const results: Array<Record<string, number | string | null>> = [];
    for (const dataset of DATASETS) {
      results.push(await runDatasetBenchmark(dataset));
    }

    // This output contains only dataset sizes and timings, never user text.
    // eslint-disable-next-line no-console
    console.info('[startup-benchmark]', JSON.stringify(results));
    expect(results).toHaveLength(DATASETS.length);
    expect(results.every(result => result.fingerprintCalls === 0)).toBe(true);
    expect(results.every(result => result.backupCalls === 0)).toBe(true);
  });
});
