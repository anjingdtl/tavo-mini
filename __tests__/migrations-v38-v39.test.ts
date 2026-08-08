import { SCHEMA_VERSION } from '../src/services/migrations';
import {
  buildV38toV39Statements,
  buildSchema39CreateSqls,
  migrateV38ToV39,
} from '../src/services/migrations/v38-to-v39';
import { createEmptyInMemoryDb } from './helpers/canonInMemoryDb';

describe('Schema 38 → 39 pipeline stage checkpoints', () => {
  it('reports SCHEMA_VERSION >= 39', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(39);
  });

  it('creates pipeline_stage_checkpoints with PK(task_id, stage)', () => {
    const stmts = buildV38toV39Statements();
    expect(stmts[0].sql).toContain('pipeline_stage_checkpoints');
    expect(stmts[0].sql).toContain('PRIMARY KEY (task_id, stage)');
    expect(stmts[0].sql).toContain('attempt_count');
  });

  it('fresh install helper includes the same table', () => {
    const sqls = buildSchema39CreateSqls();
    expect(sqls.some(s => s.includes('pipeline_stage_checkpoints'))).toBe(
      true,
    );
  });

  it('backfills every legacy status, chooses the highest-priority record, and preserves fields', async () => {
    const db = await createEmptyInMemoryDb();
    try {
      await db.executeSql(
        `CREATE TABLE pipeline_tasks (
          id TEXT PRIMARY KEY,
          stage_results TEXT
        )`,
      );
      const stageResults = [
        null,
        {},
        { stage: '', status: 'success' },
        {
          stage: 'draft',
          status: 'success',
          text: '成功正文',
          tokens: { input: 1, output: 2, total: 3 },
          durationMs: 12,
        },
        { stage: 'draft', status: 'failed', text: '低优先级失败' },
        { stage: 'review', status: 'succeeded', text: '已成功' },
        { stage: 'factCheck', status: 'skipped', text: '跳过' },
        { stage: 'proof', status: 'failed', error: '超时' },
        { stage: 'running', status: 'running' },
        { stage: 'interrupted', status: 'interrupted' },
        { stage: 'unknown', status: 'future_status' },
        { stage: 'pending', text: '默认 pending' },
        { stage: 'tie', status: 'failed', text: 'first' },
        { stage: 'tie', status: 'failed', text: 'last' },
      ];
      await db.executeSql(
        `INSERT INTO pipeline_tasks (id, stage_results) VALUES (?, ?)`,
        ['task-1', JSON.stringify(stageResults)],
      );

      await migrateV38ToV39(db as any);

      const [rows] = await db.executeSql(
        `SELECT stage, status, output_text, error_message,
                input_tokens, output_tokens, total_tokens, duration_ms,
                completed_at
           FROM pipeline_stage_checkpoints
          WHERE task_id = 'task-1'
          ORDER BY stage`,
      );
      const byStage = new Map<string, any>();
      for (let i = 0; i < rows.rows.length; i += 1) {
        const row = rows.rows.item(i);
        byStage.set(row.stage, row);
      }
      expect(byStage.get('draft')).toMatchObject({
        status: 'succeeded',
        output_text: '成功正文',
        input_tokens: 1,
        output_tokens: 2,
        total_tokens: 3,
        duration_ms: 12,
      });
      expect(byStage.get('review')).toMatchObject({
        status: 'succeeded',
        output_text: '已成功',
      });
      expect(byStage.get('factCheck').status).toBe('skipped');
      expect(byStage.get('proof')).toMatchObject({
        status: 'failed',
        error_message: '超时',
      });
      expect(byStage.get('running')).toMatchObject({
        status: 'running',
        completed_at: null,
      });
      expect(byStage.get('interrupted')).toMatchObject({
        status: 'interrupted',
        completed_at: null,
      });
      expect(byStage.get('unknown')).toMatchObject({
        status: 'pending',
        completed_at: null,
      });
      expect(byStage.get('pending')).toMatchObject({
        status: 'pending',
        output_text: '默认 pending',
      });
      expect(byStage.get('tie')).toMatchObject({
        status: 'failed',
        output_text: 'last',
      });
      expect(rows.rows.length).toBe(9);
      for (const stage of ['draft', 'review', 'factCheck', 'proof']) {
        expect(byStage.get(stage).completed_at).not.toBeNull();
      }
    } finally {
      db.close();
    }
  });

  it('skips null, empty, invalid and non-array payloads without an upsert', async () => {
    const db = await createEmptyInMemoryDb();
    try {
      await db.executeSql(
        `CREATE TABLE pipeline_tasks (
          id TEXT PRIMARY KEY,
          stage_results TEXT
        )`,
      );
      await db.executeSql(
        `INSERT INTO pipeline_tasks (id, stage_results) VALUES
          ('null', NULL),
          ('empty', '[]'),
          ('invalid', '{not-json'),
          ('object', '{"stage":"draft"}')`,
      );

      await migrateV38ToV39(db as any);

      const [rows] = await db.executeSql(
        `SELECT COUNT(*) AS count FROM pipeline_stage_checkpoints`,
      );
      expect(rows.rows.item(0).count).toBe(0);
    } finally {
      db.close();
    }
  });

  it('splits more than 50 checkpoint upserts and remains stable on rerun', async () => {
    const db = await createEmptyInMemoryDb();
    try {
      await db.executeSql(
        `CREATE TABLE pipeline_tasks (
          id TEXT PRIMARY KEY,
          stage_results TEXT
        )`,
      );
      for (let i = 0; i < 51; i += 1) {
        await db.executeSql(
          `INSERT INTO pipeline_tasks (id, stage_results) VALUES (?, ?)`,
          [
            `bulk-${i}`,
            JSON.stringify([{ stage: 'draft', status: 'success', text: `正文${i}` }]),
          ],
        );
      }

      await migrateV38ToV39(db as any);
      const [before] = await db.executeSql(
        `SELECT task_id, stage, status, output_text
           FROM pipeline_stage_checkpoints
          ORDER BY task_id`,
      );
      expect(before.rows.length).toBe(51);

      await migrateV38ToV39(db as any);
      const [after] = await db.executeSql(
        `SELECT task_id, stage, status, output_text
           FROM pipeline_stage_checkpoints
          ORDER BY task_id`,
      );
      expect(after.rows.length).toBe(51);
      expect(after.rows.item(50)).toMatchObject({
        task_id: 'bulk-9',
        stage: 'draft',
        status: 'succeeded',
      });
    } finally {
      db.close();
    }
  });
});
