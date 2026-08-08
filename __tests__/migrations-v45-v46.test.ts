import { createEmptyInMemoryDb } from './helpers/canonInMemoryDb';
import { __resetForTest, __setDatabaseForTest } from '../src/data/connection/openDatabase';
import { SCHEMA_VERSION } from '../src/services/migrations';
import {
  buildV45toV46Statements,
  migrateV45ToV46,
  BATCH_REASONING_EFFORT_COLUMN,
} from '../src/services/migrations/v45-to-v46';

describe('Schema 45 → 46 batch reasoning tier freeze', () => {
  afterEach(() => {
    __resetForTest();
  });

  test('declares the next schema and one nullable batch column', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(46);
    expect(buildV45toV46Statements()).toHaveLength(1);
    expect(buildV45toV46Statements()[0].sql).toContain(
      `ADD COLUMN ${BATCH_REASONING_EFFORT_COLUMN} TEXT`,
    );
  });

  test('adds the column idempotently and preserves historical NULL', async () => {
    const db = await createEmptyInMemoryDb();
    __setDatabaseForTest(db as any);
    await db.executeSql(`
      CREATE TABLE multi_chapter_batches (
        id TEXT PRIMARY KEY,
        pipeline_mode TEXT NOT NULL
      )
    `);
    await db.executeSql(
      `INSERT INTO multi_chapter_batches (id, pipeline_mode) VALUES ('b1', 'full')`,
    );

    await migrateV45ToV46(db as any);
    await migrateV45ToV46(db as any);

    const [columns] = await db.executeSql(
      'PRAGMA table_info(multi_chapter_batches)',
    );
    const names = columns.rows.raw().map((row: { name: string }) => row.name);
    expect(names).toContain(BATCH_REASONING_EFFORT_COLUMN);
    const [rows] = await db.executeSql(
      `SELECT reasoning_effort FROM multi_chapter_batches WHERE id = 'b1'`,
    );
    expect(rows.rows.item(0).reasoning_effort).toBeNull();
  });
});
