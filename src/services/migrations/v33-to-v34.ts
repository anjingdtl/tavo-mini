/**
 * Schema 33 → 34: Continuation V5 persistence primitives.
 *
 * V5 introduces new physical stage names, intermediate artifact eligibility,
 * draft/revision_1/final artifact stages, and awaiting_regeneration run state.
 * SQLite cannot widen CHECK constraints in place, so the three affected tables
 * are rebuilt. Historical V2/V4 rows are copied unchanged.
 */
import type SQLite from 'react-native-sqlite-storage';
import { applyMigration } from './helpers';
import type { SqlStatement } from '../database/transaction';

const RUN_COLUMNS = [
  'id',
  'project_id',
  'chapter_id',
  'target_position',
  'source_id',
  'source_snapshot_json',
  'canon_snapshot_id',
  'canon_revision',
  'story_memory_fingerprint',
  'story_memory_through_position',
  'input_revision_hash',
  'user_instruction',
  'settings_snapshot_json',
  'context_snapshot_json',
  'context_trace_json',
  'token_usage_json',
  'state',
  'stage',
  'completion_reason',
  'adopted_revision_hash',
  'finalized_revision_hash',
  'error_code',
  'error_message',
  'created_at',
  'updated_at',
  'completed_at',
] as const;

const RUN_COLUMN_LIST = RUN_COLUMNS.join(', ');

const ARTIFACT_COLUMNS = [
  'id',
  'run_id',
  'stage',
  'repair_round',
  'parent_artifact_id',
  'content',
  'content_hash',
  'eligibility_status',
  'rejection_code',
  'created_at',
] as const;

const ARTIFACT_COLUMN_LIST = ARTIFACT_COLUMNS.join(', ');

const STAGE_RESULT_COLUMNS = [
  'id',
  'run_id',
  'stage',
  'status',
  'request_reserved',
  'request_count',
  'model_config_id',
  'input_tokens',
  'output_tokens',
  'min_output_tokens',
  'max_output_tokens',
  'output_json',
  'artifact_id',
  'error_code',
  'error_message',
  'started_at',
  'completed_at',
  'created_at',
  'updated_at',
] as const;

const STAGE_RESULT_COLUMN_LIST = STAGE_RESULT_COLUMNS.join(', ');

/** Shared by Schema 34 migration and fresh-install create path. */
export function buildSchema34RunCreateSql(): string {
  return `CREATE TABLE IF NOT EXISTS continuation_generation_runs (
    id TEXT PRIMARY KEY,
    project_id INTEGER NOT NULL,
    chapter_id INTEGER NOT NULL,
    target_position INTEGER NOT NULL,
    source_id INTEGER,
    source_snapshot_json TEXT NOT NULL,
    canon_snapshot_id TEXT,
    canon_revision INTEGER NOT NULL,
    story_memory_fingerprint TEXT NOT NULL,
    story_memory_through_position INTEGER NOT NULL,
    input_revision_hash TEXT NOT NULL,
    user_instruction TEXT NOT NULL,
    settings_snapshot_json TEXT NOT NULL,
    context_snapshot_json TEXT,
    context_trace_json TEXT,
    token_usage_json TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL,
    stage TEXT NOT NULL,
    completion_reason TEXT,
    adopted_revision_hash TEXT,
    finalized_revision_hash TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    CHECK(id LIKE 'ct_%'),
    CHECK(target_position >= 0),
    CHECK(canon_revision >= 1),
    CHECK(story_memory_through_position >= -1),
    CHECK(state IN (
      'queued', 'running', 'awaiting_user', 'awaiting_regeneration',
      'completed', 'failed', 'cancelled', 'interrupted', 'outdated'
    )),
    CHECK(stage IN (
      'context', 'planner', 'writer', 'checker', 'auditing',
      'repair', 'local_verify', 'awaiting_user',
      'draft_writer', 'narrative_architect', 'revision_writer',
      'adversarial_auditor', 'final_reviser', 'final_validate',
      'round1', 'round2', 'round3'
    )),
    CHECK(completion_reason IS NULL OR completion_reason IN ('adopted', 'abandoned')),
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY(chapter_id) REFERENCES chapters(id) ON DELETE CASCADE,
    FOREIGN KEY(source_id) REFERENCES continuation_sources(id) ON DELETE SET NULL,
    FOREIGN KEY(canon_snapshot_id) REFERENCES continuation_canon_snapshots(id) ON DELETE SET NULL
  )`;
}

export function buildSchema34StageResultsCreateSql(): string {
  return `CREATE TABLE IF NOT EXISTS continuation_generation_stage_results (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    status TEXT NOT NULL,
    request_reserved INTEGER NOT NULL DEFAULT 0,
    request_count INTEGER NOT NULL DEFAULT 0,
    model_config_id INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    min_output_tokens INTEGER,
    max_output_tokens INTEGER,
    output_json TEXT,
    artifact_id TEXT,
    error_code TEXT,
    error_message TEXT,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK(stage IN (
      'writer', 'checker', 'control', 'repair', 'local_verify',
      'draft_writer', 'narrative_architect', 'revision_writer',
      'adversarial_auditor', 'final_reviser', 'final_validate'
    )),
    CHECK(status IN ('queued', 'running', 'success', 'failed', 'interrupted', 'skipped')),
    CHECK(request_reserved IN (0, 1)),
    CHECK(request_count BETWEEN 0 AND 1),
    CHECK(input_tokens IS NULL OR input_tokens >= 0),
    CHECK(output_tokens IS NULL OR output_tokens >= 0),
    CHECK(min_output_tokens IS NULL OR min_output_tokens >= 0),
    CHECK(max_output_tokens IS NULL OR max_output_tokens >= 0),
    UNIQUE(run_id, stage),
    FOREIGN KEY(run_id) REFERENCES continuation_generation_runs(id) ON DELETE CASCADE,
    FOREIGN KEY(model_config_id) REFERENCES llm_config(id) ON DELETE SET NULL,
    FOREIGN KEY(artifact_id) REFERENCES continuation_generation_artifacts(id) ON DELETE SET NULL
  )`;
}

export function buildSchema34ArtifactsCreateSql(): string {
  return `CREATE TABLE IF NOT EXISTS continuation_generation_artifacts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    repair_round INTEGER NOT NULL DEFAULT 0,
    parent_artifact_id TEXT,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    eligibility_status TEXT NOT NULL DEFAULT 'eligible',
    rejection_code TEXT,
    created_at TEXT NOT NULL,
    CHECK(stage IN (
      'writer', 'repair', 'user_edit',
      'draft', 'revision_1', 'final'
    )),
    CHECK(eligibility_status IN ('eligible', 'rejected', 'intermediate')),
    CHECK(repair_round >= 0),
    UNIQUE(run_id, content_hash),
    FOREIGN KEY(run_id) REFERENCES continuation_generation_runs(id) ON DELETE CASCADE,
    FOREIGN KEY(parent_artifact_id) REFERENCES continuation_generation_artifacts(id) ON DELETE SET NULL
  )`;
}

export function buildV33toV34Statements(): SqlStatement[] {
  return [
    // 1) Artifacts first: children reference runs; parent_artifact self-FK is
    // deferred via PRAGMA foreign_keys = OFF around the migration.
    {
      sql: `ALTER TABLE continuation_generation_artifacts
        RENAME TO continuation_generation_artifacts_v33`,
    },
    { sql: buildSchema34ArtifactsCreateSql() },
    {
      sql: `INSERT INTO continuation_generation_artifacts (${ARTIFACT_COLUMN_LIST})
        SELECT ${ARTIFACT_COLUMN_LIST} FROM continuation_generation_artifacts_v33`,
    },
    { sql: 'DROP TABLE continuation_generation_artifacts_v33' },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_continuation_artifacts_run_created
        ON continuation_generation_artifacts(run_id, created_at)`,
    },

    // 2) Stage results: drop so the parent run rebuild does not leave orphans.
    {
      sql: `ALTER TABLE continuation_generation_stage_results
        RENAME TO continuation_generation_stage_results_v33`,
    },

    // 3) Runs rebuild with expanded state/stage CHECKs.
    {
      sql: `ALTER TABLE continuation_generation_runs
        RENAME TO continuation_generation_runs_v33`,
    },
    { sql: buildSchema34RunCreateSql() },
    {
      sql: `INSERT INTO continuation_generation_runs (${RUN_COLUMN_LIST})
        SELECT ${RUN_COLUMN_LIST} FROM continuation_generation_runs_v33`,
    },
    { sql: 'DROP TABLE continuation_generation_runs_v33' },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_continuation_runs_project_created
        ON continuation_generation_runs(project_id, created_at DESC)`,
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_continuation_runs_chapter_created
        ON continuation_generation_runs(chapter_id, created_at DESC)`,
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_continuation_runs_state
        ON continuation_generation_runs(state, updated_at)`,
    },

    // 4) Stage results with expanded stage CHECK.
    { sql: buildSchema34StageResultsCreateSql() },
    {
      sql: `INSERT INTO continuation_generation_stage_results (${STAGE_RESULT_COLUMN_LIST})
        SELECT ${STAGE_RESULT_COLUMN_LIST}
        FROM continuation_generation_stage_results_v33`,
    },
    { sql: 'DROP TABLE continuation_generation_stage_results_v33' },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_continuation_stage_results_run_state
        ON continuation_generation_stage_results(run_id, status, updated_at)`,
    },
  ];
}

/** Fresh-install DDL appended after Schema 32/33 setup. */
export function buildSchema34CreateSqls(): string[] {
  return [
    'PRAGMA foreign_keys = OFF',
    'PRAGMA legacy_alter_table = ON',
    ...buildV33toV34Statements().map(statement => statement.sql),
    'PRAGMA legacy_alter_table = OFF',
    'PRAGMA foreign_keys = ON',
  ];
}

export async function migrateV33ToV34(
  database: SQLite.SQLiteDatabase,
): Promise<void> {
  await database.executeSql('PRAGMA foreign_keys = OFF');
  await database.executeSql('PRAGMA legacy_alter_table = ON');
  try {
    await applyMigration(database, buildV33toV34Statements());
  } finally {
    await database.executeSql('PRAGMA legacy_alter_table = OFF');
    await database.executeSql('PRAGMA foreign_keys = ON');
  }

  const [foreignKeyCheck] = await database.executeSql(
    'PRAGMA foreign_key_check',
  );
  if (foreignKeyCheck.rows.length > 0) {
    throw new Error(
      `Schema 34 迁移后发现 ${foreignKeyCheck.rows.length} 条外键孤儿记录`,
    );
  }
}
