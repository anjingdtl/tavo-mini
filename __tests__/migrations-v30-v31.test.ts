import { SCHEMA_VERSION } from '../src/services/migrations';
import {
  buildV30toV31Statements,
  migrateV30ToV31,
} from '../src/services/migrations/v30-to-v31';
import { createMigrationDb } from './migrationTestUtils';

describe('schema 31 Canon foreign-key repair', () => {
  it('is the current schema version', () => {
    expect(SCHEMA_VERSION).toBe(37);
  });

  it('rebuilds Canon tables that Schema 30 could leave pointing at _v29', () => {
    const sql = buildV30toV31Statements()
      .map(statement => statement.sql)
      .join('\n');

    for (const table of [
      'canon_world_rules',
      'canon_characters',
      'canon_character_aliases',
      'canon_character_state_snapshots',
      'canon_relationships',
      'canon_plot_threads',
      'canon_plot_thread_characters',
      'canon_character_experiences',
      'canon_character_knowledge',
      'canon_timeline_events',
    ]) {
      expect(sql).toContain(`ALTER TABLE ${table} RENAME TO ${table}_v30`);
      expect(sql).toContain(`FROM ${table}_v30`);
      expect(sql).toContain(`DROP TABLE ${table}_v30`);
    }

    expect(sql.indexOf('FROM canon_characters_v30')).toBeLessThan(
      sql.indexOf('DROP TABLE canon_characters_v30'),
    );
    expect(sql).toContain('REFERENCES continuation_analysis_runs(id)');
    expect(sql).not.toContain('continuation_analysis_runs_v29');
  });

  it('completes when the repaired schema has no foreign-key orphans', async () => {
    const mock = createMigrationDb({ schemaVersion: 30 });

    await expect(migrateV30ToV31(mock.database as any)).resolves.toBeUndefined();
    expect(mock.schemas.has('canon_characters')).toBe(true);
    expect(mock.schemas.has('canon_characters_v30')).toBe(false);
  });

  it('fails closed when the repaired schema still has foreign-key orphans', async () => {
    const mock = createMigrationDb({ schemaVersion: 30 });
    mock.database.executeSql.mockImplementation(async (sql: string) => {
      if (sql === 'PRAGMA foreign_key_check') {
        return [{ rows: { length: 1, item: () => null } }] as any;
      }
      return [{ rows: { length: 0, item: () => null } }] as any;
    });

    await expect(migrateV30ToV31(mock.database as any)).rejects.toThrow(
      '发现 1 条外键孤儿记录',
    );
  });
});
