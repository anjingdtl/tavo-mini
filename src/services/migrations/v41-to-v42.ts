/**
 * Schema 41 → 42: multi-chapter batch tables.
 *
 * Three tables:
 *   multi_chapter_batches         — batch header (plan, budget, lease, status)
 *   multi_chapter_batch_items     — one row per planned chapter (ordinal key)
 *   multi_chapter_batch_item_runs — pipeline task per item (model-change runs)
 *
 * All tables are `backup: true` (metadata; chapter bodies live in chapters).
 * Non-breaking: creates new tables + indexes only.
 */
import type SQLite from 'react-native-sqlite-storage';
import type { SqlStatement } from '../database/transaction';
import { executeTransaction } from '../database/transaction';

export const MULTI_CHAPTER_BATCHES_DDL = `
CREATE TABLE IF NOT EXISTS multi_chapter_batches (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,

  status TEXT NOT NULL,
  source_prompt TEXT NOT NULL,
  chapter_count INTEGER NOT NULL,
  target_words_per_chapter INTEGER NOT NULL,
  pipeline_mode TEXT NOT NULL,

  planner_output_json TEXT,
  planner_hash TEXT,
  planner_request_json TEXT,
  planner_request_fingerprint TEXT,

  start_position INTEGER,
  expected_tail_chapter_id INTEGER,
  current_ordinal INTEGER NOT NULL DEFAULT 1,
  completed_count INTEGER NOT NULL DEFAULT 0,
  active_item_ordinal INTEGER,

  max_llm_calls INTEGER,
  max_input_tokens INTEGER,
  max_output_tokens INTEGER,
  used_llm_calls INTEGER NOT NULL DEFAULT 0,
  used_input_tokens INTEGER NOT NULL DEFAULT 0,
  used_output_tokens INTEGER NOT NULL DEFAULT 0,

  outline_workflow_version INTEGER NOT NULL DEFAULT 1,
  context_budget_version INTEGER NOT NULL DEFAULT 1,

  pause_reason TEXT,
  error_code TEXT,
  error_message TEXT,

  lease_owner TEXT,
  lease_expires_at INTEGER,
  row_version INTEGER NOT NULL DEFAULT 0,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  cancelled_at INTEGER,

  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
)`;

export const MULTI_CHAPTER_BATCH_ITEMS_DDL = `
CREATE TABLE IF NOT EXISTS multi_chapter_batch_items (
  batch_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,

  title TEXT NOT NULL,
  synopsis TEXT NOT NULL,
  key_beats_json TEXT NOT NULL,
  carry_in TEXT,
  carry_out TEXT,
  target_words INTEGER NOT NULL,

  status TEXT NOT NULL,
  chapter_id INTEGER,
  active_pipeline_task_id TEXT,
  active_run_no INTEGER NOT NULL DEFAULT 0,

  completion_quality TEXT,
  adoption_fingerprint TEXT,
  adopted_revision_id INTEGER,

  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,
  error_code TEXT,
  error_message TEXT,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,

  PRIMARY KEY (batch_id, ordinal),
  FOREIGN KEY (batch_id)
    REFERENCES multi_chapter_batches(id)
    ON DELETE CASCADE,
  FOREIGN KEY (chapter_id)
    REFERENCES chapters(id)
    ON DELETE SET NULL,
  FOREIGN KEY (active_pipeline_task_id)
    REFERENCES pipeline_tasks(id)
    ON DELETE SET NULL
)`;

export const MULTI_CHAPTER_BATCH_ITEM_RUNS_DDL = `
CREATE TABLE IF NOT EXISTS multi_chapter_batch_item_runs (
  batch_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  run_no INTEGER NOT NULL,

  pipeline_task_id TEXT NOT NULL,
  llm_config_snapshot_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,

  created_at INTEGER NOT NULL,
  completed_at INTEGER,

  PRIMARY KEY (batch_id, ordinal, run_no),
  UNIQUE (pipeline_task_id),

  FOREIGN KEY (batch_id, ordinal)
    REFERENCES multi_chapter_batch_items(batch_id, ordinal)
    ON DELETE CASCADE,
  FOREIGN KEY (pipeline_task_id)
    REFERENCES pipeline_tasks(id)
    ON DELETE CASCADE
)`;

export function buildV41toV42Statements(): SqlStatement[] {
  return [
    { sql: MULTI_CHAPTER_BATCHES_DDL },
    { sql: MULTI_CHAPTER_BATCH_ITEMS_DDL },
    { sql: MULTI_CHAPTER_BATCH_ITEM_RUNS_DDL },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_multi_batches_project_status
            ON multi_chapter_batches(project_id, status, updated_at)`,
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_multi_items_status
            ON multi_chapter_batch_items(batch_id, status, ordinal)`,
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_multi_items_retry
            ON multi_chapter_batch_items(status, next_retry_at)`,
    },
  ];
}

/** Schema 42 fresh-install SQL (new tables + indexes). */
export function buildSchema42CreateSqls(): string[] {
  return [
    MULTI_CHAPTER_BATCHES_DDL,
    MULTI_CHAPTER_BATCH_ITEMS_DDL,
    MULTI_CHAPTER_BATCH_ITEM_RUNS_DDL,
    `CREATE INDEX IF NOT EXISTS idx_multi_batches_project_status
      ON multi_chapter_batches(project_id, status, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_multi_items_status
      ON multi_chapter_batch_items(batch_id, status, ordinal)`,
    `CREATE INDEX IF NOT EXISTS idx_multi_items_retry
      ON multi_chapter_batch_items(status, next_retry_at)`,
  ];
}

/** Logic migration — creates the three batch tables if absent. */
export async function migrateV41ToV42(
  db: SQLite.SQLiteDatabase,
): Promise<void> {
  const statements = buildV41toV42Statements();
  await executeTransaction(db, statements, { faultDomain: 'migration' });
}
