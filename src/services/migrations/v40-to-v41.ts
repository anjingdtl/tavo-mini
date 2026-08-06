/**
 * Schema 40 → 41: pipeline_stage_attempts (durable per-attempt records).
 *
 * Generic pipeline infrastructure shared by single-chapter and batch modes.
 * Each row records one LLM call attempt for one stage: frozen request
 * fingerprint + allocation trace, LLM config snapshot, provider ids, failure
 * classification and the persisted retry schedule (next_retry_at).
 *
 * Non-breaking: creates a new table only.
 */
import type SQLite from 'react-native-sqlite-storage';
import type { SqlStatement } from '../database/transaction';
import { executeTransaction } from '../database/transaction';

export const PIPELINE_STAGE_ATTEMPTS_DDL = `
CREATE TABLE IF NOT EXISTS pipeline_stage_attempts (
  id TEXT PRIMARY KEY,
  pipeline_task_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,

  request_version INTEGER NOT NULL DEFAULT 1,
  request_fingerprint TEXT NOT NULL,
  allocation_trace_json TEXT,
  frozen_request_json TEXT,

  llm_config_id INTEGER,
  llm_config_snapshot_json TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  provider_request_id TEXT,

  status TEXT NOT NULL,
  failure_class TEXT,
  error_code TEXT,
  error_message TEXT,
  http_status INTEGER,
  retry_after_ms INTEGER,

  started_at INTEGER NOT NULL,
  last_progress_at INTEGER,
  deadline_at INTEGER,
  next_retry_at INTEGER,
  completed_at INTEGER,

  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,

  UNIQUE (pipeline_task_id, stage, attempt_no),
  FOREIGN KEY (pipeline_task_id) REFERENCES pipeline_tasks(id) ON DELETE CASCADE
)`;

export function buildV40toV41Statements(): SqlStatement[] {
  return [
    { sql: PIPELINE_STAGE_ATTEMPTS_DDL },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_pipeline_stage_attempts_task_stage
            ON pipeline_stage_attempts(pipeline_task_id, stage, attempt_no)`,
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_pipeline_stage_attempts_retry
            ON pipeline_stage_attempts(status, next_retry_at)`,
    },
  ];
}

/** Schema 41 fresh-install SQL (new table + indexes). */
export function buildSchema41CreateSqls(): string[] {
  return [
    PIPELINE_STAGE_ATTEMPTS_DDL,
    `CREATE INDEX IF NOT EXISTS idx_pipeline_stage_attempts_task_stage
      ON pipeline_stage_attempts(pipeline_task_id, stage, attempt_no)`,
    `CREATE INDEX IF NOT EXISTS idx_pipeline_stage_attempts_retry
      ON pipeline_stage_attempts(status, next_retry_at)`,
  ];
}

/** Logic migration — creates the attempts table if absent. */
export async function migrateV40ToV41(
  db: SQLite.SQLiteDatabase,
): Promise<void> {
  const statements = buildV40toV41Statements();
  await executeTransaction(db, statements, { faultDomain: 'migration' });
}
