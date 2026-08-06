/**
 * Batch pipeline task id helpers.
 *
 * Batch orchestrator tasks are named `batch_<batchId>_ord<ordinal>_<ts>`.
 * The root-level pipeline-result prompt must never surface these per-chapter
 * tasks — the batch state machine adopts results automatically and reports
 * once at the end.
 */

export const BATCH_TASK_ID_PREFIX = 'batch_';

export function isBatchPipelineTaskId(taskId: string): boolean {
  return String(taskId || '').startsWith(BATCH_TASK_ID_PREFIX);
}
