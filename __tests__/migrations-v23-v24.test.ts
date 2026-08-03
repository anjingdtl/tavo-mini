import { createCurrentSchema } from '../src/data/schema/createCurrentSchema';
import { SCHEMA_MANIFEST } from '../src/services/database/schemaManifest';
import { SCHEMA_VERSION } from '../src/services/migrations';
import {
  buildV23toV24Statements,
  migrateV23ToV24,
} from '../src/services/migrations/v23-to-v24';
import { createMigrationDb } from './migrationTestUtils';

describe('schema 24 historical digest migration', () => {
  it('creates separate weak-memory tables rather than Canon evidence tables', () => {
    expect(SCHEMA_VERSION).toBe(32);
    const sql = buildV23toV24Statements().map(item => item.sql).join('\n');
    expect(sql).toContain('continuation_historical_digests');
    expect(sql).toContain('continuation_historical_digest_chapters');
    expect(sql).toContain('continuation_historical_index_terms');
    expect(sql).toContain("'outdated'");
    expect(sql).not.toContain('canon_evidence');
  });

  it('creates all historical tables for an upgraded database', async () => {
    const mock = createMigrationDb({ schemaVersion: 23 });
    await migrateV23ToV24(mock.database as any);
    expect(mock.schemas.has('continuation_historical_digests')).toBe(true);
    expect(mock.schemas.has('continuation_historical_digest_chapters')).toBe(true);
    expect(mock.schemas.has('continuation_historical_index_terms')).toBe(true);
  });

  it('keeps the fresh schema and backup manifest aligned', async () => {
    const sql: string[] = [];
    await createCurrentSchema({
      executeSql: jest.fn(async (statement: string) => {
        sql.push(statement.replace(/\s+/g, ' ').trim());
        return [{ rows: { length: 0, item: () => null } }];
      }),
    } as any);
    expect(sql.join('\n')).toContain('continuation_historical_digests');
    for (const name of [
      'continuation_historical_digests',
      'continuation_historical_digest_chapters',
      'continuation_historical_index_terms',
    ]) {
      expect(SCHEMA_MANIFEST.find(table => table.name === name)).toEqual(
        expect.objectContaining({ backup: true }),
      );
    }
  });
});
