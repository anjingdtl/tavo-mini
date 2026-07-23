import { createCurrentSchema } from '../src/data/schema/createCurrentSchema';
import { SCHEMA_MANIFEST } from '../src/services/database/schemaManifest';
import { SCHEMA_VERSION } from '../src/services/migrations';
import {
  buildV17toV18Statements,
  migrateV17ToV18,
} from '../src/services/migrations/v17-to-v18';
import { createMigrationDb } from './migrationTestUtils';

describe('schema 18 project collection settings migration', () => {
  it('adds durable project-level collection preferences', () => {
    const sql = buildV17toV18Statements().map(item => item.sql);
    expect(sql.some(item => item.includes('CREATE TABLE IF NOT EXISTS project_collection_settings'))).toBe(true);
    expect(sql.some(item => item.includes('idx_project_collection_settings_lookup'))).toBe(true);
    expect(SCHEMA_VERSION).toBe(18);
  });

  it('executes the complete migration transaction', async () => {
    const mock = createMigrationDb({ schemaVersion: 17 });

    await migrateV17ToV18(mock.database as any);

    expect(mock.schemas.has('project_collection_settings')).toBe(true);
    expect(mock.indexes.has('idx_project_collection_settings_lookup')).toBe(true);
  });

  it('keeps fresh installs and backup validation aligned', async () => {
    const sql: string[] = [];
    await createCurrentSchema({
      executeSql: jest.fn(async (statement: string) => {
        sql.push(statement.replace(/\s+/g, ' ').trim());
        return [{ rows: { length: 0, item: () => null } }];
      }),
    } as any);

    expect(sql.join('\n')).toContain('CREATE TABLE IF NOT EXISTS project_collection_settings');
    expect(SCHEMA_MANIFEST.find(item => item.name === 'project_collection_settings')).toEqual(
      expect.objectContaining({ backup: true, restoreOrder: 135 }),
    );
  });
});
