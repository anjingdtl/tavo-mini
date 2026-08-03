/**
 * Schema 32 → 33: Canon fact deduplication infrastructure + evidence provenance.
 *
 * Problem context: Canon fact tables (world_rules, characters, plot_threads,
 * relationships, experiences) had NO business-key uniqueness constraint.
 * Deduplication relied entirely on app-level positional DELETE-then-INSERT in
 * `materializeBatchResult`, which:
 *   - had a known gap (`canon_world_rules` was never deleted, so re-runs and
 *     targeted rescans accumulated duplicate rows);
 *   - was positional (scoped by `valid_from_position`), so a rescan covering a
 *     different chapter range left the original rows in place and inserted
 *     duplicates.
 *
 * This migration adds:
 *   1. Two provenance columns on `canon_evidence` (`source_origin`,
 *      `rescan_operation_id`) so the rescan path can scope its own deletes
 *      without touching batch evidence.
 *   2. Partial UNIQUE indexes on the natural business keys of each Canon fact
 *      table, scoped to active (non-superseded) rows. These are the durable,
 *      DB-level guard against duplicate facts. INSERT statements in
 *      `materializeRescanResult` use `INSERT ... ON CONFLICT DO UPDATE` so a
 *      rescan refreshes an existing fact in place instead of duplicating it.
 *
 * Before creating each UNIQUE index, duplicate rows are collapsed so a legacy
 * database with pre-existing duplicates upgrades cleanly (keep the highest-id /
 * newest row per business key, delete older duplicates). The cleanup is
 * idempotent and safe to re-run.
 *
 * Non-breaking: only ADD COLUMN + CREATE INDEX + duplicate cleanup. Existing
 * rows keep their values; `source_origin` defaults to 'batch' so existing
 * evidence is treated as the original batch product.
 */
import type { SqlStatement } from '../database/transaction';

/**
 * Provenance values for `canon_evidence.source_origin`.
 * - `batch`: written by a normal analysis batch (default for legacy rows).
 * - `rescan`: written by a targeted rescan round.
 */
export const EVIDENCE_SOURCE_ORIGIN_BATCH = 'batch';
export const EVIDENCE_SOURCE_ORIGIN_RESCAN = 'rescan';

export function buildV32toV33Statements(): SqlStatement[] {
  const statements: SqlStatement[] = [];

  // ── 1. canon_evidence provenance columns ──────────────────────────────
  // ALTER TABLE ADD COLUMN with a DEFAULT is supported by the bundled Android
  // SQLite and backfills existing rows with 'batch' so they are never mistaken
  // for rescan output.
  statements.push({
    sql: `ALTER TABLE canon_evidence ADD COLUMN source_origin TEXT NOT NULL DEFAULT 'batch'`,
  });
  statements.push({
    sql: `ALTER TABLE canon_evidence ADD COLUMN rescan_operation_id TEXT`,
  });

  // ── 2. Duplicate-row cleanup before UNIQUE indexes ────────────────────
  // For each fact table, delete older duplicate rows (keep the newest id per
  // business key among non-superseded rows). This makes the subsequent UNIQUE
  // index creation succeed on legacy databases that already contain duplicates
  // from the app-level dedup gap. Superseded rows are exempt (a superseded row
  // is intentionally retained as history and excluded by the partial index).
  statements.push({
    sql: dedupKeepNewestByBusinessKey('canon_world_rules', [
      'snapshot_id',
      'title',
    ]),
  });
  statements.push({
    sql: dedupKeepNewestByBusinessKey('canon_characters', [
      'snapshot_id',
      'canonical_name',
    ]),
  });
  statements.push({
    sql: dedupKeepNewestByBusinessKey('canon_plot_threads', [
      'snapshot_id',
      'title',
    ]),
  });
  statements.push({
    sql: dedupKeepNewestByBusinessKey('canon_relationships', [
      'snapshot_id',
      'source_character_id',
      'target_character_id',
      'relation_type',
    ]),
  });
  statements.push({
    sql: dedupKeepNewestByBusinessKey('canon_character_experiences', [
      'snapshot_id',
      'character_id',
      'event_type',
      'title',
    ]),
  });

  // ── 3. Partial UNIQUE indexes on business keys ────────────────────────
  // Partial (WHERE review_status != 'superseded') so a superseded revision can
  // coexist with its replacement without violating uniqueness.
  statements.push({
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_canon_world_rules_business
      ON canon_world_rules(snapshot_id, title)
      WHERE review_status != 'superseded'`,
  });
  statements.push({
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_canon_characters_business
      ON canon_characters(snapshot_id, canonical_name)
      WHERE review_status != 'superseded'`,
  });
  statements.push({
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_canon_plot_threads_business
      ON canon_plot_threads(snapshot_id, title)
      WHERE review_status != 'superseded'`,
  });
  statements.push({
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_canon_relationships_business
      ON canon_relationships(snapshot_id, source_character_id, target_character_id, relation_type)
      WHERE review_status != 'superseded'`,
  });
  statements.push({
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_canon_experiences_business
      ON canon_character_experiences(snapshot_id, character_id, event_type, title)
      WHERE review_status != 'superseded'`,
  });

  // Non-unique helper: find evidence rows by their rescan operation for scoped
  // deletes in the rescan materialization path.
  statements.push({
    sql: `CREATE INDEX IF NOT EXISTS idx_canon_evidence_rescan_op
      ON canon_evidence(snapshot_id, analysis_run_id, source_origin, rescan_operation_id)`,
  });

  return statements;
}

/**
 * Fresh-install CREATE statements for the Schema 33 UNIQUE indexes. Used by
 * `createCurrentSchema` so a brand-new database has the same deduplication
 * indexes as an upgraded one. Does NOT include the ALTER TABLE ADD COLUMN
 * statements (the fresh canon_evidence CREATE TABLE in v19-to-v20 already
 * declares `source_origin` / `rescan_operation_id`) and does NOT include the
 * duplicate-row cleanup (a fresh database has no duplicates).
 */
export function buildSchema33CreateSqls(): string[] {
  return [
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_canon_world_rules_business
      ON canon_world_rules(snapshot_id, title)
      WHERE review_status != 'superseded'`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_canon_characters_business
      ON canon_characters(snapshot_id, canonical_name)
      WHERE review_status != 'superseded'`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_canon_plot_threads_business
      ON canon_plot_threads(snapshot_id, title)
      WHERE review_status != 'superseded'`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_canon_relationships_business
      ON canon_relationships(snapshot_id, source_character_id, target_character_id, relation_type)
      WHERE review_status != 'superseded'`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_canon_experiences_business
      ON canon_character_experiences(snapshot_id, character_id, event_type, title)
      WHERE review_status != 'superseded'`,
    `CREATE INDEX IF NOT EXISTS idx_canon_evidence_rescan_op
      ON canon_evidence(snapshot_id, analysis_run_id, source_origin, rescan_operation_id)`,
  ];
}

/**
 * Build a DELETE statement that collapses duplicate rows of `table` on the
 * given business `keyColumns`, keeping only the newest (highest id) row per key
 * among non-superseded rows.
 *
 * Uses a self-join on rowid (stable for INTEGER PRIMARY KEY tables) to delete
 * every non-newest duplicate. Idempotent: after the first run there are no
 * duplicates, so subsequent runs delete zero rows.
 */
function dedupKeepNewestByBusinessKey(
  table: string,
  keyColumns: string[],
): string {
  const keyTuple = `(${keyColumns.join(', ')})`;
  return `DELETE FROM ${table}
    WHERE rowid NOT IN (
      SELECT MAX(rowid) FROM ${table}
      WHERE review_status != 'superseded'
      GROUP BY ${keyColumns.join(', ')}
    )
    AND review_status != 'superseded'
    AND ${keyTuple} IN (
      SELECT ${keyColumns.join(', ')} FROM ${table}
      WHERE review_status != 'superseded'
      GROUP BY ${keyColumns.join(', ')}
      HAVING COUNT(*) > 1
    )`;
}
