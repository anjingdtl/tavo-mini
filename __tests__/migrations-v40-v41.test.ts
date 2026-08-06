/**
 * Phase 3: Schema 40 → 41 pipeline_stage_attempts migration.
 */
import { SCHEMA_VERSION } from '../src/services/migrations';
import {
  buildV40toV41Statements,
  buildSchema41CreateSqls,
  PIPELINE_STAGE_ATTEMPTS_DDL,
} from '../src/services/migrations/v40-to-v41';
import { SCHEMA_MANIFEST } from '../src/services/database/schemaManifest';

describe('Schema 40 → 41 pipeline stage attempts', () => {
  it('reports SCHEMA_VERSION >= 41', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(41);
  });

  it('creates pipeline_stage_attempts with attempt bookkeeping columns', () => {
    const stmts = buildV40toV41Statements();
    expect(stmts[0].sql).toContain('pipeline_stage_attempts');
    expect(stmts[0].sql).toContain('UNIQUE (pipeline_task_id, stage, attempt_no)');
    expect(stmts[0].sql).toContain('request_fingerprint');
    expect(stmts[0].sql).toContain('failure_class');
    expect(stmts[0].sql).toContain('retry_after_ms');
    expect(stmts[0].sql).toContain('next_retry_at');
    expect(stmts[0].sql).toContain('provider_request_id');
    expect(stmts[0].sql).toContain(
      'FOREIGN KEY (pipeline_task_id) REFERENCES pipeline_tasks(id) ON DELETE CASCADE',
    );
    // retry schedule index for cold-start due checks
    const index = stmts.map(s => s.sql).join('\n');
    expect(index).toContain('idx_pipeline_stage_attempts_retry');
  });

  it('fresh install helper includes the same table', () => {
    const sqls = buildSchema41CreateSqls();
    expect(sqls.some(s => s.includes('pipeline_stage_attempts'))).toBe(true);
  });

  it('registers the table in the schema manifest with backup enabled', () => {
    const manifest = SCHEMA_MANIFEST.find(t => t.name === 'pipeline_stage_attempts');
    expect(manifest).toBeDefined();
    expect(manifest!.backup).toBe(true);
    expect(manifest!.columns).toContain('allocation_trace_json');
    expect(manifest!.columns).toContain('llm_config_snapshot_json');
    expect(manifest!.restoreOrder).toBeGreaterThan(150);
  });

  it('DDL is idempotent (CREATE TABLE IF NOT EXISTS)', () => {
    expect(PIPELINE_STAGE_ATTEMPTS_DDL).toContain('CREATE TABLE IF NOT EXISTS');
  });
});
