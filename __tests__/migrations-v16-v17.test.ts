import { createCurrentSchema } from '../src/data/schema/createCurrentSchema';
import { SCHEMA_MANIFEST } from '../src/services/database/schemaManifest';
import { SCHEMA_VERSION } from '../src/services/migrations';
import { buildV16toV17Statements } from '../src/services/migrations/v16-to-v17';

describe('schema 17 note collection migration', () => {
  it('adds note collections, note membership and its lookup index', () => {
    const sql = buildV16toV17Statements().map(item => item.sql);
    expect(sql.some(item => item.includes('CREATE TABLE IF NOT EXISTS note_collections'))).toBe(true);
    expect(sql).toContain('ALTER TABLE notes ADD COLUMN collection_id INTEGER NOT NULL DEFAULT 0');
    expect(sql.some(item => item.includes('idx_notes_collection_id'))).toBe(true);
    expect(SCHEMA_VERSION).toBe(17);
  });

  it('keeps fresh installs and backup validation aligned', async () => {
    const sql: string[] = [];
    await createCurrentSchema({
      executeSql: jest.fn(async (statement: string) => {
        sql.push(statement.replace(/\s+/g, ' ').trim());
        return [{ rows: { length: 0, item: () => null } }];
      }),
    } as any);

    expect(sql.join('\n')).toContain('CREATE TABLE IF NOT EXISTS note_collections');
    expect(sql.join('\n')).toContain('collection_id INTEGER NOT NULL DEFAULT 0');
    expect(SCHEMA_MANIFEST.find(item => item.name === 'note_collections')).toEqual(
      expect.objectContaining({ backup: true, restoreOrder: 85 }),
    );
    expect(SCHEMA_MANIFEST.find(item => item.name === 'notes')?.columns).toContain('collection_id');
  });
});
