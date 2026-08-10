import { all, one } from '../connection/query';
import { execute } from '../connection/execute';
import { openDatabase } from '../connection/openDatabase';

export type StoryMemoryRequestAttemptStatus =
  | 'prepared'
  | 'sent'
  | 'succeeded'
  | 'failed'
  | 'outcome_unknown'
  | 'cancelled';

export interface StoryMemoryRequestAttemptRow {
  attemptId: string;
  logicalBatchId: string;
  projectId: number;
  fromPosition: number;
  throughPosition: number;
  requestKind: string;
  attemptNo: number;
  status: StoryMemoryRequestAttemptStatus;
  failureClass: string | null;
  errorCode: string | null;
  httpStatus: number | null;
  providerRequestId: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface CreateStoryMemoryRequestAttemptInput {
  attemptId: string;
  logicalBatchId: string;
  projectId: number;
  fromPosition: number;
  throughPosition: number;
  requestKind: string;
  attemptNo: number;
  status?: StoryMemoryRequestAttemptStatus;
  startedAt?: number;
}

export interface CompleteStoryMemoryRequestAttemptInput {
  attemptId: string;
  status: Exclude<StoryMemoryRequestAttemptStatus, 'prepared' | 'sent'>;
  failureClass?: string | null;
  errorCode?: string | null;
  httpStatus?: number | null;
  providerRequestId?: string | null;
  finishedAt?: number;
}

function mapRow(row: any): StoryMemoryRequestAttemptRow {
  return {
    attemptId: String(row.attempt_id),
    logicalBatchId: String(row.logical_batch_id),
    projectId: Number(row.project_id),
    fromPosition: Number(row.from_position),
    throughPosition: Number(row.through_position),
    requestKind: String(row.request_kind || ''),
    attemptNo: Number(row.attempt_no),
    status: row.status as StoryMemoryRequestAttemptStatus,
    failureClass: row.failure_class ?? null,
    errorCode: row.error_code ?? null,
    httpStatus: row.http_status != null ? Number(row.http_status) : null,
    providerRequestId: row.provider_request_id ?? null,
    startedAt: Number(row.started_at),
    finishedAt: row.finished_at != null ? Number(row.finished_at) : null,
  };
}

export async function createStoryMemoryRequestAttempt(
  input: CreateStoryMemoryRequestAttemptInput,
): Promise<void> {
  await execute(
    await openDatabase(),
    `INSERT INTO story_memory_request_attempts (
       attempt_id, logical_batch_id, project_id, from_position,
       through_position, request_kind, attempt_no, status, started_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.attemptId,
      input.logicalBatchId,
      input.projectId,
      input.fromPosition,
      input.throughPosition,
      input.requestKind,
      input.attemptNo,
      input.status || 'sent',
      input.startedAt ?? Date.now(),
    ],
  );
}

export async function completeStoryMemoryRequestAttempt(
  input: CompleteStoryMemoryRequestAttemptInput,
): Promise<void> {
  await execute(
    await openDatabase(),
    `UPDATE story_memory_request_attempts SET
       status = ?, failure_class = ?, error_code = ?, http_status = ?,
       provider_request_id = ?, finished_at = ?
     WHERE attempt_id = ?`,
    [
      input.status,
      input.failureClass ?? null,
      input.errorCode ?? null,
      input.httpStatus ?? null,
      input.providerRequestId ?? null,
      input.finishedAt ?? Date.now(),
      input.attemptId,
    ],
  );
}

export async function getStoryMemoryRequestAttempt(
  attemptId: string,
): Promise<StoryMemoryRequestAttemptRow | null> {
  const row = await one(
    'SELECT * FROM story_memory_request_attempts WHERE attempt_id = ?',
    [attemptId],
  );
  return row ? mapRow(row) : null;
}

export async function listStoryMemoryRequestAttempts(
  projectId: number,
  statuses?: StoryMemoryRequestAttemptStatus[],
): Promise<StoryMemoryRequestAttemptRow[]> {
  const params: unknown[] = [projectId];
  const statusClause =
    statuses && statuses.length > 0
      ? ` AND status IN (${statuses.map(() => '?').join(', ')})`
      : '';
  if (statuses && statuses.length > 0) params.push(...statuses);
  const rows = await all(
    `SELECT * FROM story_memory_request_attempts
     WHERE project_id = ?${statusClause}
     ORDER BY started_at ASC, attempt_no ASC`,
    params,
  );
  return rows.map(mapRow);
}

/**
 * A process can die after the pre-fetch `sent` write and before the response
 * update. Such rows are never safe to replay automatically. This operation is
 * intentionally idempotent and is called once during cold-start recovery.
 */
export async function markSentStoryMemoryAttemptsOutcomeUnknown(
  projectId?: number,
): Promise<number> {
  const database = await openDatabase();
  // A Schema 49 process can race the first post-upgrade cold-start cleanup
  // while the Schema 50 DDL is still being observed by another SQLite
  // connection. The absence of this table means there are no durable attempts
  // to classify yet; skip the update without surfacing a raw SQL error.
  const table = await execute(
    database,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    ['story_memory_request_attempts'],
  );
  if (table.rows.length === 0) return 0;

  const params: unknown[] = [];
  const projectClause = projectId == null ? '' : ' AND project_id = ?';
  if (projectId != null) params.push(projectId);
  const result = await execute(
    database,
    `UPDATE story_memory_request_attempts SET
       status = 'outcome_unknown',
       failure_class = 'outcome_unknown',
       error_code = 'COLD_START_SENT_WITHOUT_RESULT',
       finished_at = ?
     WHERE status IN ('prepared', 'sent')${projectClause}`,
    [Date.now(), ...params],
  );
  return Number((result as any)?.rowsAffected ?? 0);
}
