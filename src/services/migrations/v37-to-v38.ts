/**
 * Schema 37 → 38: Persist frozen PipelineContextSnapshot on pipeline_tasks.
 *
 * Free-form / outline chapter pipelines previously kept the shared context
 * snapshot only in memory. Resume after process death re-called buildContext()
 * against the live database, so mid-task outline edits could change what
 * Review / Fact Check / Proof saw.
 *
 * Additive columns:
 *  - pipeline_context_json    full frozen snapshot JSON
 *  - pipeline_context_version snapshot schema version (currently 1)
 *  - pipeline_context_hash    integrity hash of the JSON body
 *
 * Non-breaking: pure ADD COLUMN with NULL defaults. Legacy rows have NULL and
 * resume surfaces an explicit compatibility limitation rather than silently
 * rebuilding from current resources.
 */
import type { SqlStatement } from '../database/transaction';

/** v37 → v38 statements: three additive columns on pipeline_tasks. */
export function buildV37toV38Statements(): SqlStatement[] {
  return [
    {
      sql: `ALTER TABLE pipeline_tasks ADD COLUMN pipeline_context_json TEXT`,
    },
    {
      sql: `ALTER TABLE pipeline_tasks ADD COLUMN pipeline_context_version INTEGER`,
    },
    {
      sql: `ALTER TABLE pipeline_tasks ADD COLUMN pipeline_context_hash TEXT`,
    },
  ];
}

/**
 * Fresh-install DDL mirror. Columns are declared inline on pipeline_tasks in
 * createCurrentSchema.ts, so no extra statements are required here.
 */
export function buildSchema38CreateSqls(): string[] {
  return [];
}
