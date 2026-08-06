/**
 * Pipeline stage attempt repository (Schema 41).
 *
 * One row per LLM call attempt per task+stage. Shared by single-chapter and
 * multi-chapter batch modes. All reads/writes fail-closed (DB errors
 * propagate to the caller — never swallowed into a silent no-op).
 */
import { execute } from '../connection/execute';
import { all, one } from '../connection/query';
import { openDatabase } from '../connection/openDatabase';

export type PipelineAttemptStatus =
  | 'started'
  | 'succeeded'
  | 'safe_to_retry'
  | 'outcome_unknown'
  | 'blocked'
  | 'failed'
  | 'cancelled';

export interface PipelineStageAttemptRow {
  id: string;
  pipelineTaskId: string;
  stage: string;
  attemptNo: number;
  requestVersion: number;
  requestFingerprint: string;
  allocationTraceJson: string | null;
  frozenRequestJson: string | null;
  llmConfigId: number | null;
  llmConfigSnapshotJson: string;
  clientRequestId: string;
  providerRequestId: string | null;
  status: PipelineAttemptStatus;
  failureClass: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  httpStatus: number | null;
  retryAfterMs: number | null;
  startedAt: number;
  lastProgressAt: number | null;
  deadlineAt: number | null;
  nextRetryAt: number | null;
  completedAt: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface CreateStageAttemptInput {
  id: string;
  pipelineTaskId: string;
  stage: string;
  attemptNo: number;
  requestVersion?: number;
  requestFingerprint: string;
  allocationTraceJson?: string | null;
  frozenRequestJson?: string | null;
  llmConfigId?: number | null;
  llmConfigSnapshotJson: string;
  clientRequestId: string;
  startedAt?: number;
  deadlineAt?: number | null;
}

export interface UpdateStageAttemptInput {
  id: string;
  status: PipelineAttemptStatus;
  failureClass?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  httpStatus?: number | null;
  retryAfterMs?: number | null;
  providerRequestId?: string | null;
  nextRetryAt?: number | null;
  completedAt?: number | null;
  lastProgressAt?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
}

function mapRow(row: any): PipelineStageAttemptRow {
  return {
    id: String(row.id),
    pipelineTaskId: String(row.pipeline_task_id),
    stage: String(row.stage),
    attemptNo: Number(row.attempt_no),
    requestVersion: Number(row.request_version ?? 1),
    requestFingerprint: String(row.request_fingerprint || ''),
    allocationTraceJson: row.allocation_trace_json ?? null,
    frozenRequestJson: row.frozen_request_json ?? null,
    llmConfigId: row.llm_config_id != null ? Number(row.llm_config_id) : null,
    llmConfigSnapshotJson: String(row.llm_config_snapshot_json || '{}'),
    clientRequestId: String(row.client_request_id || ''),
    providerRequestId: row.provider_request_id ?? null,
    status: row.status as PipelineAttemptStatus,
    failureClass: row.failure_class ?? null,
    errorCode: row.error_code ?? null,
    errorMessage: row.error_message ?? null,
    httpStatus: row.http_status != null ? Number(row.http_status) : null,
    retryAfterMs: row.retry_after_ms != null ? Number(row.retry_after_ms) : null,
    startedAt: Number(row.started_at),
    lastProgressAt: row.last_progress_at != null ? Number(row.last_progress_at) : null,
    deadlineAt: row.deadline_at != null ? Number(row.deadline_at) : null,
    nextRetryAt: row.next_retry_at != null ? Number(row.next_retry_at) : null,
    completedAt: row.completed_at != null ? Number(row.completed_at) : null,
    inputTokens: row.input_tokens != null ? Number(row.input_tokens) : null,
    outputTokens: row.output_tokens != null ? Number(row.output_tokens) : null,
    totalTokens: row.total_tokens != null ? Number(row.total_tokens) : null,
  };
}

export async function createStageAttempt(
  input: CreateStageAttemptInput,
): Promise<void> {
  const now = input.startedAt ?? Date.now();
  await execute(
    await openDatabase(),
    `INSERT INTO pipeline_stage_attempts (
       id, pipeline_task_id, stage, attempt_no, request_version,
       request_fingerprint, allocation_trace_json, frozen_request_json,
       llm_config_id, llm_config_snapshot_json, client_request_id,
       status, started_at, deadline_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'started', ?, ?)`,
    [
      input.id,
      input.pipelineTaskId,
      input.stage,
      input.attemptNo,
      input.requestVersion ?? 1,
      input.requestFingerprint,
      input.allocationTraceJson ?? null,
      input.frozenRequestJson ?? null,
      input.llmConfigId ?? null,
      input.llmConfigSnapshotJson,
      input.clientRequestId,
      now,
      input.deadlineAt ?? null,
    ],
  );
}

export async function updateStageAttempt(
  input: UpdateStageAttemptInput,
): Promise<void> {
  const sets: string[] = ['status = ?'];
  const params: unknown[] = [input.status];
  const fields: Array<[string, unknown]> = [
    ['failure_class', input.failureClass ?? null],
    ['error_code', input.errorCode ?? null],
    ['error_message', input.errorMessage ?? null],
    ['http_status', input.httpStatus ?? null],
    ['retry_after_ms', input.retryAfterMs ?? null],
    ['provider_request_id', input.providerRequestId ?? null],
    ['next_retry_at', input.nextRetryAt ?? null],
    ['completed_at', input.completedAt ?? null],
    ['last_progress_at', input.lastProgressAt ?? null],
    ['input_tokens', input.inputTokens ?? null],
    ['output_tokens', input.outputTokens ?? null],
    ['total_tokens', input.totalTokens ?? null],
  ];
  for (const [column, value] of fields) {
    if (value !== undefined) {
      sets.push(`${column} = ?`);
      params.push(value);
    }
  }
  params.push(input.id);
  await execute(
    await openDatabase(),
    `UPDATE pipeline_stage_attempts SET ${sets.join(', ')} WHERE id = ?`,
    params,
  );
}

export async function getStageAttempts(
  pipelineTaskId: string,
  stage: string,
): Promise<PipelineStageAttemptRow[]> {
  const rows = await all(
    `SELECT * FROM pipeline_stage_attempts
     WHERE pipeline_task_id = ? AND stage = ?
     ORDER BY attempt_no ASC`,
    [pipelineTaskId, stage],
  );
  return rows.map(mapRow);
}

export async function getLatestStageAttempt(
  pipelineTaskId: string,
  stage: string,
): Promise<PipelineStageAttemptRow | null> {
  const row = await one(
    `SELECT * FROM pipeline_stage_attempts
     WHERE pipeline_task_id = ? AND stage = ?
     ORDER BY attempt_no DESC LIMIT 1`,
    [pipelineTaskId, stage],
  );
  return row ? mapRow(row) : null;
}

export async function getStageAttempt(
  attemptId: string,
): Promise<PipelineStageAttemptRow | null> {
  const row = await one(
    'SELECT * FROM pipeline_stage_attempts WHERE id = ?',
    [attemptId],
  );
  return row ? mapRow(row) : null;
}

/** Attempts waiting on a persisted retry schedule whose time has come. */
export async function getRetryDueAttempts(
  now: number,
): Promise<PipelineStageAttemptRow[]> {
  const rows = await all(
    `SELECT * FROM pipeline_stage_attempts
     WHERE status IN ('safe_to_retry', 'outcome_unknown')
       AND next_retry_at IS NOT NULL AND next_retry_at <= ?
     ORDER BY next_retry_at ASC`,
    [now],
  );
  return rows.map(mapRow);
}

/** Latest attempt across all stages of a task (failure classification). */
export async function getLatestAttemptByTask(
  pipelineTaskId: string,
): Promise<PipelineStageAttemptRow | null> {
  const row = await one(
    `SELECT * FROM pipeline_stage_attempts
     WHERE pipeline_task_id = ?
     ORDER BY attempt_no DESC, started_at DESC LIMIT 1`,
    [pipelineTaskId],
  );
  return row ? mapRow(row) : null;
}
