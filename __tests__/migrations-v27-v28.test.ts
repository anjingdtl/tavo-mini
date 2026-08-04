import { createCurrentSchema } from '../src/data/schema/createCurrentSchema';
import { SCHEMA_VERSION } from '../src/services/migrations';
import { buildV27toV28Statements } from '../src/services/migrations/v27-to-v28';
import { applyMigration } from '../src/services/migrations/helpers';
import { createMigrationDb } from './migrationTestUtils';

describe('schema 28 continuation_analysis_work_items CHECK fix', () => {
  it('reflects the new schema version', () => {
    expect(SCHEMA_VERSION).toBe(34);
  });

  it('rebuilds the work-items table with full_extraction in CHECK', async () => {
    const mock = createMigrationDb({ schemaVersion: 27 });
    await applyMigration(
      mock.database as any,
      buildV27toV28Statements(),
    );
    expect(mock.schemas.has('continuation_analysis_work_items')).toBe(true);
    expect(mock.schemas.has('continuation_analysis_work_items_v27')).toBe(
      false,
    );
    expect(mock.indexes.has('idx_continuation_analysis_work_items_state')).toBe(
      true,
    );

    const sql = buildV27toV28Statements()
      .map(item => item.sql)
      .join('\n');
    expect(sql).toContain('continuation_analysis_work_items_v27');
    expect(sql).toContain("'full_extraction'");
  });

  it('keeps fresh schema aligned with the widened CHECK', async () => {
    const sql: string[] = [];
    await createCurrentSchema({
      executeSql: jest.fn(async (statement: string) => {
        sql.push(statement.replace(/\s+/g, ' ').trim());
        return [{ rows: { length: 0, item: () => null } }];
      }),
    } as any);
    const joined = sql.join('\n');
    expect(joined).toContain("'full_extraction'");
  });
});
