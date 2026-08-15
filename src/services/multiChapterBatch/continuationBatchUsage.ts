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
 * Aggregate billable usage across every continuation run belonging to one of
 * the batch-created chapters. An item carries only one active run binding;
 * after an explicit retry the old failed run is deliberately unbound. Using
 * only `active_continuation_run_id` would therefore erase the old request
 * from the batch budget on retry. Chapter IDs are durable batch ownership
 * anchors, so all historical runs for those chapters remain auditable and
 * billable without adding another migration-only binding table.
 */
export async function computeContinuationBatchUsage(
  items: Pick<MultiChapterBatchItemRow, 'activeContinuationRunId' | 'chapterId'>[],
): Promise<ContinuationBatchUsage> {
  const runIds = items
    .map(item => item.activeContinuationRunId)
    .filter((id): id is string => Boolean(id));
  const chapterIds = items
    .map(item => item.chapterId)
    .filter((id): id is number => id != null)
    .map(id => Number(id))
    .filter(id => Number.isFinite(id));
  if (runIds.length === 0 && chapterIds.length === 0) {
    return { llmCalls: 0, inputTokens: 0, outputTokens: 0 };
  }
  const db = await openDatabase();
  const predicates: string[] = [];
  const params: Array<string | number> = [];
  if (runIds.length > 0) {
    predicates.push(`s.run_id IN (${runIds.map(() => '?').join(',')})`);
    params.push(...runIds);
  }
  if (chapterIds.length > 0) {
    predicates.push(`r.chapter_id IN (${chapterIds.map(() => '?').join(',')})`);
    params.push(...chapterIds);
  }
  const [res] = await db.executeSql(
    `SELECT
       COALESCE(SUM(s.request_count), 0) AS llm_calls,
       COALESCE(SUM(s.input_tokens), 0) AS input_tokens,
       COALESCE(SUM(s.output_tokens), 0) AS output_tokens
     FROM continuation_generation_stage_results s
     JOIN continuation_generation_runs r ON r.id = s.run_id
     WHERE ${predicates.join(' OR ')}`,
    params,
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
  items: Pick<MultiChapterBatchItemRow, 'activeContinuationRunId' | 'chapterId'>[],
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
