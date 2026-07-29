import { createCurrentSchema } from '../src/data/schema/createCurrentSchema';
import { SCHEMA_MANIFEST } from '../src/services/database/schemaManifest';
import { SCHEMA_VERSION } from '../src/services/migrations';
import {
  buildV18toV19Statements,
  migrateV18ToV19,
} from '../src/services/migrations/v18-to-v19';
import { createMigrationDb } from './migrationTestUtils';

const CONTINUATION_TABLES = [
  'continuation_sources',
  'continuation_source_text_chunks',
  'continuation_source_chapters',
  'continuation_settings',
  'continuation_import_jobs',
] as const;

const CONTINUATION_INDEXES = [
  'idx_continuation_sources_one_ready',
  'idx_continuation_text_chunks_range',
  'idx_continuation_import_one_active',
] as const;

describe('schema 19 continuation foundation migration', () => {
  it('declares every continuation table, index and the bumped schema version', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(19);

    const sql = buildV18toV19Statements().map(item => item.sql);
    for (const table of CONTINUATION_TABLES) {
      expect(sql.some(s => s.includes(`CREATE TABLE IF NOT EXISTS ${table}`))).toBe(true);
    }
    for (const index of CONTINUATION_INDEXES) {
      expect(sql.some(s => s.includes(index))).toBe(true);
    }
  });

  it('creates all continuation tables and indexes when run from schema 18', async () => {
    const mock = createMigrationDb({ schemaVersion: 18 });

    await migrateV18ToV19(mock.database as any);

    for (const table of CONTINUATION_TABLES) {
      expect(mock.schemas.has(table)).toBe(true);
    }
    for (const index of CONTINUATION_INDEXES) {
      expect(mock.indexes.has(index)).toBe(true);
    }
  });

  it('keeps fresh installs and backup manifest aligned (Spec §9, §15)', async () => {
    const sql: string[] = [];
    await createCurrentSchema({
      executeSql: jest.fn(async (statement: string) => {
        sql.push(statement.replace(/\s+/g, ' ').trim());
        return [{ rows: { length: 0, item: () => null } }];
      }),
    } as any);

    const joined = sql.join('\n');
    for (const table of CONTINUATION_TABLES) {
      expect(joined).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }

    // Sources/chunks/chapters/settings must be backed up; import jobs must NOT.
    expect(SCHEMA_MANIFEST.find(t => t.name === 'continuation_sources')).toEqual(
      expect.objectContaining({ backup: true, restoreOrder: 210 }),
    );
    expect(SCHEMA_MANIFEST.find(t => t.name === 'continuation_source_text_chunks')).toEqual(
      expect.objectContaining({ backup: true, restoreOrder: 220 }),
    );
    expect(SCHEMA_MANIFEST.find(t => t.name === 'continuation_source_chapters')).toEqual(
      expect.objectContaining({ backup: true, restoreOrder: 230 }),
    );
    expect(SCHEMA_MANIFEST.find(t => t.name === 'continuation_settings')).toEqual(
      // Settings pointers are restored in phase 2 after Canon/Style parents.
      expect.objectContaining({ backup: true, restoreOrder: 520 }),
    );
    expect(SCHEMA_MANIFEST.find(t => t.name === 'continuation_import_jobs')).toEqual(
      expect.objectContaining({ backup: false, restoreOrder: 250 }),
    );
  });
});
