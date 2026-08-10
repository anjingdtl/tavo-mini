/**
 * Schema 49 → 50: durable Story Memory physical-request ledger.
 *
 * Story Memory cannot safely reuse pipeline_stage_attempts because that table
 * is intentionally tied to pipeline_tasks. This small ledger records only
 * transport lifecycle metadata, never prompts, chapter bodies, credentials or
 * reasoning text. A row is written as `sent` before fetch(); a cold start can
 * therefore classify an interrupted request as outcome_unknown instead of
 * silently charging it again.
 */
import type SQLite from 'react-native-sqlite-storage';
import type { SqlStatement } from '../database/transaction';
import { executeTransaction } from '../database/transaction';

export const STORY_MEMORY_REQUEST_ATTEMPTS_DDL = `
CREATE TABLE IF NOT EXISTS story_memory_request_attempts (
  attempt_id TEXT PRIMARY KEY,
  logical_batch_id TEXT NOT NULL,
  project_id INTEGER NOT NULL,
  from_position INTEGER NOT NULL,
  through_position INTEGER NOT NULL,
  request_kind TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(
    status IN ('prepared', 'sent', 'succeeded', 'failed', 'outcome_unknown', 'cancelled')
  ),
  failure_class TEXT,
  error_code TEXT,
  http_status INTEGER,
  provider_request_id TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  UNIQUE(logical_batch_id, attempt_no),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
)`;

export const STORY_MEMORY_REQUEST_ATTEMPTS_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_story_memory_request_attempts_project
     ON story_memory_request_attempts(project_id, started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_story_memory_request_attempts_status
     ON story_memory_request_attempts(status, started_at ASC)`,
] as const;

export function buildSchema50CreateSqls(): string[] {
  return [STORY_MEMORY_REQUEST_ATTEMPTS_DDL, ...STORY_MEMORY_REQUEST_ATTEMPTS_INDEXES];
}
export function buildV49toV50Statements(): SqlStatement[] {
  return buildSchema50CreateSqls().map(sql => ({ sql }));
}

export async function migrateV49ToV50(
  db: SQLite.SQLiteDatabase,
): Promise<void> {
  await executeTransaction(db, buildV49toV50Statements(), {
    faultDomain: 'migration',
  });
}
