import { createEmptyInMemoryDb } from './helpers/canonInMemoryDb';
import { __resetForTest, __setDatabaseForTest } from '../src/data/connection/openDatabase';
import { SCHEMA_VERSION } from '../src/services/migrations';
import {
  buildV44toV45Statements,
  migrateV44ToV45,
  REASONING_TOKENS_COLUMN,
} from '../src/services/migrations/v44-to-v45';

describe('Schema 44 → 45 reasoning token observability', () => {
  afterEach(() => {
    __resetForTest();
  });

  test('declares Schema 45 and one nullable reasoning token column', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(45);
    expect(buildV44toV45Statements()).toHaveLength(1);
    expect(buildV44toV45Statements()[0].sql).toContain(
      `ADD COLUMN ${REASONING_TOKENS_COLUMN} INTEGER`,
    );
  });

  test('adds the column and is idempotent', async () => {
    const db = await createEmptyInMemoryDb();
    __setDatabaseForTest(db as any);
    await db.executeSql(`
      CREATE TABLE pipeline_stage_attempts (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        total_tokens INTEGER
      )
    `);
    await db.executeSql(
      `INSERT INTO pipeline_stage_attempts (id, status, output_tokens) VALUES ('a1', 'succeeded', 20)`,
    );

    await migrateV44ToV45(db as any);
    await migrateV44ToV45(db as any);

    const [columns] = await db.executeSql(
      'PRAGMA table_info(pipeline_stage_attempts)',
    );
    const names = columns.rows.raw().map((row: { name: string }) => row.name);
    expect(names).toContain(REASONING_TOKENS_COLUMN);
    const [rows] = await db.executeSql(
      `SELECT reasoning_tokens, output_tokens FROM pipeline_stage_attempts WHERE id = 'a1'`,
    );
    expect(rows.rows.item(0).reasoning_tokens).toBeNull();
    expect(Number(rows.rows.item(0).output_tokens)).toBe(20);
  });
});
