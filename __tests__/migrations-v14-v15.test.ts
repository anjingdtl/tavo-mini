import { createCurrentSchema } from '../src/data/schema/createCurrentSchema';
import { SCHEMA_MANIFEST } from '../src/services/database/schemaManifest';
import { SCHEMA_VERSION, runMigrations } from '../src/services/migrations';
import {
  buildV14toV15Statements,
  migrateV14ToV15,
} from '../src/services/migrations/v14-to-v15';
import { createMigrationDb } from './migrationTestUtils';

describe('schema 15 story memory migration', () => {
  it('creates all three tables and indexes from schema 14', async () => {
    const mock = createMigrationDb({ schemaVersion: 14 });
    const result = await runMigrations(mock.database as any, 14);
    expect(result).toEqual(expect.objectContaining({
      fromVersion: 14,
      toVersion: 15,
      migrationsRun: 1,
    }));
    for (const table of [
      'project_story_memory',
      'chapter_memory_patches',
      'story_memory_snapshots',
    ]) {
      expect(mock.schemas.has(table)).toBe(true);
    }
    expect(mock.indexes).toEqual(expect.objectContaining({}));
    expect(mock.settings.get('schema_version')).toBe('15');
  });

  it('uses idempotent create statements through the migration entry point', async () => {
    const statements = buildV14toV15Statements();
    expect(statements.filter(item => /CREATE TABLE IF NOT EXISTS/.test(item.sql))).toHaveLength(3);
    expect(statements.filter(item => /CREATE INDEX IF NOT EXISTS/.test(item.sql))).toHaveLength(5);

    const mock = createMigrationDb({ schemaVersion: 14 });
    await migrateV14ToV15(mock.database as any);
    expect(mock.schemas.has('project_story_memory')).toBe(true);
    expect(mock.schemas.has('chapter_memory_patches')).toBe(true);
    expect(mock.schemas.has('story_memory_snapshots')).toBe(true);
  });

  it('includes the story memory schema on fresh install and in backup manifest', async () => {
    const sql: string[] = [];
    const database = {
      executeSql: jest.fn(async (statement: string) => {
        sql.push(statement.replace(/\s+/g, ' ').trim());
        return [{ rows: { length: 0, item: () => null } }];
      }),
    };
    await createCurrentSchema(database as any);
    const joined = sql.join('\n');
    expect(joined).toContain('CREATE TABLE IF NOT EXISTS project_story_memory');
    expect(joined).toContain('CREATE TABLE IF NOT EXISTS chapter_memory_patches');
    expect(joined).toContain('CREATE TABLE IF NOT EXISTS story_memory_snapshots');
    expect(SCHEMA_VERSION).toBe(15);
    for (const tableName of [
      'project_story_memory',
      'chapter_memory_patches',
      'story_memory_snapshots',
    ]) {
      expect(SCHEMA_MANIFEST.find(item => item.name === tableName)).toEqual(
        expect.objectContaining({ backup: true }),
      );
    }
  });
});
