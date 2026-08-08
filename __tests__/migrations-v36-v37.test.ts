/**
 * Schema 36 → 37 input fingerprint migration tests.
 *
 * Verifies the migration adds the `input_fingerprint` column to pipeline_tasks
 * and that the schema version is now 37.
 */
import { SCHEMA_VERSION } from '../src/services/migrations';
import {
  buildSchema37CreateSqls,
  buildV36toV37Statements,
} from '../src/services/migrations/v36-to-v37';
import { executeTransaction } from '../src/services/database/transaction';
import { createEmptyInMemoryDb } from './helpers/canonInMemoryDb';

describe('Schema 36 → 37 input fingerprint migration', () => {
  it('reports SCHEMA_VERSION as 37', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(38);
  });

  it('adds input_fingerprint column to pipeline_tasks', () => {
    const stmts = buildV36toV37Statements();
    expect(stmts).toHaveLength(1);
    expect(stmts[0].sql).toContain('ALTER TABLE pipeline_tasks');
    expect(stmts[0].sql).toContain('ADD COLUMN input_fingerprint');
    expect(stmts[0].sql).toContain('TEXT');
  });

  it('is non-breaking (pure ADD COLUMN, no params)', () => {
    const stmts = buildV36toV37Statements();
    for (const stmt of stmts) {
      expect(stmt.params).toBeUndefined();
      expect(stmt.sql).not.toContain('DROP');
      expect(stmt.sql).not.toContain('RENAME');
    }
  });

  it('applies to a legacy table, defaults old rows to NULL, and preserves other columns', async () => {
    const db = await createEmptyInMemoryDb();
    try {
      await db.executeSql(
        `CREATE TABLE pipeline_tasks (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          payload TEXT NOT NULL
        )`,
      );
      await db.executeSql(
        `INSERT INTO pipeline_tasks (id, status, payload)
         VALUES ('t1', 'failed', 'frozen')`,
      );

      await executeTransaction(db as any, buildV36toV37Statements(), {
        faultDomain: 'migration',
      });

      const [columns] = await db.executeSql('PRAGMA table_info(pipeline_tasks)');
      const names: string[] = [];
      for (let i = 0; i < columns.rows.length; i += 1) {
        names.push(columns.rows.item(i).name);
      }
      expect(names).toContain('input_fingerprint');
      const [row] = await db.executeSql(
        `SELECT id, status, payload, input_fingerprint
           FROM pipeline_tasks
          WHERE id = 't1'`,
      );
      expect(row.rows.item(0)).toMatchObject({
        id: 't1',
        status: 'failed',
        payload: 'frozen',
        input_fingerprint: null,
      });
    } finally {
      db.close();
    }
  });

  it('fresh Schema 37 builder is intentionally empty because the column is inline', () => {
    expect(buildSchema37CreateSqls()).toEqual([]);
  });
});
