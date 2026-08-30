/**
 * Durable stage checkpoints for freeform/chapter pipelines.
 * PRIMARY KEY (task_id, stage) — one effective row per stage.
 */
import { execute } from '../connection/execute';
import { all, one } from '../connection/query';
import { openDatabase } from '../connection/openDatabase';
import { executeTransaction } from '../../services/database/transaction';
import { getLatestStageAttempt } from './pipelineStageAttemptRepository';
import type { Row } from './shared';
import type {
  PipelineCheckpointStage,
  StageStatus,
} from '../../services/pipeline/types';

export interface PipelineStageCheckpointRow {
  taskId: string;
  stage: PipelineCheckpointStage;
  status: StageStatus;
  outputText: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  durationMs: number | null;
  attemptCount: number;
  startedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
}

export interface PipelineStageCheckpointSummary {
  taskId: string;
  stage: PipelineCheckpointStage;
  status: StageStatus;
  errorCode: string | null;
  errorMessage: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  durationMs: number | null;
  attemptCount: number;
  startedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
}

function mapRow(row: Row): PipelineStageCheckpointRow {
  return {
    taskId: String(row.task_id),
    stage: row.stage as PipelineCheckpointStage,
    status: row.status as StageStatus,
    outputText: row.output_text ?? null,
    errorCode: row.error_code ?? null,
    errorMessage: row.error_message ?? null,
    inputTokens:
      row.input_tokens != null ? Number(row.input_tokens) : null,
    outputTokens:
      row.output_tokens != null ? Number(row.output_tokens) : null,
    totalTokens:
      row.total_tokens != null ? Number(row.total_tokens) : null,
    durationMs: row.duration_ms != null ? Number(row.duration_ms) : null,
    attemptCount: Number(row.attempt_count || 0),
    startedAt: row.started_at != null ? Number(row.started_at) : null,
    completedAt: row.completed_at != null ? Number(row.completed_at) : null,
    updatedAt: Number(row.updated_at || 0),
  };
}

const CHECKPOINT_TEXT_CHUNK_CHARACTERS = 128 * 1024;

export async function getStageCheckpoints(
  taskId: string,
): Promise<PipelineStageCheckpointRow[]> {
  return getStageCheckpointsForDerivedFinalRewrite(taskId);
}

export async function getStageCheckpoint(
  taskId: string,
  stage: PipelineCheckpointStage,
): Promise<PipelineStageCheckpointRow | null> {
  const row = await one<Row>(
    `SELECT task_id, stage, status,
            length(output_text) AS output_text_length,
            substr(output_text, 1, ?) AS output_text_chunk,
            error_code, error_message,
            input_tokens, output_tokens, total_tokens, duration_ms,
            attempt_count, started_at, completed_at, updated_at
       FROM pipeline_stage_checkpoints
      WHERE task_id = ? AND stage = ?`,
    [CHECKPOINT_TEXT_CHUNK_CHARACTERS, taskId, stage],
  );
  if (!row) return null;
  const outputText = await readCheckpointOutputText(
    String(row.task_id),
    String(row.stage),
    String(row.output_text_chunk ?? ''),
    row.output_text_length == null
      ? null
      : Math.max(0, Number(row.output_text_length) || 0),
  );
  return mapRow({ ...row, output_text: outputText });
}

async function readCheckpointOutputText(
  taskId: string,
  stage: string,
  firstChunk: string,
  totalLength: number | null,
): Promise<string | null> {
  if (totalLength == null) return null;
  let outputText = firstChunk;
  for (
    let offset = CHECKPOINT_TEXT_CHUNK_CHARACTERS + 1;
    offset <= totalLength;
    offset += CHECKPOINT_TEXT_CHUNK_CHARACTERS
  ) {
    const next = await one<Row>(
      `SELECT substr(output_text, ?, ?) AS output_text_chunk
         FROM pipeline_stage_checkpoints
        WHERE task_id = ? AND stage = ?`,
      [offset, CHECKPOINT_TEXT_CHUNK_CHARACTERS, taskId, stage],
    );
    outputText += String(next?.output_text_chunk ?? '');
  }
  return outputText;
}

/**
 * Derived Final reader: metadata is projected explicitly and output_text is
 * fetched one column/chunk at a time, so a large upstream checkpoint never
 * shares a CursorWindow row with another large payload.
 */
export async function getStageCheckpointsForDerivedFinalRewrite(
  taskId: string,
): Promise<PipelineStageCheckpointRow[]> {
  const rows = await all<Row>(
    `SELECT task_id, stage, status,
            length(output_text) AS output_text_length,
            substr(output_text, 1, ?) AS output_text_chunk,
            error_code, error_message,
            input_tokens, output_tokens, total_tokens, duration_ms,
            attempt_count, started_at, completed_at, updated_at
       FROM pipeline_stage_checkpoints
      WHERE task_id = ?
      ORDER BY stage`,
    [CHECKPOINT_TEXT_CHUNK_CHARACTERS, taskId],
  );
  const mapped: PipelineStageCheckpointRow[] = [];
  for (const row of rows) {
    const outputText = await readCheckpointOutputText(
      String(row.task_id),
      String(row.stage),
      String(row.output_text_chunk ?? ''),
      row.output_text_length == null
        ? null
        : Math.max(0, Number(row.output_text_length) || 0),
    );
    mapped.push(mapRow({ ...row, output_text: outputText }));
  }
  return mapped;
}

/**
 * Task-list projection: checkpoint metadata only, never output_text. The
 * caller can render stage counts/status without loading generated reports.
 */
export async function getStageCheckpointSummariesForTasks(
  taskIds: string[],
): Promise<PipelineStageCheckpointSummary[]> {
  const ids = taskIds.map(String).filter(Boolean);
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = await all<Row>(
    `SELECT task_id, stage, status, error_code, error_message,
            input_tokens, output_tokens, total_tokens, duration_ms,
            attempt_count, started_at, completed_at, updated_at
       FROM pipeline_stage_checkpoints
      WHERE task_id IN (${placeholders})
      ORDER BY task_id, stage`,
    ids,
  );
  return rows.map(row => ({
    taskId: String(row.task_id),
    stage: row.stage as PipelineCheckpointStage,
    status: row.status as StageStatus,
    errorCode: row.error_code ?? null,
    errorMessage: row.error_message ?? null,
    inputTokens: row.input_tokens != null ? Number(row.input_tokens) : null,
    outputTokens: row.output_tokens != null ? Number(row.output_tokens) : null,
    totalTokens: row.total_tokens != null ? Number(row.total_tokens) : null,
    durationMs: row.duration_ms != null ? Number(row.duration_ms) : null,
    attemptCount: Number(row.attempt_count || 0),
    startedAt: row.started_at != null ? Number(row.started_at) : null,
    completedAt: row.completed_at != null ? Number(row.completed_at) : null,
    updatedAt: Number(row.updated_at || 0),
  }));
}

export async function ensurePendingCheckpoints(
  taskId: string,
  stages: PipelineCheckpointStage[],
): Promise<void> {
  const db = await openDatabase();
  const now = Date.now();
  for (const stage of stages) {
    await execute(
      db,
      `INSERT OR IGNORE INTO pipeline_stage_checkpoints (
         task_id, stage, status, attempt_count, updated_at
       ) VALUES (?, ?, 'pending', 0, ?)`,
      [taskId, stage, now],
    );
  }
}

/**
 * F2-07: whether any stage checkpoint of the task ever succeeded. Batch
 * resume uses this to decide between continuing the failed task from its
 * failed stage (reuses succeeded draft/review/factCheck output + frozen
 * request) vs a brand-new run that regenerates every stage.
 */
export async function hasSucceededStageCheckpoints(
  taskId: string,
): Promise<boolean> {
  const rows = await all<Row>(
    `SELECT stage FROM pipeline_stage_checkpoints
     WHERE task_id = ? AND status = 'succeeded'`,
    [taskId],
  );
  return rows.length > 0;
}

/**
 * V3.1 recovery: find the first failed/interrupted/running checkpoint and
 * reset it plus every downstream checkpoint. Successful checkpoints before
 * the failure remain immutable and are reused; downstream success cannot
 * survive a retry boundary because it may have consumed stale upstream data.
 * Attempt rows are intentionally retained for audit and cost accounting.
 */
export async function resetFailedStageCheckpointsForResume(
  taskId: string,
): Promise<void> {
  const rows = await all<Row>(
    `SELECT stage, status FROM pipeline_stage_checkpoints WHERE task_id = ?`,
    [taskId],
  );
  // Compact current topology is draft → qa → brief.  Keep the historical
  // parallel review/factCheck order in the same list so legacy rows retain
  // their sibling-preservation semantics.
  const order = ['draft', 'qa', 'review', 'factCheck', 'brief', 'proof', 'finalize'];
  const unknownStages = new Set<string>();
  await Promise.all(
    rows.map(async row => {
      const status = String(row.status || '');
      if (!['failed', 'interrupted', 'running'].includes(status)) return;
      const attempt = await getLatestStageAttempt(taskId, String(row.stage));
      if (
        attempt?.status === 'outcome_unknown' ||
        attempt?.failureClass === 'outcome_unknown' ||
        attempt?.status === 'started'
      ) {
        unknownStages.add(String(row.stage));
      }
    }),
  );
  if (unknownStages.size > 0) {
    const now = Date.now();
    await executeTransaction(
      await openDatabase(),
      Array.from(unknownStages).map(stage => ({
        sql: `UPDATE pipeline_stage_checkpoints
                 SET status = 'failed',
                     error_code = 'OUTCOME_UNKNOWN',
                     error_message = ?,
                     completed_at = ?,
                     updated_at = ?
               WHERE task_id = ? AND stage = ?
                 AND status NOT IN ('succeeded', 'skipped')`,
        params: [
          '请求结果未知；为避免重复收费，不自动重发。',
          now,
          now,
          taskId,
          stage,
        ],
      })),
    );
  }
  const firstFailure = rows.reduce((minimum, row) => {
    const status = String(row.status || '');
    const index = order.indexOf(String(row.stage));
    return index >= 0 && ['failed', 'interrupted', 'running'].includes(status)
      ? Math.min(minimum, index)
      : minimum;
  }, Number.POSITIVE_INFINITY);
  if (!Number.isFinite(firstFailure)) return;
  const now = Date.now();
  const statements = rows
    .filter(row => {
      const index = order.indexOf(String(row.stage));
      if (index < 0 || String(row.status) === 'pending') return false;

      // Review and FactCheck are parallel branches in full mode. A failure
      // on one branch must not invalidate the other branch's successful
      // checkpoint; Brief is the join and will wait for the failed branch to
      // be retried. If both branches failed, both are reset by the normal
      // downstream rule.
      const isSuccessfulParallelSibling =
        ((firstFailure === order.indexOf('review') && String(row.stage) === 'factCheck') ||
          (firstFailure === order.indexOf('factCheck') && String(row.stage) === 'review')) &&
        String(row.status) === 'succeeded';
      if (isSuccessfulParallelSibling) return false;
      // A request with an unknown outcome is an immutable manual-confirm
      // boundary. Never turn it back into pending merely because the user
      // opened the generic resume action.
      if (unknownStages.has(String(row.stage))) return false;
      return index >= firstFailure;
    })
    .map(row => ({
      sql: `UPDATE pipeline_stage_checkpoints
               SET status = 'pending', output_text = NULL,
                   error_code = NULL, error_message = NULL,
                   input_tokens = NULL, output_tokens = NULL,
                   total_tokens = NULL, duration_ms = NULL,
                   started_at = NULL, completed_at = NULL, updated_at = ?
             WHERE task_id = ? AND stage = ?`,
      params: [now, taskId, String(row.stage)],
    }));
  if (statements.length > 0) {
    await executeTransaction(await openDatabase(), statements);
  }
}

/**
 * Upsert a stage result. Must be awaited on the critical path.
 * Throws if write does not affect a row after insert/update.
 */
export async function upsertStageCheckpoint(params: {
  taskId: string;
  stage: PipelineCheckpointStage;
  status: StageStatus;
  outputText?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  durationMs?: number | null;
  startedAt?: number | null;
  completedAt?: number | null;
  bumpAttempt?: boolean;
}): Promise<void> {
  const db = await openDatabase();
  const now = Date.now();
  const completedAt =
    params.completedAt !== undefined
      ? params.completedAt
      : params.status === 'succeeded' ||
          params.status === 'failed' ||
          params.status === 'skipped'
        ? now
        : null;

  const result = await execute(
    db,
    `INSERT INTO pipeline_stage_checkpoints (
       task_id, stage, status, output_text, error_code, error_message,
       input_tokens, output_tokens, total_tokens, duration_ms,
       attempt_count, started_at, completed_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(task_id, stage) DO UPDATE SET
       status = excluded.status,
       output_text = excluded.output_text,
       error_code = excluded.error_code,
       error_message = excluded.error_message,
       input_tokens = excluded.input_tokens,
       output_tokens = excluded.output_tokens,
       total_tokens = excluded.total_tokens,
       duration_ms = excluded.duration_ms,
       attempt_count = CASE
         WHEN ? THEN pipeline_stage_checkpoints.attempt_count + 1
         ELSE pipeline_stage_checkpoints.attempt_count
       END,
       started_at = COALESCE(excluded.started_at, pipeline_stage_checkpoints.started_at),
       completed_at = excluded.completed_at,
       updated_at = excluded.updated_at`,
    [
      params.taskId,
      params.stage,
      params.status,
      params.outputText ?? null,
      params.errorCode ?? null,
      params.errorMessage ?? null,
      params.inputTokens ?? null,
      params.outputTokens ?? null,
      params.totalTokens ?? null,
      params.durationMs ?? null,
      params.bumpAttempt ? 1 : 0,
      params.startedAt ?? null,
      completedAt,
      now,
      params.bumpAttempt ? 1 : 0,
    ],
  );
  const rowsAffected = Number((result as any)?.rowsAffected ?? 0);
  if (rowsAffected < 1) {
    throw new Error(
      `阶段 checkpoint 写入失败：task=${params.taskId} stage=${params.stage}`,
    );
  }
}

/**
 * CAS claim: only pending|interrupted may become running.
 * Returns true when this caller owns execution.
 */
export async function claimStageCheckpoint(
  taskId: string,
  stage: PipelineCheckpointStage,
  bumpAttempt = true,
): Promise<boolean> {
  const db = await openDatabase();
  const now = Date.now();
  // Ensure row exists so CAS can target it.
  await execute(
    db,
    `INSERT OR IGNORE INTO pipeline_stage_checkpoints (
       task_id, stage, status, attempt_count, updated_at
     ) VALUES (?, ?, 'pending', 0, ?)`,
    [taskId, stage, now],
  );
  const result = await execute(
    db,
    `UPDATE pipeline_stage_checkpoints
     SET status = 'running',
         started_at = ?,
         attempt_count = attempt_count + ?,
         updated_at = ?,
         error_code = NULL,
         error_message = NULL
     WHERE task_id = ?
       AND stage = ?
       AND status IN ('pending', 'interrupted')`,
    [now, bumpAttempt ? 1 : 0, now, taskId, stage],
  );
  return Number((result as any)?.rowsAffected ?? 0) === 1;
}

/** Cold-start: any running stage → interrupted. */
export async function interruptRunningStagesForTask(
  taskId: string,
): Promise<number> {
  const db = await openDatabase();
  const now = Date.now();
  const result = await execute(
    db,
    `UPDATE pipeline_stage_checkpoints
     SET status = 'interrupted', updated_at = ?
     WHERE task_id = ? AND status = 'running'`,
    [now, taskId],
  );
  return Number((result as any)?.rowsAffected ?? 0);
}

export async function interruptAllRunningStages(): Promise<number> {
  const db = await openDatabase();
  const now = Date.now();
  const result = await execute(
    db,
    `UPDATE pipeline_stage_checkpoints
     SET status = 'interrupted', updated_at = ?
     WHERE status = 'running'`,
    [now],
  );
  return Number((result as any)?.rowsAffected ?? 0);
}

export async function deleteStageCheckpointsForTask(
  taskId: string,
): Promise<void> {
  const db = await openDatabase();
  await execute(
    db,
    `DELETE FROM pipeline_stage_checkpoints WHERE task_id = ?`,
    [taskId],
  );
}

/** Project checkpoints back to legacy stage_results array for UI/backup. */
export function checkpointsToStageResults(
  rows: PipelineStageCheckpointRow[],
): Array<{
  stage: string;
  text: string;
  status: 'success' | 'failed' | 'skipped';
  error?: string;
  errorCode?: string;
  tokens?: { input: number; output: number; total: number };
  durationMs: number;
}> {
  const order = ['draft', 'review', 'factCheck', 'brief', 'proof'];
  const sorted = [...rows].sort(
    (a, b) => order.indexOf(a.stage) - order.indexOf(b.stage),
  );
  return sorted
    .filter(r => r.stage !== 'finalize')
    .filter(
      r =>
        r.status === 'succeeded' ||
        r.status === 'failed' ||
        r.status === 'skipped',
    )
    .map(r => ({
      stage: r.stage,
      text: r.outputText || '',
      status:
        r.status === 'succeeded'
          ? ('success' as const)
          : r.status === 'skipped'
            ? ('skipped' as const)
            : ('failed' as const),
      error: r.errorMessage || undefined,
      errorCode: r.errorCode || undefined,
      tokens:
        r.inputTokens != null || r.outputTokens != null || r.totalTokens != null
          ? {
              input: r.inputTokens || 0,
              output: r.outputTokens || 0,
              total: r.totalTokens || 0,
            }
          : undefined,
      durationMs: r.durationMs || 0,
    }));
}
