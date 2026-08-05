/**
 * Schema 35 → 36: Outline resource (大纲创作模式升级).
 *
 * Introduces the `outlines` table so a project's outline becomes a first-class
 * resource with independent enable/position/token-budget semantics, separate
 * from the polymorphic `project_resources` link table. Outlines are project-
 * level planning documents (future plot direction), NOT chapter-level synopsis
 * (which lives in `chapters.synopsis`) and NOT facts.
 *
 * Design notes:
 *  - `enabled` defaults to 0: newly created/imported outlines are OFF until the
 *    user explicitly enables them, mirroring how the existing resource types
 *    start disabled for a new project.
 *  - `position` carries deterministic ordering inside one project; combined
 *    with the `idx_outlines_project_position` index the context builder can
 *    stitch outlines in a stable, user-controlled order.
 *  - `content_hash` stores a SHA-256 of the content so the pipeline snapshot
 *    fingerprint does not require re-hashing at generation time.
 *  - `ON DELETE CASCADE` on `project_id` mirrors every other project-scoped
 *    table so deleting a project cleans up its outlines.
 */
import type { SqlStatement } from '../database/transaction';

/** Shared by the v35→v36 migration and the fresh-install create path. */
export function buildSchema36OutlinesCreateSql(): string {
  return `CREATE TABLE IF NOT EXISTS outlines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    source_type TEXT NOT NULL DEFAULT 'manual',
    source_file_name TEXT,
    enabled INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    estimated_tokens INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK(source_type IN ('manual', 'txt')),
    CHECK(enabled IN (0, 1)),
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
  )`;
}

/** v35 → v36 statements: pure additive (new table + indexes). */
export function buildV35toV36Statements(): SqlStatement[] {
  return [
    { sql: buildSchema36OutlinesCreateSql() },
    {
      sql: 'CREATE INDEX IF NOT EXISTS idx_outlines_project_position ON outlines(project_id, position)',
    },
    {
      sql: 'CREATE INDEX IF NOT EXISTS idx_outlines_project_enabled ON outlines(project_id, enabled)',
    },
  ];
}

/** Fresh-install DDL appended after the Schema 35 setup. */
export function buildSchema36CreateSqls(): string[] {
  return buildV35toV36Statements().map(statement => statement.sql);
}
