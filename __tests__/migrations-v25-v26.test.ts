import { createCurrentSchema } from '../src/data/schema/createCurrentSchema';
import { SCHEMA_MANIFEST } from '../src/services/database/schemaManifest';
import { SCHEMA_VERSION } from '../src/services/migrations';
import {
  buildSchema26CreateSqls,
  buildSchema26PostStyleStatements,
  buildV25toV26Statements,
  migrateV25ToV26,
} from '../src/services/migrations/v25-to-v26';
import { createMigrationDb } from './migrationTestUtils';

describe('schema 26 versioned continuation style profiles', () => {
  it('targets the current schema version', () => {
    expect(SCHEMA_VERSION).toBe(37);
    expect(buildSchema26PostStyleStatements()).toEqual([]);
  });

  it('creates the versioned style profile table with fingerprint + state', () => {
    const sql = buildSchema26CreateSqls().join('\n');
    expect(sql).toContain('continuation_style_profiles');
    expect(sql).toContain('profile_hash TEXT NOT NULL');
    expect(sql).toContain('analyzer_version TEXT NOT NULL');
    // state CHECK includes the staging/history lifecycle.
    expect(sql).toContain("'queued'");
    expect(sql).toContain("'ready'");
    expect(sql).toContain("'outdated'");
    expect(sql).toContain("'ignored'");
    expect(sql).toContain('idx_continuation_style_profiles_project_state');
    expect(sql).toContain('idx_continuation_style_profiles_fingerprint');
  });

  it('rebuilds the legacy table and marks rows outdated on upgrade', () => {
    const statements = buildV25toV26Statements().map(item => item.sql);
    const joined = statements.join('\n');
    // Legacy table is renamed aside then dropped after backfill.
    expect(joined).toContain('RENAME TO continuation_style_profiles_v25');
    expect(joined).toContain('DROP TABLE continuation_style_profiles_v25');
    // Legacy rows become outdated so they never auto-inject.
    expect(joined).toContain("'outdated'");
    expect(joined).toContain("'legacy_pre_v26'");
    // Analysis runs are deliberately not rebuilt: Schema 25 already accepts
    // both style stages and its child FKs must keep the original parent.
    expect(joined).not.toContain('continuation_analysis_runs_v25');
    // settings gains the active pointer column.
    expect(joined).toContain('ADD COLUMN active_style_profile_id');
  });

  it('applies cleanly from schema 25 producing the new table shape', async () => {
    const mock = createMigrationDb({ schemaVersion: 25 });
    await migrateV25ToV26(mock.database as any);
    expect(mock.schemas.has('continuation_style_profiles')).toBe(true);
    const cols = mock.schemas.get('continuation_style_profiles');
    expect(cols?.has('id')).toBe(true);
    expect(cols?.has('profile_hash')).toBe(true);
    expect(cols?.has('profile_json')).toBe(true);
    expect(cols?.has('state')).toBe(true);
    // Legacy column dropped during rebuild.
    expect(cols?.has('canon_revision')).toBe(false);
    expect(
      mock.indexes.has('idx_continuation_style_profiles_project_state'),
    ).toBe(true);
    expect(
      mock.indexes.has('idx_continuation_style_profiles_fingerprint'),
    ).toBe(true);
    // settings gained the active style column.
    expect(
      mock.schemas.get('continuation_settings')?.has('active_style_profile_id'),
    ).toBe(true);
    // analysis_runs still present (rebuilt in place).
    expect(mock.schemas.has('continuation_analysis_runs')).toBe(true);
  });

  it('verifies live foreign keys after the migration', async () => {
    const mock = createMigrationDb({ schemaVersion: 25 });
    mock.database.executeSql.mockImplementation(async (sql: string) => {
      if (sql === 'PRAGMA foreign_key_check') {
        return [{ rows: { length: 0, item: () => null } }] as any;
      }
      return [
        {
          rows: {
            length: 1,
            item: () => ({ table: 'continuation_analysis_runs' }),
          },
        },
      ] as any;
    });

    await expect(
      migrateV25ToV26(mock.database as any),
    ).resolves.toBeUndefined();
    expect(mock.database.executeSql).toHaveBeenCalledWith(
      'PRAGMA foreign_key_check',
    );
  });

  it('fails closed when the live migration check finds an orphan', async () => {
    const mock = createMigrationDb({ schemaVersion: 25 });
    mock.database.executeSql.mockImplementation(async (sql: string) => {
      if (sql === 'PRAGMA foreign_key_check') {
        return [{ rows: { length: 2, item: () => null } }] as any;
      }
      return [{ rows: { length: 0, item: () => null } }] as any;
    });

    await expect(migrateV25ToV26(mock.database as any)).rejects.toThrow(
      '发现 2 条外键孤儿记录',
    );
  });

  it('rejects a live child foreign key that still points at the v25 table', async () => {
    const mock = createMigrationDb({ schemaVersion: 25 });
    mock.database.executeSql.mockImplementation(async (sql: string) => {
      if (sql === 'PRAGMA foreign_key_check') {
        return [{ rows: { length: 0, item: () => null } }] as any;
      }
      return [
        {
          rows: {
            length: 1,
            item: () => ({ table: 'continuation_analysis_runs_v25' }),
          },
        },
      ] as any;
    });

    await expect(migrateV25ToV26(mock.database as any)).rejects.toThrow(
      '仍引用已删除的 continuation_analysis_runs_v25',
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
    // Fresh install builds the versioned table directly.
    expect(joined).toContain('profile_hash TEXT NOT NULL');
    expect(joined).toContain('active_style_profile_id TEXT');
    // Fresh install does NOT create the legacy single-row style profile shape
    // (the v20→v21 legacy CREATE is filtered out; only the versioned table is
    // built). The legacy shape is identified by its project_id PRIMARY KEY.
    expect(joined).not.toContain(
      'CREATE TABLE IF NOT EXISTS continuation_style_profiles (\n      project_id INTEGER PRIMARY KEY',
    );
    expect(joined).not.toMatch(
      /continuation_style_profiles \(\s*project_id INTEGER PRIMARY KEY/,
    );
    expect(
      SCHEMA_MANIFEST.find(
        table => table.name === 'continuation_style_profiles',
      ),
    ).toEqual(
      expect.objectContaining({
        backup: true,
        columns: expect.arrayContaining([
          'id',
          'profile_hash',
          'state',
          'review_status',
        ]),
      }),
    );
    expect(
      SCHEMA_MANIFEST.find(table => table.name === 'continuation_settings'),
    ).toEqual(
      expect.objectContaining({
        backup: true,
        columns: expect.arrayContaining(['active_style_profile_id']),
      }),
    );
  });
});
