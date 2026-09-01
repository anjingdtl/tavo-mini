import type SQLite from 'react-native-sqlite-storage';
import { executeTransaction } from '../database/transaction';
import { tableColumns } from './helpers';

/**
 * IV-13U durable identity primitives.
 *
 * The current-final relation is deliberately separate from the immutable
 * artifact history: many historical Final rows are allowed, while this table
 * has at most one active row per run. The receipt table stores one common
 * WritingRequestReceipt per physical request plus bounded action metadata; it
 * never stores prompts, response bodies, credentials, or a second call ledger.
 */
export function buildCurrentFinalAuthorityCreateSql(): string {
  return `
    CREATE TABLE IF NOT EXISTS continuation_current_final_authorities (
      run_id TEXT PRIMARY KEY NOT NULL,
      active_final_artifact_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES continuation_generation_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (active_final_artifact_id) REFERENCES continuation_generation_artifacts(id) ON DELETE RESTRICT
    )`;
}

export function buildWritingRequestReceiptsCreateSql(): string {
  return `
    CREATE TABLE IF NOT EXISTS writing_request_receipts (
      request_id TEXT PRIMARY KEY NOT NULL,
      project_id INTEGER NOT NULL,
      action_id TEXT NOT NULL UNIQUE,
      preview_id TEXT NOT NULL,
      candidate_kind TEXT NOT NULL CHECK(candidate_kind IN ('chapter', 'pipeline_task', 'continuation_run')),
      candidate_id TEXT NOT NULL,
      candidate_project_id INTEGER NOT NULL,
      candidate_chapter_id INTEGER NOT NULL,
      action_kind TEXT NOT NULL CHECK(action_kind IN ('targeted_revision', 'whole_chapter_rewrite')),
      instruction_fingerprint TEXT NOT NULL,
      base_body_fingerprint TEXT NOT NULL,
      candidate_body_fingerprint TEXT,
      preview_state TEXT NOT NULL CHECK(preview_state IN ('started', 'pending', 'applied', 'discarded', 'failed')),
      receipt_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )`;
}

export function buildV60ToV61CreateSqls(): string[] {
  return [
    buildCurrentFinalAuthorityCreateSql(),
    'CREATE INDEX IF NOT EXISTS idx_continuation_current_final_artifact ON continuation_current_final_authorities(active_final_artifact_id)',
    buildWritingRequestReceiptsCreateSql(),
    'CREATE INDEX IF NOT EXISTS idx_writing_request_receipts_project_updated ON writing_request_receipts(project_id, updated_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_writing_request_receipts_preview_state ON writing_request_receipts(preview_state, updated_at DESC)',
  ];
}

/**
 * Schema 60 → 61. Existing artifacts remain immutable. If an old run has
 * several eligible rows, backfill chooses exactly one by the same explicit
 * stage priority and deterministic timestamp/id order used by the historical
 * read path; all other rows remain history and are never deleted.
 */
export async function migrateV60ToV61(
  db: SQLite.SQLiteDatabase,
): Promise<void> {
  const authorityColumns = await tableColumns(
    db,
    'continuation_current_final_authorities',
  ).catch(() => new Set<string>());
  const continuationRunColumns = await tableColumns(
    db,
    'continuation_generation_runs',
  ).catch(() => new Set<string>());
  const continuationArtifactColumns = await tableColumns(
    db,
    'continuation_generation_artifacts',
  ).catch(() => new Set<string>());
  const statements = buildV60ToV61CreateSqls().filter(statement => {
    if (
      statement.includes('idx_continuation_current_final_artifact') ||
      statement.includes('idx_writing_request_receipts_project_updated') ||
      statement.includes('idx_writing_request_receipts_preview_state')
    ) {
      return true;
    }
    if (statement.includes('continuation_current_final_authorities')) {
      return authorityColumns.size === 0;
    }
    return true;
  });

  await executeTransaction(
    db,
    statements.map(sql => ({ sql })),
    { faultDomain: 'migration' },
  );
  // Some migration unit fixtures intentionally contain only the table under
  // test. The additive schema objects can still be created there, but there
  // is no continuation history to backfill until the real domain tables are
  // present. A complete upgraded install always takes the backfill branch.
  if (
    continuationRunColumns.size === 0 ||
    continuationArtifactColumns.size === 0
  ) {
    return;
  }
  await executeTransaction(
    db,
    [
      {
        sql: `INSERT OR IGNORE INTO continuation_current_final_authorities (
          run_id, active_final_artifact_id, updated_at
        )
        SELECT a.run_id, a.id, a.created_at
          FROM continuation_generation_artifacts AS a
         WHERE a.eligibility_status = 'eligible'
           AND a.stage IN ('writer', 'repair', 'user_edit', 'final')
           AND a.id = (
             SELECT candidate.id
               FROM continuation_generation_artifacts AS candidate
              WHERE candidate.run_id = a.run_id
                AND candidate.eligibility_status = 'eligible'
                AND candidate.stage IN ('writer', 'repair', 'user_edit', 'final')
              ORDER BY CASE candidate.stage
                WHEN 'final' THEN 0
                WHEN 'repair' THEN 1
                WHEN 'writer' THEN 2
                ELSE 3
              END,
              candidate.created_at DESC, candidate.id DESC
              LIMIT 1
           )`,
      },
    ],
    { faultDomain: 'migration' },
  );
}
