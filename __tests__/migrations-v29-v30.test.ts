import { SCHEMA_VERSION } from '../src/services/migrations';
import {
  buildV29toV30Statements,
  migrateV29ToV30,
} from '../src/services/migrations/v29-to-v30';
import { createMigrationDb } from './migrationTestUtils';

describe('schema 30 Canon style-stage constraint repair', () => {
  it('remains a historical migration after Schema 31', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(38);
  });

  it('rebuilds run and dependent task tables without losing resumable rows', () => {
    const sql = buildV29toV30Statements()
      .map(statement => statement.sql)
      .join('\n');

    expect(sql).toContain('continuation_analysis_runs_v29');
    expect(sql).toContain('continuation_analysis_batches_v29');
    expect(sql).toContain('continuation_analysis_work_items_v29');
    expect(sql).toContain("'style_analysis'");
    expect(sql).toContain("'style_validation'");
    expect(sql).toContain('FROM continuation_analysis_runs_v29');
    expect(sql).toContain('FROM continuation_analysis_batches_v29');
    expect(sql).toContain('FROM continuation_analysis_work_items_v29');
    expect(sql).toContain('canon_characters_v29');
    expect(sql).toContain('canon_timeline_events_v29');

    // The old chain is deleted only after the new tables have received copies.
    expect(
      sql.indexOf('FROM continuation_analysis_work_items_v29'),
    ).toBeLessThan(
      sql.indexOf('DROP TABLE continuation_analysis_work_items_v29'),
    );
    expect(sql.indexOf('ALTER TABLE canon_characters RENAME')).toBeLessThan(
      sql.indexOf('ALTER TABLE continuation_analysis_runs RENAME'),
    );
    expect(sql.indexOf('FROM canon_characters_v29')).toBeLessThan(
      sql.indexOf('DROP TABLE canon_characters_v29'),
    );
    expect(sql.indexOf('FROM continuation_analysis_batches_v29')).toBeLessThan(
      sql.indexOf('DROP TABLE continuation_analysis_batches_v29'),
    );
    expect(sql.indexOf('FROM continuation_analysis_runs_v29')).toBeLessThan(
      sql.indexOf('DROP TABLE continuation_analysis_runs_v29'),
    );
  });

  it('applies from an already-current schema and retains the canonical table names', async () => {
    const mock = createMigrationDb({ schemaVersion: 29 });
    mock.schemas.set(
      'continuation_analysis_batches',
      new Set([
        'run_id',
        'canon_snapshot_id',
        'batch_index',
        'start_position',
        'end_position',
        'input_hash',
        'idempotency_key',
        'state',
        'attempt_count',
        'result_json',
        'error_code',
        'error_message',
        'created_at',
        'updated_at',
        'completed_at',
      ]),
    );

    await migrateV29ToV30(mock.database as any);

    expect(mock.schemas.has('continuation_analysis_runs')).toBe(true);
    expect(mock.schemas.has('continuation_analysis_batches')).toBe(true);
    expect(mock.schemas.has('continuation_analysis_work_items')).toBe(true);
    expect(mock.schemas.has('continuation_analysis_runs_v29')).toBe(false);
    expect(mock.schemas.has('continuation_analysis_batches_v29')).toBe(false);
    expect(mock.schemas.has('continuation_analysis_work_items_v29')).toBe(
      false,
    );
  });

  it('fails closed if rebuilding leaves foreign-key orphans', async () => {
    const mock = createMigrationDb({ schemaVersion: 29 });
    mock.database.executeSql.mockImplementation(async (sql: string) => {
      if (sql === 'PRAGMA foreign_key_check') {
        return [{ rows: { length: 1, item: () => null } }] as any;
      }
      return [{ rows: { length: 0, item: () => null } }] as any;
    });

    await expect(migrateV29ToV30(mock.database as any)).rejects.toThrow(
      '发现 1 条外键孤儿记录',
    );
  });
});
