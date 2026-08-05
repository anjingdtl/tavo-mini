/**
 * Schema 36 → 37: Persist pipeline task input fingerprint.
 *
 * Adds an `input_fingerprint` column to `pipeline_tasks` so the result-adoption
 * flow can detect whether the project outline or the target chapter changed
 * between task start and the moment the user adopts the generated text.
 *
 * The fingerprint is a stable hash of (projectId, chapterId, chapterUpdatedAt,
 * outlineFingerprint) computed once when buildContext freezes the snapshot, and
 * persisted only at task terminal state (completeTask / setTaskFinalText).
 *
 * Non-breaking: pure ADD COLUMN with NULL default. Legacy rows have NULL and
 * the adopt-time comparison treats a missing/NULL fingerprint as "no baseline"
 * (never reports a false change).
 */
import type { SqlStatement } from '../database/transaction';

/** v36 → v37 statements: single additive column. */
export function buildV36toV37Statements(): SqlStatement[] {
  return [
    {
      sql: `ALTER TABLE pipeline_tasks ADD COLUMN input_fingerprint TEXT`,
    },
  ];
}

/**
 * Fresh-install DDL mirror. The fresh `pipeline_tasks` CREATE TABLE in
 * createCurrentSchema.ts declares `input_fingerprint` inline, so this helper
 * is empty (no extra statements needed beyond the inline column).
 */
export function buildSchema37CreateSqls(): string[] {
  return [];
}
