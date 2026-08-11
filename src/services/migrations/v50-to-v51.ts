/**
 * Schema 50 → 51: nullable prompt-cache telemetry columns.
 *
 * DeepSeek's automatic prefix cache reports `prompt_cache_hit_tokens` /
 * `prompt_cache_miss_tokens` inside `usage`. This migration adds four nullable
 * INTEGER columns — two on `llm_usage_logs` (global per-call telemetry) and two
 * on `pipeline_stage_attempts` (per-stage telemetry) — so cache hit/miss can be
 * aggregated for cost analysis.
 *
 * Boundary (per Prompt Cache P0 plan):
 * - Additive, idempotent; every column is checked before ALTER TABLE.
 * - Columns are nullable. Historical rows stay NULL ("not collected then"),
 *   never backfilled to 0.
 * - No cache columns are added to story_memory_request_attempts,
 *   multi_chapter_batches, pipeline_tasks, chapters or project_story_memory.
 * - No new indexes — cache fields are aggregation-only, never lookup keys.
 * - Nothing persisted here is a prompt, chapter body, API key or reasoning text.
 *
 * Fresh installs and 50→51 upgrades must reach the same physical schema, which
 * is why the DDL also lives in createCurrentSchema.ts via buildSchema51CreateSqls.
 */
import type SQLite from 'react-native-sqlite-storage';
import type { SqlStatement } from '../database/transaction';
import { executeTransaction } from '../database/transaction';
import { tableColumns } from './helpers';

export const V51_LLM_USAGE_LOGS_COLUMNS = [
  {
    name: 'prompt_cache_hit_tokens',
    ddl: 'ALTER TABLE llm_usage_logs ADD COLUMN prompt_cache_hit_tokens INTEGER',
  },
  {
    name: 'prompt_cache_miss_tokens',
    ddl: 'ALTER TABLE llm_usage_logs ADD COLUMN prompt_cache_miss_tokens INTEGER',
  },
] as const;

export const V51_PIPELINE_STAGE_ATTEMPTS_COLUMNS = [
  {
    name: 'prompt_cache_hit_tokens',
    ddl: 'ALTER TABLE pipeline_stage_attempts ADD COLUMN prompt_cache_hit_tokens INTEGER',
  },
  {
    name: 'prompt_cache_miss_tokens',
    ddl: 'ALTER TABLE pipeline_stage_attempts ADD COLUMN prompt_cache_miss_tokens INTEGER',
  },
] as const;

/** Fresh-install helper: emit only the ALTERs createCurrentSchema cannot inline. */
export function buildSchema51CreateSqls(): string[] {
  return [
    ...V51_LLM_USAGE_LOGS_COLUMNS.map(column => column.ddl),
    ...V51_PIPELINE_STAGE_ATTEMPTS_COLUMNS.map(column => column.ddl),
  ];
}

export async function migrateV50ToV51(
  db: SQLite.SQLiteDatabase,
): Promise<void> {
  // PRAGMA table_info returns no rows for a table that does not exist. Both
  // target tables always exist by Schema 50 in production (llm_usage_logs since
  // Schema 10, pipeline_stage_attempts since Schema 41), but a drifted/partial
  // database may be missing one. Skip a missing table rather than crash: the
  // manifest-based schemaValidator still flags a truly-missing table, and
  // createCurrentSchema creates fresh tables with these columns already inlined.
  const usageColumns = await tableColumns(db, 'llm_usage_logs');
  const attemptColumns = await tableColumns(db, 'pipeline_stage_attempts');
  const statements: SqlStatement[] = [
    ...(usageColumns.size > 0
      ? V51_LLM_USAGE_LOGS_COLUMNS.filter(
          column => !usageColumns.has(column.name),
        )
      : []),
    ...(attemptColumns.size > 0
      ? V51_PIPELINE_STAGE_ATTEMPTS_COLUMNS.filter(
          column => !attemptColumns.has(column.name),
        )
      : []),
  ].map(column => ({ sql: column.ddl }));
  if (statements.length > 0) {
    await executeTransaction(db, statements, { faultDomain: 'migration' });
  }
}
