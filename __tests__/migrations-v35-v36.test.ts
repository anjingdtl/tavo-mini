/**
 * Schema 35 → 36 outline migration tests (大纲创作模式升级, 阶段 1).
 *
 * Verifies the migration creates the `outlines` table with the expected columns
 * and indexes, that fresh-install DDL mirrors it, and that the schema version
 * is now 36.
 */
import { SCHEMA_VERSION } from '../src/services/migrations';
import {
  buildV35toV36Statements,
  buildSchema36CreateSqls,
  buildSchema36OutlinesCreateSql,
} from '../src/services/migrations/v35-to-v36';

describe('Schema 35 → 36 outline migration', () => {
  it('reports SCHEMA_VERSION as 36', () => {
    expect(SCHEMA_VERSION).toBe(36);
  });

  it('outlines table DDL has all required columns', () => {
    const ddl = buildSchema36OutlinesCreateSql();
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS outlines');
    expect(ddl).toContain('id INTEGER PRIMARY KEY AUTOINCREMENT');
    expect(ddl).toContain('project_id INTEGER NOT NULL');
    expect(ddl).toContain('title TEXT NOT NULL');
    expect(ddl).toContain('content TEXT NOT NULL');
    expect(ddl).toContain("source_type TEXT NOT NULL DEFAULT 'manual'");
    expect(ddl).toContain('source_file_name TEXT');
    expect(ddl).toContain('enabled INTEGER NOT NULL DEFAULT 0');
    expect(ddl).toContain('position INTEGER NOT NULL DEFAULT 0');
    expect(ddl).toContain('estimated_tokens INTEGER NOT NULL DEFAULT 0');
    expect(ddl).toContain('content_hash TEXT NOT NULL');
    expect(ddl).toContain('created_at INTEGER NOT NULL');
    expect(ddl).toContain('updated_at INTEGER NOT NULL');
    // ON DELETE CASCADE mirrors every other project-scoped table.
    expect(ddl).toContain('ON DELETE CASCADE');
    // CHECK constraints guard the source_type and enabled values.
    expect(ddl).toContain("CHECK(source_type IN ('manual', 'txt'))");
    expect(ddl).toContain('CHECK(enabled IN (0, 1))');
  });

  it('migration statements create table + both indexes', () => {
    const stmts = buildV35toV36Statements();
    const sqls = stmts.map(s => s.sql);
    expect(sqls.some(s => /CREATE TABLE IF NOT EXISTS outlines/.test(s))).toBe(true);
    expect(
      sqls.some(s => /idx_outlines_project_position/.test(s)),
    ).toBe(true);
    expect(
      sqls.some(s => /idx_outlines_project_enabled/.test(s)),
    ).toBe(true);
  });

  it('fresh-install DDL matches migration DDL', () => {
    const fresh = buildSchema36CreateSqls();
    const migration = buildV35toV36Statements().map(s => s.sql);
    expect(fresh).toEqual(migration);
  });

  it('all statements are pure SQL (no params needed for DDL)', () => {
    const stmts = buildV35toV36Statements();
    for (const stmt of stmts) {
      // DDL statements have no params; only data migrations do.
      expect(stmt.params).toBeUndefined();
      expect(typeof stmt.sql).toBe('string');
      expect(stmt.sql.length).toBeGreaterThan(0);
    }
  });

  it('enabled defaults to 0 (disabled) per the plan', () => {
    const ddl = buildSchema36OutlinesCreateSql();
    // The default must be 0 so new/imported outlines start disabled.
    expect(ddl).toMatch(/enabled INTEGER NOT NULL DEFAULT 0/);
  });
});
