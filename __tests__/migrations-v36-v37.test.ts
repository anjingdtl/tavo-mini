/**
 * Schema 36 → 37 input fingerprint migration tests.
 *
 * Verifies the migration adds the `input_fingerprint` column to pipeline_tasks
 * and that the schema version is now 37.
 */
import { SCHEMA_VERSION } from '../src/services/migrations';
import { buildV36toV37Statements } from '../src/services/migrations/v36-to-v37';

describe('Schema 36 → 37 input fingerprint migration', () => {
  it('reports SCHEMA_VERSION as 37', () => {
    expect(SCHEMA_VERSION).toBe(37);
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
});
