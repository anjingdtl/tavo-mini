import { SCHEMA_VERSION } from '../src/services/migrations';
import {
  buildV38toV39Statements,
  buildSchema39CreateSqls,
} from '../src/services/migrations/v38-to-v39';

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
});
