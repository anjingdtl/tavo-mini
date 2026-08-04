import { createCurrentSchema } from '../src/data/schema/createCurrentSchema';
import { SCHEMA_MANIFEST } from '../src/services/database/schemaManifest';
import { SCHEMA_VERSION } from '../src/services/migrations';
import {
  buildV20toV21Statements,
  migrateV20ToV21,
} from '../src/services/migrations/v20-to-v21';
import { createMigrationDb } from './migrationTestUtils';

const PHASE3_TABLES = [
  'continuation_generation_settings',
  'continuation_generation_runs',
  'continuation_generation_artifacts',
  'continuation_plans',
  'continuation_check_results',
  'continuation_state_proposals',
  'continuation_state_events',
  'continuation_entities',
  'continuation_entity_aliases',
  'continuation_state_sync_outbox',
  'continuation_style_profiles',
] as const;

describe('schema 21 continuation Phase 3 migration', () => {
  it('declares Phase 3 tables while the current schema version advances', () => {
    expect(SCHEMA_VERSION).toBe(34);
    const sql = buildV20toV21Statements().map(item => item.sql);
    for (const table of PHASE3_TABLES) {
      expect(
        sql.some(s => s.includes(`CREATE TABLE IF NOT EXISTS ${table}`)),
      ).toBe(true);
    }
    expect(sql.some(s => s.includes("CHECK(id LIKE 'ct_%')"))).toBe(true);
  });

  it('creates all Phase 3 tables when run from schema 20', async () => {
    const mock = createMigrationDb({ schemaVersion: 20 });
    await migrateV20ToV21(mock.database as any);
    for (const table of PHASE3_TABLES) {
      expect(mock.schemas.has(table)).toBe(true);
    }
  });

  it('keeps fresh schema and backup manifest aligned (all backup:true)', async () => {
    const sql: string[] = [];
    await createCurrentSchema({
      executeSql: jest.fn(async (statement: string) => {
        sql.push(statement.replace(/\s+/g, ' ').trim());
        return [{ rows: { length: 0, item: () => null } }];
      }),
    } as any);
    const joined = sql.join('\n');
    for (const table of PHASE3_TABLES) {
      expect(joined).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    for (const table of PHASE3_TABLES) {
      const m = SCHEMA_MANIFEST.find(t => t.name === table);
      expect(m).toEqual(expect.objectContaining({ backup: true }));
    }
  });
});
