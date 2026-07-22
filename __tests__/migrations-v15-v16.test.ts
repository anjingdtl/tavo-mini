import { createCurrentSchema } from '../src/data/schema/createCurrentSchema';
import { SCHEMA_MANIFEST } from '../src/services/database/schemaManifest';
import { SCHEMA_VERSION, runMigrations } from '../src/services/migrations';
import {
  buildV15toV16Statements,
  migrateV15ToV16,
} from '../src/services/migrations/v15-to-v16';
import { createMigrationDb } from './migrationTestUtils';

describe('schema 16 story memory checkpoint migration', () => {
  it('creates policy and batch tables from schema 15', async () => {
    const mock = createMigrationDb({ schemaVersion: 15 });
    const result = await runMigrations(mock.database as any, 15);
    expect(result).toEqual(
      expect.objectContaining({
        fromVersion: 15,
        toVersion: SCHEMA_VERSION,
        migrationsRun: SCHEMA_VERSION - 15,
      }),
    );
    expect(mock.schemas.has('project_story_memory_policy')).toBe(true);
    expect(mock.schemas.has('story_memory_batches')).toBe(true);
    expect(mock.settings.get('schema_version')).toBe(String(SCHEMA_VERSION));
  });

  it('is idempotent and does not rewrite existing story memory tables', async () => {
    const statements = buildV15toV16Statements();
    expect(
      statements.filter(item => /CREATE TABLE IF NOT EXISTS/.test(item.sql)),
    ).toHaveLength(2);
    const mock = createMigrationDb({ schemaVersion: 15 });
    await migrateV15ToV16(mock.database as any);
    await migrateV15ToV16(mock.database as any);
    expect(mock.schemas.has('project_story_memory_policy')).toBe(true);
    expect(mock.schemas.has('story_memory_batches')).toBe(true);
  });

  it('includes tables on fresh install and backup manifest', async () => {
    const sql: string[] = [];
    const database = {
      executeSql: jest.fn(async (statement: string) => {
        sql.push(statement.replace(/\s+/g, ' ').trim());
        return [{ rows: { length: 0, item: () => null } }];
      }),
    };
    await createCurrentSchema(database as any);
    const joined = sql.join('\n');
    expect(joined).toContain(
      'CREATE TABLE IF NOT EXISTS project_story_memory_policy',
    );
    expect(joined).toContain('CREATE TABLE IF NOT EXISTS story_memory_batches');
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(16);
    for (const tableName of [
      'project_story_memory_policy',
      'story_memory_batches',
    ]) {
      expect(SCHEMA_MANIFEST.find(item => item.name === tableName)).toEqual(
        expect.objectContaining({ backup: true }),
      );
    }
  });
});
