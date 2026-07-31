import { createCurrentSchema } from '../src/data/schema/createCurrentSchema';
import { SCHEMA_VERSION } from '../src/services/migrations';
import { buildV28toV29Statements } from '../src/services/migrations/v28-to-v29';
import { applyMigration } from '../src/services/migrations/helpers';
import { createMigrationDb } from './migrationTestUtils';

describe('schema 29 — multi-file continuation import', () => {
  it('reflects the new schema version', () => {
    expect(SCHEMA_VERSION).toBe(29);
  });

  it('adds source_files_json / is_multi_file / file_count to continuation_sources', async () => {
    const mock = createMigrationDb({ schemaVersion: 28 });
    await applyMigration(mock.database as any, buildV28toV29Statements());
    const cols = mock.schemas.get('continuation_sources');
    expect(cols).toBeDefined();
    expect(cols!.has('source_files_json')).toBe(true);
    expect(cols!.has('is_multi_file')).toBe(true);
    expect(cols!.has('file_count')).toBe(true);
  });

  it('adds file_index to continuation_source_text_chunks', async () => {
    const mock = createMigrationDb({ schemaVersion: 28 });
    await applyMigration(mock.database as any, buildV28toV29Statements());
    const cols = mock.schemas.get('continuation_source_text_chunks');
    expect(cols).toBeDefined();
    expect(cols!.has('file_index')).toBe(true);
  });

  it('adds file_index to continuation_source_chapters', async () => {
    const mock = createMigrationDb({ schemaVersion: 28 });
    await applyMigration(mock.database as any, buildV28toV29Statements());
    const cols = mock.schemas.get('continuation_source_chapters');
    expect(cols).toBeDefined();
    expect(cols!.has('file_index')).toBe(true);
  });

  it('mirrors new columns in createCurrentSchema for fresh installs', async () => {
    const sql: string[] = [];
    await createCurrentSchema({
      executeSql: jest.fn(async (statement: string) => {
        sql.push(statement.replace(/\s+/g, ' ').trim());
        return [{ rows: { length: 0, item: () => null } }];
      }),
    } as any);
    const joined = sql.join('\n');
    // continuation_sources
    expect(joined).toContain('source_files_json TEXT');
    expect(joined).toContain('is_multi_file INTEGER NOT NULL DEFAULT 0');
    expect(joined).toContain('file_count INTEGER NOT NULL DEFAULT 1');
    // chunks
    expect(joined).toMatch(/continuation_source_text_chunks[\s\S]*file_index INTEGER NOT NULL DEFAULT 0/);
    // chapters
    expect(joined).toMatch(/continuation_source_chapters[\s\S]*file_index INTEGER NOT NULL DEFAULT 0/);
  });
});
