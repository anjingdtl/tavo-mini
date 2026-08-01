import type SQLite from 'react-native-sqlite-storage';
import { applyMigration } from './helpers';
import { buildSchema23CreateSqls } from './v22-to-v23';
import type { SqlStatement } from '../database/transaction';

/**
 * Schema 29 → 30: widen the persisted Canon-run stage constraint.
 *
 * `style_analysis` and `style_validation` were added to the source definition
 * of `continuation_analysis_runs`, but SQLite cannot alter a CHECK constraint.
 * Installations that had already executed the old v19→v20 migration therefore
 * kept an old `stage` list even after reaching schema 29. They completed all
 * Canon work items, then failed exactly when transitioning from `finalizing`
 * to `style_analysis`.
 *
 * Rebuild the run table and its direct child tables together. Rebuilding only
 * the parent is unsafe: SQLite rewrites the children to reference the renamed
 * parent, and dropping it can cascade-delete a user's resumable work. The
 * order below preserves every row and restores the original FK graph.
 */

function buildAnalysisRunsCreateSql(): string {
  return `CREATE TABLE IF NOT EXISTS continuation_analysis_runs (
    id TEXT PRIMARY KEY,
    project_id INTEGER NOT NULL,
    source_id INTEGER NOT NULL,
    source_version INTEGER NOT NULL,
    source_sha256 TEXT NOT NULL,
    parser_version TEXT NOT NULL,
    normalization_version TEXT NOT NULL,
    boundary_chapter_id INTEGER NOT NULL,
    boundary_position INTEGER NOT NULL,
    boundary_char_offset_exclusive INTEGER NOT NULL,
    canon_snapshot_id TEXT NOT NULL,
    profile TEXT NOT NULL,
    model_config_id INTEGER,
    state TEXT NOT NULL,
    stage TEXT NOT NULL,
    progress_current INTEGER NOT NULL DEFAULT 0,
    progress_total INTEGER NOT NULL DEFAULT 0,
    extraction_version TEXT NOT NULL,
    checkpoint_json TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    CHECK(source_version >= 1),
    CHECK(boundary_position >= 0),
    CHECK(boundary_char_offset_exclusive >= 0),
    CHECK(profile IN ('quick', 'standard', 'deep')),
    CHECK(state IN (
      'queued', 'running', 'paused', 'awaiting_review',
      'completed', 'failed', 'cancelled', 'outdated'
    )),
    CHECK(stage IN (
      'snapshot', 'chapter_extraction', 'entity_resolution',
      'temporal_merge', 'global_synthesis', 'evidence_validation',
      'indexing', 'finalizing', 'style_analysis', 'style_validation'
    )),
    CHECK(progress_current >= 0),
    CHECK(progress_total >= 0),
    CHECK(progress_total = 0 OR progress_current <= progress_total),
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY(source_id) REFERENCES continuation_sources(id) ON DELETE CASCADE,
    FOREIGN KEY(model_config_id) REFERENCES llm_config(id) ON DELETE SET NULL,
    FOREIGN KEY(canon_snapshot_id)
      REFERENCES continuation_canon_snapshots(id) ON DELETE CASCADE
  )`;
}

function buildAnalysisBatchesCreateSql(): string {
  return `CREATE TABLE IF NOT EXISTS continuation_analysis_batches (
    run_id TEXT NOT NULL,
    canon_snapshot_id TEXT NOT NULL,
    batch_index INTEGER NOT NULL,
    start_position INTEGER NOT NULL,
    end_position INTEGER NOT NULL,
    input_hash TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL DEFAULT 'queued',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    result_json TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    PRIMARY KEY(run_id, batch_index),
    CHECK(batch_index >= 0),
    CHECK(start_position >= 0 AND end_position > start_position),
    CHECK(state IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
    CHECK(attempt_count >= 0),
    FOREIGN KEY(run_id) REFERENCES continuation_analysis_runs(id) ON DELETE CASCADE,
    FOREIGN KEY(canon_snapshot_id)
      REFERENCES continuation_canon_snapshots(id) ON DELETE CASCADE
  )`;
}

/** Exported for tests and as the single migration source of truth. */
export function buildV29toV30Statements(): SqlStatement[] {
  const [workItemsCreateSql, workItemsIndexSql] = buildSchema23CreateSqls();
  return [
    // Rename children first, so every historical FK is isolated from the
    // replacement tables while data is copied.
    {
      sql: 'ALTER TABLE continuation_analysis_work_items RENAME TO continuation_analysis_work_items_v29',
    },
    {
      sql: 'ALTER TABLE continuation_analysis_batches RENAME TO continuation_analysis_batches_v29',
    },
    {
      sql: 'ALTER TABLE continuation_analysis_runs RENAME TO continuation_analysis_runs_v29',
    },
    { sql: buildAnalysisRunsCreateSql() },
    { sql: buildAnalysisBatchesCreateSql() },
    { sql: workItemsCreateSql },
    {
      sql: `INSERT INTO continuation_analysis_runs (
        id, project_id, source_id, source_version, source_sha256,
        parser_version, normalization_version, boundary_chapter_id,
        boundary_position, boundary_char_offset_exclusive, canon_snapshot_id,
        profile, model_config_id, state, stage, progress_current,
        progress_total, extraction_version, checkpoint_json, error_code,
        error_message, created_at, updated_at, completed_at
      ) SELECT
        id, project_id, source_id, source_version, source_sha256,
        parser_version, normalization_version, boundary_chapter_id,
        boundary_position, boundary_char_offset_exclusive, canon_snapshot_id,
        profile, model_config_id, state, stage, progress_current,
        progress_total, extraction_version, checkpoint_json, error_code,
        error_message, created_at, updated_at, completed_at
      FROM continuation_analysis_runs_v29`,
    },
    {
      sql: `INSERT INTO continuation_analysis_batches (
        run_id, canon_snapshot_id, batch_index, start_position, end_position,
        input_hash, idempotency_key, state, attempt_count, result_json,
        error_code, error_message, created_at, updated_at, completed_at
      ) SELECT
        run_id, canon_snapshot_id, batch_index, start_position, end_position,
        input_hash, idempotency_key, state, attempt_count, result_json,
        error_code, error_message, created_at, updated_at, completed_at
      FROM continuation_analysis_batches_v29`,
    },
    {
      sql: `INSERT INTO continuation_analysis_work_items (
        run_id, batch_index, material_type, state, attempt_count, result_json,
        error_code, error_message, created_at, updated_at, completed_at
      ) SELECT
        run_id, batch_index, material_type, state, attempt_count, result_json,
        error_code, error_message, created_at, updated_at, completed_at
      FROM continuation_analysis_work_items_v29`,
    },
    // Drop the old dependency chain leaf-to-root. This avoids an ON DELETE
    // cascade deleting the copied, resumable task records.
    { sql: 'DROP TABLE continuation_analysis_work_items_v29' },
    { sql: 'DROP TABLE continuation_analysis_batches_v29' },
    { sql: 'DROP TABLE continuation_analysis_runs_v29' },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_analysis_runs_project_state
        ON continuation_analysis_runs(project_id, state)`,
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_continuation_analysis_batches_state
        ON continuation_analysis_batches(run_id, state, batch_index)`,
    },
    { sql: workItemsIndexSql },
  ];
}

export async function migrateV29ToV30(
  database: SQLite.SQLiteDatabase,
): Promise<void> {
  await applyMigration(database, buildV29toV30Statements());
  const [foreignKeyCheck] = await database.executeSql(
    'PRAGMA foreign_key_check',
  );
  if (foreignKeyCheck.rows.length > 0) {
    throw new Error(
      `Schema 30 迁移后发现 ${foreignKeyCheck.rows.length} 条外键孤儿记录`,
    );
  }
}
