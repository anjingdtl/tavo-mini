import { SCHEMA_VERSION } from '../src/services/migrations';
import {
  buildSchema25CreateSqls,
  buildV24toV25Statements,
  migrateV24ToV25,
} from '../src/services/migrations/v24-to-v25';
import { createMigrationDb } from './migrationTestUtils';

describe('schema 25 continuation resource bindings', () => {
  it('keeps ordinary resources opt-in for continuation use', () => {
    expect(SCHEMA_VERSION).toBe(27);
    const sql = buildV24toV25Statements().map(item => item.sql).join('\n');
    expect(sql).toContain('continuation_resource_bindings');
    expect(sql).toContain("'external_supplement'");
    expect(sql).toContain('idx_continuation_resource_bindings_one_preset');
    expect(buildSchema25CreateSqls().join('\n')).toContain(
      'continuation_resource_bindings',
    );
  });

  it('applies cleanly from schema 24', async () => {
    const mock = createMigrationDb({ schemaVersion: 24 });
    await migrateV24ToV25(mock.database as any);
    expect(mock.schemas.has('continuation_resource_bindings')).toBe(true);
  });
});
