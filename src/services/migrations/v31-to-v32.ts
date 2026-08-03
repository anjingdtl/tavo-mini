import type SQLite from 'react-native-sqlite-storage';
import { applyMigration, tableColumns } from './helpers';
import type { SqlStatement } from '../database/transaction';

/**
 * Schema 31 → 32: persistence primitives for continuation FULL-Control V4.
 *
 * The existing generation tables are deliberately kept compatible with the
 * historical Planner/V2 workflow. V4 adds one routing column, widens the run
 * stage CHECK, records one result row per physical stage, and makes artifact
 * adoption an explicit persisted decision instead of a created_at heuristic.
 */

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

/** SQL used by both the Schema 31 migration and the fresh current schema. */
export function buildSchema32RunCreateSql(): string {
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
      'queued', 'running', 'awaiting_user', 'completed',
      'failed', 'cancelled', 'interrupted', 'outdated'
    )),
    CHECK(stage IN (
      'context', 'planner', 'writer', 'checker', 'auditing',
      'repair', 'local_verify', 'awaiting_user'
    )),
    CHECK(completion_reason IS NULL OR completion_reason IN ('adopted', 'abandoned')),
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY(chapter_id) REFERENCES chapters(id) ON DELETE CASCADE,
    FOREIGN KEY(source_id) REFERENCES continuation_sources(id) ON DELETE SET NULL,
    FOREIGN KEY(canon_snapshot_id) REFERENCES continuation_canon_snapshots(id) ON DELETE SET NULL
  )`;
}

export function buildSchema32StageResultsCreateSql(): string {
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
    CHECK(stage IN ('writer', 'checker', 'control', 'repair', 'local_verify')),
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

/**
 * DDL/DML for an upgraded Schema 31 database. The parent runs table is
 * rebuilt because SQLite cannot alter a CHECK constraint in place. Child
 * tables retain their textual FK target while the old parent is renamed, so
 * their rows remain attached to the replacement table without rebuilding the
 * whole continuation state graph.
 */
export function buildV31toV32Statements(): SqlStatement[] {
  return [
    {
      sql: `ALTER TABLE continuation_generation_runs
        RENAME TO continuation_generation_runs_v31`,
    },
    { sql: buildSchema32RunCreateSql() },
    {
      sql: `INSERT INTO continuation_generation_runs (${RUN_COLUMN_LIST})
        SELECT ${RUN_COLUMN_LIST} FROM continuation_generation_runs_v31`,
    },
    { sql: 'DROP TABLE continuation_generation_runs_v31' },
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
    {
      // SQLite ADD COLUMN cannot add a table-level FK on every Android
      // SQLite version, but a nullable column-level reference is supported by
      // the bundled engine and is also covered by schemaValidator.
      sql: `ALTER TABLE continuation_generation_settings
        ADD COLUMN control_llm_config_id INTEGER
          REFERENCES llm_config(id) ON DELETE SET NULL`,
    },
    {
      sql: `ALTER TABLE continuation_generation_artifacts
        ADD COLUMN eligibility_status TEXT NOT NULL DEFAULT 'eligible'
          CHECK(eligibility_status IN ('eligible', 'rejected'))`,
    },
    {
      sql: `ALTER TABLE continuation_generation_artifacts
        ADD COLUMN rejection_code TEXT`,
    },
    { sql: buildSchema32StageResultsCreateSql() },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_continuation_stage_results_run_state
        ON continuation_generation_stage_results(run_id, status, updated_at)`,
    },
  ];
}

/**
 * Statements for a fresh install. createCurrentSchema executes these one by
 * one, so the connection-level PRAGMAs are intentionally included here rather
 * than inside the migration transaction.
 */
export function buildSchema32CreateSqls(): string[] {
  return [
    'PRAGMA foreign_keys = OFF',
    'PRAGMA legacy_alter_table = ON',
    ...buildV31toV32Statements().map(statement => statement.sql),
    'PRAGMA legacy_alter_table = OFF',
    'PRAGMA foreign_keys = ON',
  ];
}

export async function migrateV31ToV32(
  database: SQLite.SQLiteDatabase,
): Promise<void> {
  const settingsColumns = await tableColumns(
    database,
    'continuation_generation_settings',
  );
  const artifactColumns = await tableColumns(
    database,
    'continuation_generation_artifacts',
  );
  const statements = buildV31toV32Statements().filter(statement => {
    if (statement.sql.includes('ADD COLUMN control_llm_config_id')) {
      return !settingsColumns.has('control_llm_config_id');
    }
    if (statement.sql.includes('ADD COLUMN eligibility_status')) {
      return !artifactColumns.has('eligibility_status');
    }
    if (statement.sql.includes('ADD COLUMN rejection_code')) {
      return !artifactColumns.has('rejection_code');
    }
    return true;
  });

  // PRAGMA foreign_keys is a no-op once a transaction has started. Set both
  // flags before applyMigration and always restore them after commit/rollback.
  await database.executeSql('PRAGMA foreign_keys = OFF');
  await database.executeSql('PRAGMA legacy_alter_table = ON');
  try {
    await applyMigration(database, statements);
  } finally {
    await database.executeSql('PRAGMA legacy_alter_table = OFF');
    await database.executeSql('PRAGMA foreign_keys = ON');
  }

  const [foreignKeyCheck] = await database.executeSql(
    'PRAGMA foreign_key_check',
  );
  if (foreignKeyCheck.rows.length > 0) {
    throw new Error(
      `Schema 32 迁移后发现 ${foreignKeyCheck.rows.length} 条外键孤儿记录`,
    );
  }
}
