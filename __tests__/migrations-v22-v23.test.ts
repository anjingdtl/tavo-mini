import { createCurrentSchema } from '../src/data/schema/createCurrentSchema';
import { SCHEMA_MANIFEST } from '../src/services/database/schemaManifest';
import { SCHEMA_VERSION } from '../src/services/migrations';
import {
  buildV22toV23Statements,
  migrateV22ToV23,
} from '../src/services/migrations/v22-to-v23';
import { createMigrationDb } from './migrationTestUtils';

describe('schema 23 Canon request-group migration', () => {
  it('expands work-item values while preserving legacy values', () => {
    expect(SCHEMA_VERSION).toBe(34);
    const sql = buildV22toV23Statements()
      .map(item => item.sql)
      .join('\n');
    expect(sql).toContain('continuation_analysis_work_items_v22');
    expect(sql).toContain("'character_state'");
    expect(sql).toContain("'world_plot'");
    expect(sql).toContain("'full_extraction'");
    expect(sql).toContain("'world_rules'");
    expect(sql).toContain('INSERT INTO continuation_analysis_work_items');
  });

  it('rebuilds the Schema 22 work-item table cleanly', async () => {
    const mock = createMigrationDb({ schemaVersion: 22 });
    await migrateV22ToV23(mock.database as any);
    expect(mock.schemas.has('continuation_analysis_work_items')).toBe(true);
    expect(mock.schemas.has('continuation_analysis_work_items_v22')).toBe(
      false,
    );
    expect(mock.indexes.has('idx_continuation_analysis_work_items_state')).toBe(
      true,
    );
  });

  it('keeps fresh schema and backup manifest aligned', async () => {
    const sql: string[] = [];
    await createCurrentSchema({
      executeSql: jest.fn(async (statement: string) => {
        sql.push(statement.replace(/\s+/g, ' ').trim());
        return [{ rows: { length: 0, item: () => null } }];
      }),
    } as any);
    const joined = sql.join('\n');
    expect(joined).toContain("'character_state'");
    expect(joined).toContain("'world_plot'");
    expect(joined).toContain("'full_extraction'");
    expect(
      SCHEMA_MANIFEST.find(
        table => table.name === 'continuation_analysis_work_items',
      ),
    ).toEqual(expect.objectContaining({ backup: true }));
  });
});
