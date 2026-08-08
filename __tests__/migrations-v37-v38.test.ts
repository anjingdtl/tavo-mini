/**
 * Schema 37 → 38 frozen pipeline context migration tests.
 */
import {
  buildSchema38CreateSqls,
  buildV37toV38Statements,
} from '../src/services/migrations/v37-to-v38';
import { executeTransaction } from '../src/services/database/transaction';
import { createEmptyInMemoryDb } from './helpers/canonInMemoryDb';

describe('Schema 37 → 38 frozen pipeline context', () => {
  it('adds all three nullable columns and leaves existing task data unchanged', async () => {
    const db = await createEmptyInMemoryDb();
    try {
      await db.executeSql(
        `CREATE TABLE pipeline_tasks (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          stage_results TEXT NOT NULL,
          payload TEXT NOT NULL
        )`,
      );
      await db.executeSql(
        `INSERT INTO pipeline_tasks (id, status, stage_results, payload)
         VALUES ('t1', 'failed', '[{"stage":"draft"}]', 'frozen')`,
      );

      await executeTransaction(db as any, buildV37toV38Statements(), {
        faultDomain: 'migration',
      });

      const [columns] = await db.executeSql('PRAGMA table_info(pipeline_tasks)');
      const names: string[] = [];
      for (let i = 0; i < columns.rows.length; i += 1) {
        names.push(columns.rows.item(i).name);
      }
      expect(names).toEqual([
        'id',
        'status',
        'stage_results',
        'payload',
        'pipeline_context_json',
        'pipeline_context_version',
        'pipeline_context_hash',
      ]);

      const [row] = await db.executeSql(
        `SELECT id, status, stage_results, payload,
                pipeline_context_json, pipeline_context_version,
                pipeline_context_hash
           FROM pipeline_tasks
          WHERE id = 't1'`,
      );
      expect(row.rows.item(0)).toMatchObject({
        id: 't1',
        status: 'failed',
        stage_results: '[{"stage":"draft"}]',
        payload: 'frozen',
        pipeline_context_json: null,
        pipeline_context_version: null,
        pipeline_context_hash: null,
      });
    } finally {
      db.close();
    }
  });

  it('fresh Schema 38 builder is empty because columns are inline', () => {
    expect(buildSchema38CreateSqls()).toEqual([]);
  });
});
