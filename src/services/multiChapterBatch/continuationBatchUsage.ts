/**
 * Continuation batch usage aggregation (doc §26).
 *
 * Continuation runs never write pipeline attempt rows; the authoritative
 * per-run telemetry lives in `continuation_generation_stage_results`
 * (input/output tokens + request_count per stage). This module folds those
 * rows into the batch header usage counters as a SET (idempotent,
 * crash-safe), mirroring setBatchUsageFromRuns for the outline mode.
 */
import { openDatabase } from '../../data/connection/openDatabase';
import { execute } from '../../data/connection/execute';
import type { MultiChapterBatchItemRow } from '../../data/repositories/multiChapterBatchRepository';

export interface ContinuationBatchUsage {
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Aggregate billable usage across every continuation run bound to the batch
 * items. Items carry at most one active binding (a new run requires explicit
 * user action, doc §25), so the bound set is the complete billed set.
 */
export async function computeContinuationBatchUsage(
  items: Pick<MultiChapterBatchItemRow, 'activeContinuationRunId'>[],
): Promise<ContinuationBatchUsage> {
  const runIds = items
    .map(item => item.activeContinuationRunId)
    .filter((id): id is string => Boolean(id));
  if (runIds.length === 0) {
    return { llmCalls: 0, inputTokens: 0, outputTokens: 0 };
  }
  const db = await openDatabase();
  const placeholders = runIds.map(() => '?').join(',');
  const [res] = await db.executeSql(
    `SELECT
       COALESCE(SUM(request_count), 0) AS llm_calls,
       COALESCE(SUM(input_tokens), 0) AS input_tokens,
       COALESCE(SUM(output_tokens), 0) AS output_tokens
     FROM continuation_generation_stage_results
     WHERE run_id IN (${placeholders})`,
    runIds,
  );
  if (res.rows.length === 0) {
    return { llmCalls: 0, inputTokens: 0, outputTokens: 0 };
  }
  const row = res.rows.item(0) as {
    llm_calls: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
  };
  return {
    llmCalls: Number(row.llm_calls ?? 0),
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
  };
}

/** SET (not increment) the batch usage from continuation run telemetry. */
export async function setBatchUsageFromContinuationRuns(
  batchId: string,
  items: Pick<MultiChapterBatchItemRow, 'activeContinuationRunId'>[],
): Promise<ContinuationBatchUsage> {
  const usage = await computeContinuationBatchUsage(items);
  await execute(
    await openDatabase(),
    `UPDATE multi_chapter_batches
     SET used_llm_calls = ?, used_input_tokens = ?, used_output_tokens = ?, updated_at = ?
     WHERE id = ?`,
    [usage.llmCalls, usage.inputTokens, usage.outputTokens, Date.now(), batchId],
  );
  return usage;
}
