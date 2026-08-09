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
  reasoningTokens: number | null;
  finishReason: string | null;
  emptyReason: string | null;
  responseChannel: 'content' | 'reasoning' | 'both' | 'empty' | null;
  visibleOutputTokens: number | null;
  parseFailureCode: string | null;
  formatterUsed: boolean;
  reasoningContentTemp: string | null;
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
  formatterUsed?: boolean;
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
  reasoningTokens?: number | null;
  finishReason?: string | null;
  emptyReason?: string | null;
  responseChannel?: 'content' | 'reasoning' | 'both' | 'empty' | null;
  visibleOutputTokens?: number | null;
  parseFailureCode?: string | null;
  formatterUsed?: boolean;
  reasoningContentTemp?: string | null;
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
    reasoningTokens:
      row.reasoning_tokens != null ? Number(row.reasoning_tokens) : null,
    finishReason: row.finish_reason ?? null,
    emptyReason: row.empty_reason ?? null,
    responseChannel:
      row.response_channel === 'content' ||
      row.response_channel === 'reasoning' ||
      row.response_channel === 'both' ||
      row.response_channel === 'empty'
        ? row.response_channel
        : null,
    visibleOutputTokens:
      row.visible_output_tokens != null
        ? Number(row.visible_output_tokens)
        : null,
    parseFailureCode: row.parse_failure_code ?? null,
    formatterUsed: Boolean(Number(row.formatter_used ?? 0)),
    reasoningContentTemp: row.reasoning_content_temp ?? null,
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
       status, formatter_used, started_at, deadline_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'started', ?, ?, ?)`,
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
      input.formatterUsed ? 1 : 0,
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
    ['failure_class', input.failureClass],
    ['error_code', input.errorCode],
    ['error_message', input.errorMessage],
    ['http_status', input.httpStatus],
    ['retry_after_ms', input.retryAfterMs],
    ['provider_request_id', input.providerRequestId],
    ['next_retry_at', input.nextRetryAt],
    ['completed_at', input.completedAt],
    ['last_progress_at', input.lastProgressAt],
    ['input_tokens', input.inputTokens],
    ['output_tokens', input.outputTokens],
    ['total_tokens', input.totalTokens],
    ['reasoning_tokens', input.reasoningTokens],
  ];
  const diagnosticFields: Array<[string, unknown]> = [
    ['finish_reason', input.finishReason],
    ['empty_reason', input.emptyReason],
    ['response_channel', input.responseChannel],
    ['visible_output_tokens', input.visibleOutputTokens],
    ['parse_failure_code', input.parseFailureCode],
    [
      'formatter_used',
      input.formatterUsed == null ? undefined : input.formatterUsed ? 1 : 0,
    ],
    ['reasoning_content_temp', input.reasoningContentTemp],
  ];
  for (const [column, value] of [...fields, ...diagnosticFields]) {
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

/** Clear cold-start reasoning scratch data once a checkpoint is settled. */
export async function clearTemporaryReasoningForTaskStage(
  pipelineTaskId: string,
  stage: string,
): Promise<void> {
  await execute(
    await openDatabase(),
    `UPDATE pipeline_stage_attempts
        SET reasoning_content_temp = NULL
      WHERE pipeline_task_id = ? AND stage = ?`,
    [pipelineTaskId, stage],
  );
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

/** Latest attempt across all stages of a task (failure classification).
 *
 * BN-05: chronological ordering, NOT attempt_no DESC. attempt_no is only
 * unique WITHIN a (task_id, stage); ordering by it globally would pick
 * a retry from an earlier stage over the newest attempt of a later
 * stage (e.g. a successful draft attempt #2 would be picked over a
 * failing review attempt #1 if the later stage's attempt_no was lower).
 */
export async function getLatestAttemptByTask(
  pipelineTaskId: string,
): Promise<PipelineStageAttemptRow | null> {
  const row = await one(
    `SELECT * FROM pipeline_stage_attempts
     WHERE pipeline_task_id = ?
     ORDER BY COALESCE(completed_at, started_at) DESC,
              started_at DESC,
              id DESC
     LIMIT 1`,
    [pipelineTaskId],
  );
  return row ? mapRow(row) : null;
}

/**
 * All attempts of a task (audit source of truth for LLM usage: one row per
 * HTTP request, including failed / retried / outcome-unknown calls).
 */
export async function getTaskAttempts(
  pipelineTaskId: string,
): Promise<PipelineStageAttemptRow[]> {
  const rows = await all(
    `SELECT * FROM pipeline_stage_attempts
     WHERE pipeline_task_id = ?
     ORDER BY stage ASC, attempt_no ASC, started_at ASC`,
    [pipelineTaskId],
  );
  return rows.map(mapRow);
}
