import { createCanonInMemoryDb, createEmptyInMemoryDb } from './helpers/canonInMemoryDb';
import { inspectKnownSchemaDrift } from '../src/data/schema/schemaDriftInspector';
import { repairKnownSchemaDrift } from '../src/data/schema/knownSchemaRepairs';
import { PIPELINE_STAGE_ATTEMPTS_DDL } from '../src/services/migrations/v40-to-v41';
import {
  migrateV48ToV49,
  V49_ATTEMPT_COLUMNS,
} from '../src/services/migrations/v48-to-v49';
import { runMigrations, SCHEMA_VERSION } from '../src/services/migrations';

async function columnNames(db: any): Promise<Set<string>> {
  const [result] = await db.executeSql(
    'PRAGMA table_info(pipeline_stage_attempts)',
  );
  return new Set(result.rows.raw().map((row: any) => row.name));
}

describe('Schema 48 → current V3.2 structured-stage persistence', () => {
  test('upgrades an old attempts table and remains idempotent', async () => {
    const db = await createEmptyInMemoryDb();
    try {
      await db.executeSql('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
      await db.executeSql(PIPELINE_STAGE_ATTEMPTS_DDL);
      await db.executeSql(
        "INSERT INTO settings (key, value) VALUES ('schema_version', '48')",
      );

      const result = await runMigrations(db as any, 48);
      expect(result).toMatchObject({
        fromVersion: 48,
        toVersion: SCHEMA_VERSION,
        migrationsRun: SCHEMA_VERSION - 48,
        hadBreaking: false,
      });
      await migrateV48ToV49(db as any);
      await migrateV48ToV49(db as any);

      const names = await columnNames(db);
      for (const column of V49_ATTEMPT_COLUMNS) {
        expect(names.has(column.name)).toBe(true);
      }
      const [version] = await db.executeSql(
        "SELECT value FROM settings WHERE key = 'schema_version'",
      );
      expect(version.rows.item(0).value).toBe(String(SCHEMA_VERSION));
    } finally {
      db.close();
    }
  });

  test('fresh-install schema contains the Schema 49 attempt columns', async () => {
    const db = await createCanonInMemoryDb();
    try {
      const names = await columnNames(db);
      expect(names.has('response_candidate_temp')).toBe(true);
      expect(names.has('response_candidate_channel')).toBe(true);
      expect(names.has('validation_details_json')).toBe(true);
    } finally {
      db.close();
    }
  });

  test('fresh-install schema contains only transport metadata for Story Memory attempts', async () => {
    const db = await createCanonInMemoryDb();
    try {
      const [result] = await db.executeSql(
        'PRAGMA table_info(story_memory_request_attempts)',
      );
      const names = new Set(result.rows.raw().map((row: any) => row.name));
      expect(names).toEqual(
        new Set([
          'attempt_id',
          'logical_batch_id',
          'project_id',
          'from_position',
          'through_position',
          'request_kind',
          'attempt_no',
          'status',
          'failure_class',
          'error_code',
          'http_status',
          'provider_request_id',
          'started_at',
          'finished_at',
        ]),
      );
      expect(names.has('prompt')).toBe(false);
      expect(names.has('body')).toBe(false);
      expect(names.has('api_key')).toBe(false);
      expect(names.has('reasoning')).toBe(false);
    } finally {
      db.close();
    }
  });

  test('repairs a recorded-49 physical drift without creating a missing table', async () => {
    const db = await createEmptyInMemoryDb();
    try {
      await db.executeSql('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
      await db.executeSql(
        "INSERT INTO settings (key, value) VALUES ('schema_version', '49')",
      );
      await db.executeSql(`
        CREATE TABLE canon_evidence (
          id INTEGER PRIMARY KEY,
          snapshot_id TEXT,
          analysis_run_id TEXT
        )
      `);
      await db.executeSql('INSERT INTO canon_evidence (id) VALUES (7)');
      await db.executeSql(
        'CREATE TABLE pipeline_stage_attempts (id TEXT PRIMARY KEY)',
      );

      const before = await inspectKnownSchemaDrift(db as any);
      expect(before.repairCodes).toEqual(
        expect.arrayContaining([
          'PIPELINE_RESPONSE_CANDIDATE_TEMP_MISSING',
          'PIPELINE_RESPONSE_CANDIDATE_CHANNEL_MISSING',
          'PIPELINE_VALIDATION_DETAILS_MISSING',
        ]),
      );
      const repaired = await repairKnownSchemaDrift(db as any, before);
      expect(repaired.ok).toBe(true);
      expect(repaired.codes).toEqual(
        expect.arrayContaining([
          'PIPELINE_RESPONSE_CANDIDATE_TEMP_MISSING',
          'PIPELINE_RESPONSE_CANDIDATE_CHANNEL_MISSING',
          'PIPELINE_VALIDATION_DETAILS_MISSING',
        ]),
      );
      const after = await inspectKnownSchemaDrift(db as any);
      expect(after.repairCodes).toEqual([]);
      const [identity] = await db.executeSql(
        'SELECT COUNT(*) AS count, MIN(id) AS min_id, MAX(id) AS max_id FROM canon_evidence',
      );
      expect(identity.rows.item(0)).toEqual({
        count: 1,
        min_id: 7,
        max_id: 7,
      });
    } finally {
      db.close();
    }
  });
});
