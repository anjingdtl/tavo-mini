import { createCurrentSchema } from '../src/data/schema/createCurrentSchema';
import { SCHEMA_MANIFEST } from '../src/services/database/schemaManifest';
import { SCHEMA_VERSION } from '../src/services/migrations';
import {
  buildV19toV20Statements,
  migrateV19ToV20,
} from '../src/services/migrations/v19-to-v20';
import { createMigrationDb } from './migrationTestUtils';

const CANON_TABLES = [
  'continuation_canon_snapshots',
  'continuation_analysis_runs',
  'continuation_analysis_batches',
  'canon_evidence',
  'canon_evidence_links',
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
] as const;

describe('schema 20 continuation Canon migration', () => {
  it('declares Canon tables and schema version 20', () => {
    expect(SCHEMA_VERSION).toBe(20);
    const sql = buildV19toV20Statements().map(item => item.sql);
    for (const table of CANON_TABLES) {
      expect(sql.some(s => s.includes(`CREATE TABLE IF NOT EXISTS ${table}`))).toBe(
        true,
      );
    }
    expect(sql.some(s => s.includes('active_canon_snapshot_id'))).toBe(true);
    expect(sql.some(s => s.includes('idx_canon_snapshots_one_ready'))).toBe(true);
  });

  it('creates all Canon tables when run from schema 19', async () => {
    const mock = createMigrationDb({ schemaVersion: 19 });
    await migrateV19ToV20(mock.database as any);
    for (const table of CANON_TABLES) {
      expect(mock.schemas.has(table)).toBe(true);
    }
    expect(mock.schemas.get('continuation_settings')?.has('active_canon_snapshot_id')).toBe(
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
    for (const table of CANON_TABLES) {
      expect(joined).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(joined).toContain('active_canon_snapshot_id');

    expect(
      SCHEMA_MANIFEST.find(t => t.name === 'continuation_canon_snapshots'),
    ).toEqual(expect.objectContaining({ backup: true }));
    expect(SCHEMA_MANIFEST.find(t => t.name === 'canon_world_rules')).toEqual(
      expect.objectContaining({ backup: true }),
    );
    expect(
      SCHEMA_MANIFEST.find(t => t.name === 'continuation_settings')?.columns,
    ).toContain('active_canon_snapshot_id');
  });
});
