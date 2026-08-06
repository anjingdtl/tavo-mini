/**
 * Multi-chapter batch repository (Schema 42).
 *
 * Fail-closed: every DB error propagates — a silent no-op would corrupt the
 * batch state machine. Atomic transactions cover:
 *   1. chapter INSERT + item binding   (no orphan chapters / items)
 *   2. pipeline task + checkpoints + item run + item binding (no orphan tasks)
 *   3. adoption commit + batch counters (progress only after durable content)
 */
import { execute } from '../connection/execute';
import { all, one } from '../connection/query';
import { openDatabase } from '../connection/openDatabase';
import { executeTransaction, type SqlStatement } from '../../services/database/transaction';
import type {
  MultiChapterBatchStatus,
  MultiChapterBatchItemStatus,
  BatchItemCompletionQuality,
} from '../../types/multiChapterBatch';
import type { PipelineCheckpointStage } from '../../services/pipeline/types';
import type { Row } from './shared';

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface MultiChapterBatchRow {
  id: string;
  projectId: number;
  status: MultiChapterBatchStatus;
  sourcePrompt: string;
  chapterCount: number;
  targetWordsPerChapter: number;
  pipelineMode: string;
  plannerOutputJson: string | null;
  plannerHash: string | null;
  plannerRequestJson: string | null;
  plannerRequestFingerprint: string | null;
  startPosition: number | null;
  expectedTailChapterId: number | null;
  currentOrdinal: number;
  completedCount: number;
  activeItemOrdinal: number | null;
  maxLlmCalls: number | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  usedLlmCalls: number;
  usedInputTokens: number;
  usedOutputTokens: number;
  pauseReason: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  rowVersion: number;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  cancelledAt: number | null;
}

export interface MultiChapterBatchItemRow {
  batchId: string;
  ordinal: number;
  title: string;
  synopsis: string;
  keyBeatsJson: string;
  carryIn: string | null;
  carryOut: string | null;
  targetWords: number;
  status: MultiChapterBatchItemStatus;
  chapterId: number | null;
  activePipelineTaskId: string | null;
  activeRunNo: number;
  completionQuality: BatchItemCompletionQuality | null;
  adoptionFingerprint: string | null;
  adoptedRevisionId: number | null;
  retryCount: number;
  nextRetryAt: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface MultiChapterBatchItemRunRow {
  batchId: string;
  ordinal: number;
  runNo: number;
  pipelineTaskId: string;
  llmConfigSnapshotJson: string;
  reason: string;
  status: string;
  createdAt: number;
  completedAt: number | null;
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function mapBatchRow(row: Row): MultiChapterBatchRow {
  return {
    id: String(row.id),
    projectId: Number(row.project_id),
    status: row.status as MultiChapterBatchStatus,
    sourcePrompt: String(row.source_prompt || ''),
    chapterCount: Number(row.chapter_count),
    targetWordsPerChapter: Number(row.target_words_per_chapter),
    pipelineMode: String(row.pipeline_mode || 'full'),
    plannerOutputJson: row.planner_output_json ?? null,
    plannerHash: row.planner_hash ?? null,
    plannerRequestJson: row.planner_request_json ?? null,
    plannerRequestFingerprint: row.planner_request_fingerprint ?? null,
    startPosition: row.start_position != null ? Number(row.start_position) : null,
    expectedTailChapterId:
      row.expected_tail_chapter_id != null ? Number(row.expected_tail_chapter_id) : null,
    currentOrdinal: Number(row.current_ordinal ?? 1),
    completedCount: Number(row.completed_count ?? 0),
    activeItemOrdinal:
      row.active_item_ordinal != null ? Number(row.active_item_ordinal) : null,
    maxLlmCalls: row.max_llm_calls != null ? Number(row.max_llm_calls) : null,
    maxInputTokens: row.max_input_tokens != null ? Number(row.max_input_tokens) : null,
    maxOutputTokens: row.max_output_tokens != null ? Number(row.max_output_tokens) : null,
    usedLlmCalls: Number(row.used_llm_calls ?? 0),
    usedInputTokens: Number(row.used_input_tokens ?? 0),
    usedOutputTokens: Number(row.used_output_tokens ?? 0),
    pauseReason: row.pause_reason ?? null,
    errorCode: row.error_code ?? null,
    errorMessage: row.error_message ?? null,
    leaseOwner: row.lease_owner ?? null,
    leaseExpiresAt: row.lease_expires_at != null ? Number(row.lease_expires_at) : null,
    rowVersion: Number(row.row_version ?? 0),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    startedAt: row.started_at != null ? Number(row.started_at) : null,
    completedAt: row.completed_at != null ? Number(row.completed_at) : null,
    cancelledAt: row.cancelled_at != null ? Number(row.cancelled_at) : null,
  };
}

function mapBatchItemRow(row: Row): MultiChapterBatchItemRow {
  return {
    batchId: String(row.batch_id),
    ordinal: Number(row.ordinal),
    title: String(row.title || ''),
    synopsis: String(row.synopsis || ''),
    keyBeatsJson: String(row.key_beats_json || '[]'),
    carryIn: row.carry_in ?? null,
    carryOut: row.carry_out ?? null,
    targetWords: Number(row.target_words ?? 0),
    status: row.status as MultiChapterBatchItemStatus,
    chapterId: row.chapter_id != null ? Number(row.chapter_id) : null,
    activePipelineTaskId: row.active_pipeline_task_id ?? null,
    activeRunNo: Number(row.active_run_no ?? 0),
    completionQuality: row.completion_quality as BatchItemCompletionQuality | null,
    adoptionFingerprint: row.adoption_fingerprint ?? null,
    adoptedRevisionId: row.adopted_revision_id != null ? Number(row.adopted_revision_id) : null,
    retryCount: Number(row.retry_count ?? 0),
    nextRetryAt: row.next_retry_at != null ? Number(row.next_retry_at) : null,
    errorCode: row.error_code ?? null,
    errorMessage: row.error_message ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    completedAt: row.completed_at != null ? Number(row.completed_at) : null,
  };
}

function mapRunRow(row: Row): MultiChapterBatchItemRunRow {
  return {
    batchId: String(row.batch_id),
    ordinal: Number(row.ordinal),
    runNo: Number(row.run_no),
    pipelineTaskId: String(row.pipeline_task_id),
    llmConfigSnapshotJson: String(row.llm_config_snapshot_json || '{}'),
    reason: String(row.reason || ''),
    status: String(row.status || ''),
    createdAt: Number(row.created_at),
    completedAt: row.completed_at != null ? Number(row.completed_at) : null,
  };
}

// ---------------------------------------------------------------------------
// Batch header
// ---------------------------------------------------------------------------

export interface CreateBatchInput {
  id: string;
  projectId: number;
  sourcePrompt: string;
  chapterCount: number;
  targetWordsPerChapter: number;
  pipelineMode: string;
  budget?: {
    maxLlmCalls?: number | null;
    maxInputTokens?: number | null;
    maxOutputTokens?: number | null;
  };
  createdAt?: number;
}

export async function createBatch(input: CreateBatchInput): Promise<void> {
  const now = input.createdAt ?? Date.now();
  await execute(
    await openDatabase(),
    `INSERT INTO multi_chapter_batches (
       id, project_id, status, source_prompt, chapter_count,
       target_words_per_chapter, pipeline_mode,
       max_llm_calls, max_input_tokens, max_output_tokens,
       created_at, updated_at
     ) VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.projectId,
      input.sourcePrompt,
      input.chapterCount,
      input.targetWordsPerChapter,
      input.pipelineMode,
      input.budget?.maxLlmCalls ?? null,
      input.budget?.maxInputTokens ?? null,
      input.budget?.maxOutputTokens ?? null,
      now,
      now,
    ],
  );
}

export async function getBatchById(
  batchId: string,
): Promise<MultiChapterBatchRow | null> {
  const row = await one('SELECT * FROM multi_chapter_batches WHERE id = ?', [
    batchId,
  ]);
  return row ? mapBatchRow(row) : null;
}

/** Latest non-terminal batch for a project (running/paused/ready/waiting). */
export async function getActiveBatchByProject(
  projectId: number,
): Promise<MultiChapterBatchRow | null> {
  const row = await one(
    `SELECT * FROM multi_chapter_batches
     WHERE project_id = ? AND status NOT IN ('completed', 'cancelled', 'failed')
     ORDER BY updated_at DESC LIMIT 1`,
    [projectId],
  );
  return row ? mapBatchRow(row) : null;
}

export async function updateBatchStatus(
  batchId: string,
  status: MultiChapterBatchStatus,
  fields?: {
    pauseReason?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    startedAt?: number | null;
    completedAt?: number | null;
    cancelledAt?: number | null;
    plannerOutputJson?: string | null;
    plannerHash?: string | null;
    plannerRequestJson?: string | null;
    plannerRequestFingerprint?: string | null;
    startPosition?: number | null;
    expectedTailChapterId?: number | null;
  },
): Promise<void> {
  const sets = ['status = ?', 'updated_at = ?'];
  const params: unknown[] = [status, Date.now()];
  if (fields) {
    const map: Array<[keyof typeof fields, string]> = [
      ['pauseReason', 'pause_reason'],
      ['errorCode', 'error_code'],
      ['errorMessage', 'error_message'],
      ['startedAt', 'started_at'],
      ['completedAt', 'completed_at'],
      ['cancelledAt', 'cancelled_at'],
      ['plannerOutputJson', 'planner_output_json'],
      ['plannerHash', 'planner_hash'],
      ['plannerRequestJson', 'planner_request_json'],
      ['plannerRequestFingerprint', 'planner_request_fingerprint'],
      ['startPosition', 'start_position'],
      ['expectedTailChapterId', 'expected_tail_chapter_id'],
    ];
    for (const [key, column] of map) {
      if (fields[key] !== undefined) {
        sets.push(`${column} = ?`);
        params.push(fields[key]);
      }
    }
  }
  params.push(batchId);
  await execute(
    await openDatabase(),
    `UPDATE multi_chapter_batches SET ${sets.join(', ')} WHERE id = ?`,
    params,
  );
}

/**
 * Lease CAS claim. Only succeeds when the row is not leased by another owner
 * and the optimistic row_version still matches. Bumps row_version on success.
 */
export async function claimBatchLease(
  batchId: string,
  owner: string,
  leaseMs: number,
  expectedRowVersion: number,
): Promise<boolean> {
  const now = Date.now();
  const result = await execute(
    await openDatabase(),
    `UPDATE multi_chapter_batches
     SET lease_owner = ?, lease_expires_at = ?, row_version = row_version + 1, updated_at = ?
     WHERE id = ?
       AND row_version = ?
       AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at < ? OR lease_owner = ?)`,
    [owner, now + leaseMs, now, batchId, expectedRowVersion, now, owner],
  );
  return (result.rowsAffected ?? 0) > 0;
}

export async function releaseBatchLease(
  batchId: string,
  owner: string,
): Promise<boolean> {
  const result = await execute(
    await openDatabase(),
    `UPDATE multi_chapter_batches
     SET lease_owner = NULL, lease_expires_at = NULL, row_version = row_version + 1, updated_at = ?
     WHERE id = ? AND lease_owner = ?`,
    [Date.now(), batchId, owner],
  );
  return (result.rowsAffected ?? 0) > 0;
}

export async function incrementBatchUsage(
  batchId: string,
  usage: { llmCalls?: number; inputTokens?: number; outputTokens?: number },
): Promise<void> {
  await execute(
    await openDatabase(),
    `UPDATE multi_chapter_batches
     SET used_llm_calls = used_llm_calls + ?,
         used_input_tokens = used_input_tokens + ?,
         used_output_tokens = used_output_tokens + ?,
         updated_at = ?
     WHERE id = ?`,
    [
      usage.llmCalls ?? 0,
      usage.inputTokens ?? 0,
      usage.outputTokens ?? 0,
      Date.now(),
      batchId,
    ],
  );
}

/**
 * Set (or clear) the batch spend caps. The UI no longer exposes these — the
 * planner auto-allocates a loose ceiling from the model window (elastic
 * budget still governs each single-chapter request).
 */
export async function updateBatchBudget(
  batchId: string,
  budget: {
    maxLlmCalls?: number | null;
    maxInputTokens?: number | null;
    maxOutputTokens?: number | null;
  },
): Promise<void> {
  const sets: string[] = ['updated_at = ?'];
  const params: unknown[] = [Date.now()];
  const map: Array<[keyof typeof budget, string]> = [
    ['maxLlmCalls', 'max_llm_calls'],
    ['maxInputTokens', 'max_input_tokens'],
    ['maxOutputTokens', 'max_output_tokens'],
  ];
  for (const [key, column] of map) {
    if (budget[key] !== undefined) {
      sets.push(`${column} = ?`);
      params.push(budget[key]);
    }
  }
  params.push(batchId);
  await execute(
    await openDatabase(),
    `UPDATE multi_chapter_batches SET ${sets.join(', ')} WHERE id = ?`,
    params,
  );
}

/**
 * Cold-start normalization (RB-5): any batch left in an active state by a
 * killed process has NO live executor — it must be parked into a recoverable
 * pause instead of lying as `running`/`ready` with nobody driving it.
 *
 * Cold start runs exactly once at process boot, so ANY lease still present
 * belongs to the dead process: it is cleared unconditionally (a live lease
 * would otherwise make the next 开始批量写作 fail with BATCH_LEASE_CONFLICT
 * — the 线程被占用 user report).
 *
 * Covered states:
 *   - running / waiting_retry                     → paused_user
 *   - ready with execution traces (an item already
 *     created a chapter / bound a task / moved off
 *     pending — the reconciler started, status only
 *     flips to running on the first adoption)      → paused_user
 *   - ready with zero execution (fresh confirmed
 *     plan)                                        → untouched
 */
export async function pauseInterruptedBatches(
  now = Date.now(),
): Promise<number> {
  const result = await execute(
    await openDatabase(),
    `UPDATE multi_chapter_batches
     SET status = 'paused_user',
         pause_reason = 'interrupted',
         error_code = 'BATCH_INTERRUPTED',
         error_message = '应用中断，请确认后继续',
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = ?
     WHERE status IN ('running', 'waiting_retry')
        OR (status = 'ready' AND EXISTS (
              SELECT 1 FROM multi_chapter_batch_items
              WHERE batch_id = multi_chapter_batches.id
                AND (status <> 'pending'
                     OR chapter_id IS NOT NULL
                     OR active_pipeline_task_id IS NOT NULL)
            ))`,
    [now],
  );
  return result.rowsAffected ?? 0;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export interface CreateBatchItemInput {
  batchId: string;
  ordinal: number;
  title: string;
  synopsis: string;
  keyBeatsJson: string;
  carryIn?: string | null;
  carryOut?: string | null;
  targetWords: number;
  createdAt?: number;
}

export async function createBatchItem(input: CreateBatchItemInput): Promise<void> {
  const now = input.createdAt ?? Date.now();
  await execute(
    await openDatabase(),
    `INSERT INTO multi_chapter_batch_items (
       batch_id, ordinal, title, synopsis, key_beats_json,
       carry_in, carry_out, target_words, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [
      input.batchId,
      input.ordinal,
      input.title,
      input.synopsis,
      input.keyBeatsJson,
      input.carryIn ?? null,
      input.carryOut ?? null,
      input.targetWords,
      now,
      now,
    ],
  );
}

export async function getBatchItems(
  batchId: string,
): Promise<MultiChapterBatchItemRow[]> {
  const rows = await all(
    'SELECT * FROM multi_chapter_batch_items WHERE batch_id = ? ORDER BY ordinal ASC',
    [batchId],
  );
  return rows.map(mapBatchItemRow);
}

export async function getBatchItem(
  batchId: string,
  ordinal: number,
): Promise<MultiChapterBatchItemRow | null> {
  const row = await one(
    'SELECT * FROM multi_chapter_batch_items WHERE batch_id = ? AND ordinal = ?',
    [batchId, ordinal],
  );
  return row ? mapBatchItemRow(row) : null;
}

export async function updateBatchItem(
  batchId: string,
  ordinal: number,
  fields: Partial<{
    status: MultiChapterBatchItemStatus;
    title: string;
    synopsis: string;
    keyBeatsJson: string;
    carryIn: string | null;
    carryOut: string | null;
    targetWords: number;
    chapterId: number | null;
    activePipelineTaskId: string | null;
    activeRunNo: number;
    completionQuality: BatchItemCompletionQuality | null;
    adoptionFingerprint: string | null;
    adoptedRevisionId: number | null;
    retryCount: number;
    nextRetryAt: number | null;
    errorCode: string | null;
    errorMessage: string | null;
    completedAt: number | null;
  }>,
): Promise<void> {
  const columnMap: Record<string, string> = {
    status: 'status',
    title: 'title',
    synopsis: 'synopsis',
    keyBeatsJson: 'key_beats_json',
    carryIn: 'carry_in',
    carryOut: 'carry_out',
    targetWords: 'target_words',
    chapterId: 'chapter_id',
    activePipelineTaskId: 'active_pipeline_task_id',
    activeRunNo: 'active_run_no',
    completionQuality: 'completion_quality',
    adoptionFingerprint: 'adoption_fingerprint',
    adoptedRevisionId: 'adopted_revision_id',
    retryCount: 'retry_count',
    nextRetryAt: 'next_retry_at',
    errorCode: 'error_code',
    errorMessage: 'error_message',
    completedAt: 'completed_at',
  };
  const sets = ['updated_at = ?'];
  const params: unknown[] = [Date.now()];
  for (const [key, value] of Object.entries(fields)) {
    const column = columnMap[key];
    if (!column) continue;
    sets.push(`${column} = ?`);
    params.push(value);
  }
  params.push(batchId, ordinal);
  await execute(
    await openDatabase(),
    `UPDATE multi_chapter_batch_items SET ${sets.join(', ')} WHERE batch_id = ? AND ordinal = ?`,
    params,
  );
}

// ---------------------------------------------------------------------------
// Item runs
// ---------------------------------------------------------------------------

export interface CreateItemRunInput {
  batchId: string;
  ordinal: number;
  runNo: number;
  pipelineTaskId: string;
  llmConfigSnapshotJson: string;
  reason: string;
  createdAt?: number;
}

export async function createItemRun(input: CreateItemRunInput): Promise<void> {
  const now = input.createdAt ?? Date.now();
  await execute(
    await openDatabase(),
    `INSERT INTO multi_chapter_batch_item_runs (
       batch_id, ordinal, run_no, pipeline_task_id,
       llm_config_snapshot_json, reason, status, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
    [
      input.batchId,
      input.ordinal,
      input.runNo,
      input.pipelineTaskId,
      input.llmConfigSnapshotJson,
      input.reason,
      now,
    ],
  );
}

export async function getItemRuns(
  batchId: string,
  ordinal: number,
): Promise<MultiChapterBatchItemRunRow[]> {
  const rows = await all(
    `SELECT * FROM multi_chapter_batch_item_runs
     WHERE batch_id = ? AND ordinal = ? ORDER BY run_no ASC`,
    [batchId, ordinal],
  );
  return rows.map(mapRunRow);
}

// ---------------------------------------------------------------------------
// Atomic transactions
// ---------------------------------------------------------------------------

/**
 * 1. Create the chapter for an item and bind it in ONE transaction.
 * Precondition (checked + enforced): item.chapter_id IS NULL.
 * Returns the new chapter id. Any failure rolls back → no orphan chapter.
 */
export async function createBatchChapterForItem(
  batchId: string,
  ordinal: number,
  input: {
    projectId: number;
    position: number;
    title: string;
    synopsis: string;
    /** Optional structured metadata (batch instruction etc.). */
    summaryJson?: string | null;
  },
): Promise<number> {
  const now = Date.now();
  const timestamp = new Date(now).toISOString();
  let chapterId: number | null = null;
  const statements: SqlStatement[] = [
    {
      sql: `INSERT INTO chapters (project_id, position, title, synopsis, content, status, summary_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, '', 'planned', ?, ?, ?)`,
      params: [
        input.projectId,
        input.position,
        input.title,
        input.synopsis,
        input.summaryJson ?? null,
        timestamp,
        timestamp,
      ],
    },
    {
      // last_insert_rowid() resolves the chapter id inside the same
      // transaction — the statement list is fixed before execution.
      sql: `UPDATE multi_chapter_batch_items
            SET chapter_id = (SELECT last_insert_rowid()),
                status = 'chapter_ready', updated_at = ?
            WHERE batch_id = ? AND ordinal = ? AND chapter_id IS NULL`,
      params: [now, batchId, ordinal],
    },
  ];
  await executeTransaction(await openDatabase(), statements, {
    onStatementComplete: (index, rowsAffected, insertId) => {
      if (index === 1) {
        if (!insertId || rowsAffected <= 0) {
          throw new Error('BATCH_CHAPTER_CREATE_FAILED');
        }
        chapterId = insertId;
      }
      if (index === 2 && rowsAffected <= 0) {
        // Item was already bound (concurrent writer) — roll back the INSERT.
        throw new Error('BATCH_CHAPTER_BIND_CONFLICT');
      }
    },
  });
  if (chapterId == null) {
    throw new Error('BATCH_CHAPTER_CREATE_FAILED');
  }
  return chapterId;
}

/**
 * 2. Atomically create the pipeline task + 4 checkpoints + the item run row,
 * then bind it to the item. Any failure rolls back → no orphan task.
 */
export async function createPipelineTaskForBatchItem(params: {
  batchId: string;
  ordinal: number;
  chapterId: number;
  task: {
    id: string;
    targetType: string;
    targetId: number;
    status: string;
    stageResults: any[];
    finalText: string | null;
    error: string | null;
    createdAt: number;
    updatedAt: number;
    resolvedAt: number | null;
  };
  stages: PipelineCheckpointStage[];
  runNo: number;
  llmConfigSnapshotJson: string;
  reason: string;
}): Promise<void> {
  const now = Date.now();
  const statements: SqlStatement[] = [
    {
      sql: `INSERT INTO pipeline_tasks (
              id, target_type, target_id, status, stage_results, final_text, error,
              created_at, updated_at, resolved_at
            ) VALUES (?, ?, ?, ?, '[]', ?, ?, ?, ?, NULL)`,
      params: [
        params.task.id,
        params.task.targetType,
        params.task.targetId,
        params.task.status,
        params.task.finalText,
        params.task.error,
        params.task.createdAt,
        params.task.updatedAt,
      ],
    },
  ];
  for (const stage of params.stages) {
    statements.push({
      sql: `INSERT INTO pipeline_stage_checkpoints (task_id, stage, status, attempt_count, updated_at)
            VALUES (?, ?, 'pending', 0, ?)`,
      params: [params.task.id, stage, now],
    });
  }
  statements.push({
    sql: `INSERT INTO multi_chapter_batch_item_runs (
            batch_id, ordinal, run_no, pipeline_task_id,
            llm_config_snapshot_json, reason, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
    params: [
      params.batchId,
      params.ordinal,
      params.runNo,
      params.task.id,
      params.llmConfigSnapshotJson,
      params.reason,
      now,
    ],
  });
  statements.push({
    sql: `UPDATE multi_chapter_batch_items
          SET active_pipeline_task_id = ?, active_run_no = ?,
              status = 'running_pipeline', updated_at = ?
          WHERE batch_id = ? AND ordinal = ? AND chapter_id = ? AND active_pipeline_task_id IS NULL`,
    params: [
      params.task.id,
      params.runNo,
      now,
      params.batchId,
      params.ordinal,
      params.chapterId,
    ],
  });
  await executeTransaction(await openDatabase(), statements, {
    onStatementComplete: (index, rowsAffected) => {
      const lastIndex = statements.length;
      if (index === lastIndex && rowsAffected <= 0) {
        throw new Error('BATCH_PIPELINE_TASK_CREATE_FAILED');
      }
    },
  });
}

/**
 * 3. Commit an adopted item and advance the batch counters in ONE transaction.
 * Idempotency: an item already in a succeeded* state with the SAME fingerprint
 * is a no-op (repeated reconcile must not advance counters twice). Any other
 * mismatch fails closed.
 */
export async function commitBatchItemAdoption(params: {
  batchId: string;
  ordinal: number;
  chapterCount: number;
  completionQuality: BatchItemCompletionQuality;
  adoptionFingerprint: string;
  adoptedRevisionId: number | null;
}): Promise<void> {
  const item = await getBatchItem(params.batchId, params.ordinal);
  if (!item) {
    throw new Error('BATCH_ITEM_NOT_FOUND');
  }
  if (
    (item.status === 'succeeded' ||
      item.status === 'succeeded_with_draft' ||
      item.status === 'succeeded_with_user_text') &&
    item.adoptionFingerprint === params.adoptionFingerprint
  ) {
    // Already committed — idempotent no-op.
    return;
  }
  const now = Date.now();
  const nextOrdinal = params.ordinal + 1;
  const finished = nextOrdinal > params.chapterCount;
  const itemStatus =
    params.completionQuality === 'full_pipeline'
      ? 'succeeded'
      : params.completionQuality === 'draft_only'
        ? 'succeeded_with_draft'
        : 'succeeded_with_user_text';
  const statements: SqlStatement[] = [
    {
      sql: `UPDATE multi_chapter_batch_items
            SET status = ?, completion_quality = ?, adoption_fingerprint = ?,
                adopted_revision_id = ?, completed_at = ?, updated_at = ?
            WHERE batch_id = ? AND ordinal = ? AND adoption_fingerprint = ?`,
      params: [
        itemStatus,
        params.completionQuality,
        params.adoptionFingerprint,
        params.adoptedRevisionId,
        now,
        now,
        params.batchId,
        params.ordinal,
        params.adoptionFingerprint,
      ],
    },
    {
      sql: `UPDATE multi_chapter_batches
            SET completed_count = completed_count + 1,
                current_ordinal = ?,
                active_item_ordinal = ?,
                status = ?,
                updated_at = ?,
                completed_at = ?
            WHERE id = ?`,
      params: [
        finished ? params.chapterCount : nextOrdinal,
        finished ? null : nextOrdinal,
        finished ? 'completed' : 'running',
        now,
        finished ? now : null,
        params.batchId,
      ],
    },
  ];
  await executeTransaction(await openDatabase(), statements, {
    onStatementComplete: (index, rowsAffected) => {
      if (index === 1 && rowsAffected <= 0) {
        throw new Error('BATCH_ADOPTION_MISMATCH');
      }
      if (index === 2 && rowsAffected <= 0) {
        throw new Error('BATCH_NOT_FOUND');
      }
    },
  });
}
