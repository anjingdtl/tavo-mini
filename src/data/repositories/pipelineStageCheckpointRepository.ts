/**
 * Durable stage checkpoints for freeform/chapter pipelines.
 * PRIMARY KEY (task_id, stage) — one effective row per stage.
 */
import { execute } from '../connection/execute';
import { all, one } from '../connection/query';
import { openDatabase } from '../connection/openDatabase';
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

export async function getStageCheckpoints(
  taskId: string,
): Promise<PipelineStageCheckpointRow[]> {
  const rows = await all<Row>(
    `SELECT * FROM pipeline_stage_checkpoints WHERE task_id = ? ORDER BY stage`,
    [taskId],
  );
  return rows.map(mapRow);
}

export async function getStageCheckpoint(
  taskId: string,
  stage: PipelineCheckpointStage,
): Promise<PipelineStageCheckpointRow | null> {
  const row = await one<Row>(
    `SELECT * FROM pipeline_stage_checkpoints WHERE task_id = ? AND stage = ?`,
    [taskId, stage],
  );
  return row ? mapRow(row) : null;
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
         attempt_count = attempt_count + 1,
         updated_at = ?,
         error_code = NULL,
         error_message = NULL
     WHERE task_id = ?
       AND stage = ?
       AND status IN ('pending', 'interrupted')`,
    [now, now, taskId, stage],
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
  tokens?: { input: number; output: number; total: number };
  durationMs: number;
}> {
  const order = ['draft', 'review', 'factCheck', 'proof'];
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
