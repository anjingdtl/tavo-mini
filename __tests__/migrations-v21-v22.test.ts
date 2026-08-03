import { createCurrentSchema } from '../src/data/schema/createCurrentSchema';
import { SCHEMA_MANIFEST } from '../src/services/database/schemaManifest';
import { SCHEMA_VERSION } from '../src/services/migrations';
import {
  buildSchema22CreateSqls,
  buildV21toV22Statements,
  migrateV21ToV22,
} from '../src/services/migrations/v21-to-v22';
import { createMigrationDb } from './migrationTestUtils';

describe('schema 22 Canon material work-item migration', () => {
  it('creates the five-family resumable work-item table', () => {
    expect(SCHEMA_VERSION).toBe(33);
    const sql = buildV21toV22Statements()
      .map(item => item.sql)
      .join('\n');
    expect(sql).toContain(
      'CREATE TABLE IF NOT EXISTS continuation_analysis_work_items',
    );
    expect(sql).toContain("'world_rules'");
    expect(sql).toContain("'experiences'");
    expect(sql).toContain('idx_continuation_analysis_work_items_state');
    // Cover the createCurrentSchema mirror helper (coverage gate).
    expect(buildSchema22CreateSqls().join('\n')).toContain(
      'continuation_analysis_work_items',
    );
  });

  it('applies cleanly from schema 21', async () => {
    const mock = createMigrationDb({ schemaVersion: 21 });
    await migrateV21ToV22(mock.database as any);
    expect(mock.schemas.has('continuation_analysis_work_items')).toBe(true);
  });

  it('keeps fresh schema and backup manifest aligned', async () => {
    const sql: string[] = [];
    await createCurrentSchema({
      executeSql: jest.fn(async (statement: string) => {
        sql.push(statement.replace(/\s+/g, ' ').trim());
        return [{ rows: { length: 0, item: () => null } }];
      }),
    } as any);
    expect(sql.join('\n')).toContain(
      'CREATE TABLE IF NOT EXISTS continuation_analysis_work_items',
    );
    expect(
      SCHEMA_MANIFEST.find(
        table => table.name === 'continuation_analysis_work_items',
      ),
    ).toEqual(expect.objectContaining({ backup: true }));
  });
});
