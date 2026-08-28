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
import {
  executeTransaction,
  type SqlStatement,
} from '../../services/database/transaction';
import {
  CURRENT_CONTEXT_BUDGET_VERSION,
  CURRENT_OUTLINE_WORKFLOW_VERSION,
  CURRENT_PIPELINE_TOPOLOGY_VERSION,
  PHASE2_CONTEXT_BUDGET_VERSION,
  V3_HIERARCHICAL_CONTEXT_BUDGET_VERSION,
} from '../../services/pipeline/outlineWorkflowVersion';
import type {
  MultiChapterBatchStatus,
  MultiChapterBatchItemStatus,
  BatchItemCompletionQuality,
  MultiChapterWritingMode,
} from '../../types/multiChapterBatch';
import type { PipelineReasoningEffort } from '../../types/pipeline';
import type { PipelineCheckpointStage } from '../../services/pipeline/types';
import type { Row } from './shared';
import {
  cloneDefaultContextAutomationPolicyV3,
  hashContextAutomationPolicyV3,
  isContextAutomationPolicyV3,
  type ContextAutomationPolicyV3,
} from '../../services/contextAutomationPolicy';
import {
  buildEnsureProjectWritingStatsStatement,
  buildProjectWritingStatsDeltaStatement,
} from '../../services/projectWritingStats';

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
  /** Frozen V2 tier; NULL means a pre-Schema-46 historical batch. */
  reasoningEffort?: PipelineReasoningEffort | null;
  plannerOutputJson: string | null;
  plannerHash: string | null;
  plannerRequestJson: string | null;
  contextAutomationPolicyVersion?: 'context-automation-v3' | null;
  contextAutomationPolicyHash?: string | null;
  contextAutomationPolicySnapshot?: ContextAutomationPolicyV3 | null;
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
  /**
   * Frozen protocol versions (Schema 44+). 1 = Legacy; 2 = V2 workflow /
   * elastic budget. Frozen once at batch creation; every chapter task of
   * the batch copies these values instead of re-reading the app default.
   */
  outlineWorkflowVersion: number;
  contextBudgetVersion: number;
  /**
   * Frozen pipeline topology version (Schema 55+).
   * 1 = legacy_standard; 2 = compact_standard. Freeze ONCE at batch creation;
   * every chapter task of the batch inherits this value instead of re-reading
   * the app default. Pre-upgrade rows default to 1 (legacy).
   */
  pipelineTopologyVersion: number;
  /** Schema 53 writing mode; pre-53 rows read as 'outline'. */
  writingMode: MultiChapterWritingMode;
  /** Serialized ContinuationBatchAnchorV1 (continuation mode only). */
  continuationAnchorJson: string | null;
  /** Serialized ContinuationBatchExecutionPolicyV1 (continuation mode only). */
  continuationExecutionPolicyJson: string | null;
  /** Frozen One-Shot (极速) execution profile (Schema 54+); NULL = standard. */
  executionProfile?: 'standard' | 'one_shot' | null;
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
  /**
   * Schema 53 continuation-mode binding. Mutually exclusive with
   * activePipelineTaskId by construction: continuation items never write
   * pipeline task ids and vice versa (doc §6.2).
   */
  activeContinuationRunId: string | null;
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

/**
 * Batch headers are metadata-heavy but still carry planner prompts, source
 * text, and continuation policy JSON. Keep the normal list/read path below a
 * mobile CursorWindow limit; the materializer restores those fields with
 * bounded substr() reads only for a row the caller actually requested.
 */
const BATCH_PAYLOAD_CHUNK_CHARS = 128 * 1024;
const BATCH_METADATA_SELECT = `
  id, project_id, status, NULL AS source_prompt, chapter_count,
  target_words_per_chapter, pipeline_mode, reasoning_effort,
  NULL AS planner_output_json, planner_hash, NULL AS planner_request_json,
  planner_request_fingerprint, start_position, expected_tail_chapter_id,
  current_ordinal, completed_count, active_item_ordinal,
  max_llm_calls, max_input_tokens, max_output_tokens,
  used_llm_calls, used_input_tokens, used_output_tokens,
  outline_workflow_version, context_budget_version,
  pause_reason, error_code, error_message, lease_owner, lease_expires_at,
  row_version, created_at, updated_at, started_at, completed_at, cancelled_at`;
const BATCH_OPTIONAL_COLUMNS = [
  'pipeline_topology_version',
  'writing_mode',
  'continuation_anchor_json',
  'continuation_execution_policy_json',
  'execution_profile',
] as const;
const BATCH_ITEM_METADATA_SELECT = `
  batch_id, ordinal, title, NULL AS synopsis, NULL AS key_beats_json,
  NULL AS carry_in, NULL AS carry_out, target_words, status, chapter_id,
  active_pipeline_task_id, active_continuation_run_id, active_run_no,
  completion_quality, adoption_fingerprint, adopted_revision_id,
  retry_count, next_retry_at, error_code, error_message,
  created_at, updated_at, completed_at`;
const BATCH_ITEM_RUN_METADATA_SELECT = `
  batch_id, ordinal, run_no, pipeline_task_id,
  NULL AS llm_config_snapshot_json, reason, status, created_at, completed_at`;

type BatchPayloadTable =
  | 'multi_chapter_batches'
  | 'multi_chapter_batch_items'
  | 'multi_chapter_batch_item_runs';
type BatchPayloadColumn =
  | 'source_prompt'
  | 'planner_output_json'
  | 'planner_request_json'
  | 'continuation_anchor_json'
  | 'continuation_execution_policy_json'
  | 'synopsis'
  | 'key_beats_json'
  | 'carry_in'
  | 'carry_out'
  | 'llm_config_snapshot_json';

/**
 * The batch repository is also used by migration evidence immediately after
 * a partial schema upgrade (for example, Schema 53 before Schema 55). Keep
 * the hot-path projection narrow while making later additive columns
 * capability-detected instead of making a Schema-53 read fail on a missing
 * identifier.
 */
async function batchMetadataSelect(): Promise<string> {
  const db = await openDatabase();
  const [result] = await db.executeSql(
    'PRAGMA table_info(multi_chapter_batches)',
  );
  const columns = new Set<string>();
  for (let i = 0; i < result.rows.length; i += 1) {
    columns.add(String(result.rows.item(i).name));
  }
  const optional = BATCH_OPTIONAL_COLUMNS.map(column =>
    columns.has(column) ? column : `NULL AS ${column}`,
  );
  return `${BATCH_METADATA_SELECT}, ${optional.join(', ')}`;
}

async function readBatchPayload(input: {
  table: BatchPayloadTable;
  column: BatchPayloadColumn;
  whereSql: string;
  params: any[];
}): Promise<string | null> {
  const db = await openDatabase();
  const [lengthResult] = await db.executeSql(
    `SELECT length(${input.column}) AS payload_length
       FROM ${input.table}
      WHERE ${input.whereSql}`,
    input.params,
  );
  if (lengthResult.rows.length === 0) return null;
  const rawLength = lengthResult.rows.item(0).payload_length;
  if (rawLength == null) return null;
  const totalLength = Number(rawLength);
  if (!Number.isFinite(totalLength) || totalLength < 0) return null;
  if (totalLength === 0) return '';

  let payload = '';
  for (
    let offset = 1;
    offset <= totalLength;
    offset += BATCH_PAYLOAD_CHUNK_CHARS
  ) {
    const [chunkResult] = await db.executeSql(
      `SELECT substr(${input.column}, ?, ?) AS payload_chunk
         FROM ${input.table}
        WHERE ${input.whereSql}`,
      [offset, BATCH_PAYLOAD_CHUNK_CHARS, ...input.params],
    );
    if (chunkResult.rows.length === 0) break;
    payload += String(chunkResult.rows.item(0).payload_chunk ?? '');
  }
  return payload;
}

async function materializeBatchRow(row: Row): Promise<MultiChapterBatchRow> {
  const [
    sourcePrompt,
    plannerOutputJson,
    plannerRequestJson,
    anchorJson,
    policyJson,
  ] = await Promise.all([
    readBatchPayload({
      table: 'multi_chapter_batches',
      column: 'source_prompt',
      whereSql: 'id = ?',
      params: [row.id],
    }),
    readBatchPayload({
      table: 'multi_chapter_batches',
      column: 'planner_output_json',
      whereSql: 'id = ?',
      params: [row.id],
    }),
    readBatchPayload({
      table: 'multi_chapter_batches',
      column: 'planner_request_json',
      whereSql: 'id = ?',
      params: [row.id],
    }),
    readBatchPayload({
      table: 'multi_chapter_batches',
      column: 'continuation_anchor_json',
      whereSql: 'id = ?',
      params: [row.id],
    }),
    readBatchPayload({
      table: 'multi_chapter_batches',
      column: 'continuation_execution_policy_json',
      whereSql: 'id = ?',
      params: [row.id],
    }),
  ]);
  return mapBatchRow({
    ...row,
    source_prompt: sourcePrompt ?? '',
    planner_output_json: plannerOutputJson,
    planner_request_json: plannerRequestJson,
    continuation_anchor_json: anchorJson,
    continuation_execution_policy_json: policyJson,
  });
}

async function materializeBatchItemRow(
  row: Row,
): Promise<MultiChapterBatchItemRow> {
  const [synopsis, keyBeatsJson, carryIn, carryOut] = await Promise.all([
    readBatchPayload({
      table: 'multi_chapter_batch_items',
      column: 'synopsis',
      whereSql: 'batch_id = ? AND ordinal = ?',
      params: [row.batch_id, row.ordinal],
    }),
    readBatchPayload({
      table: 'multi_chapter_batch_items',
      column: 'key_beats_json',
      whereSql: 'batch_id = ? AND ordinal = ?',
      params: [row.batch_id, row.ordinal],
    }),
    readBatchPayload({
      table: 'multi_chapter_batch_items',
      column: 'carry_in',
      whereSql: 'batch_id = ? AND ordinal = ?',
      params: [row.batch_id, row.ordinal],
    }),
    readBatchPayload({
      table: 'multi_chapter_batch_items',
      column: 'carry_out',
      whereSql: 'batch_id = ? AND ordinal = ?',
      params: [row.batch_id, row.ordinal],
    }),
  ]);
  return mapBatchItemRow({
    ...row,
    synopsis: synopsis ?? '',
    key_beats_json: keyBeatsJson ?? '[]',
    carry_in: carryIn,
    carry_out: carryOut,
  });
}

async function materializeBatchItemRunRow(
  row: Row,
): Promise<MultiChapterBatchItemRunRow> {
  const snapshot = await readBatchPayload({
    table: 'multi_chapter_batch_item_runs',
    column: 'llm_config_snapshot_json',
    whereSql: 'batch_id = ? AND ordinal = ? AND run_no = ?',
    params: [row.batch_id, row.ordinal, row.run_no],
  });
  return mapRunRow({ ...row, llm_config_snapshot_json: snapshot ?? '{}' });
}

interface FrozenBatchPlannerEnvelope {
  schemaVersion: 1;
  requestJson: string | null;
  contextAutomationPolicyVersion: 'context-automation-v3';
  contextAutomationPolicyHash: string;
  contextAutomationPolicySnapshot: ContextAutomationPolicyV3;
}

function parseFrozenBatchPlannerEnvelope(
  raw: string | null | undefined,
): FrozenBatchPlannerEnvelope | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<FrozenBatchPlannerEnvelope>;
    if (
      parsed.schemaVersion !== 1 ||
      parsed.contextAutomationPolicyVersion !== 'context-automation-v3' ||
      typeof parsed.contextAutomationPolicyHash !== 'string' ||
      !isContextAutomationPolicyV3(parsed.contextAutomationPolicySnapshot)
    ) {
      return null;
    }
    return {
      schemaVersion: 1,
      requestJson:
        parsed.requestJson == null ? null : String(parsed.requestJson),
      contextAutomationPolicyVersion: 'context-automation-v3',
      contextAutomationPolicyHash: parsed.contextAutomationPolicyHash,
      contextAutomationPolicySnapshot: parsed.contextAutomationPolicySnapshot,
    };
  } catch {
    return null;
  }
}

function encodeFrozenBatchPlannerRequest(
  requestJson: string | null | undefined,
  policy: ContextAutomationPolicyV3,
): string {
  const snapshot = JSON.parse(
    JSON.stringify(policy),
  ) as ContextAutomationPolicyV3;
  const envelope: FrozenBatchPlannerEnvelope = {
    schemaVersion: 1,
    requestJson: requestJson ?? null,
    contextAutomationPolicyVersion: 'context-automation-v3',
    contextAutomationPolicyHash: hashContextAutomationPolicyV3(snapshot),
    contextAutomationPolicySnapshot: snapshot,
  };
  return JSON.stringify(envelope);
}

/** Preserve a batch's frozen policy while replacing its planner request. */
export function serializeBatchPlannerRequestJson(
  requestJson: string | null | undefined,
  policy?: ContextAutomationPolicyV3 | null,
): string | null {
  if (!policy || !isContextAutomationPolicyV3(policy)) {
    return requestJson ?? null;
  }
  return encodeFrozenBatchPlannerRequest(requestJson, policy);
}

export function getFrozenBatchContextAutomationPolicy(
  batch: Pick<MultiChapterBatchRow, 'contextAutomationPolicySnapshot'>,
): ContextAutomationPolicyV3 | null {
  return batch.contextAutomationPolicySnapshot
    ? (JSON.parse(
        JSON.stringify(batch.contextAutomationPolicySnapshot),
      ) as ContextAutomationPolicyV3)
    : null;
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function mapBatchRow(row: Row): MultiChapterBatchRow {
  const frozenPolicy = parseFrozenBatchPlannerEnvelope(
    row.planner_request_json ?? null,
  );
  return {
    id: String(row.id),
    projectId: Number(row.project_id),
    status: row.status as MultiChapterBatchStatus,
    sourcePrompt: String(row.source_prompt || ''),
    chapterCount: Number(row.chapter_count),
    targetWordsPerChapter: Number(row.target_words_per_chapter),
    pipelineMode: String(row.pipeline_mode || 'full'),
    reasoningEffort:
      row.reasoning_effort === 'low' ||
      row.reasoning_effort === 'medium' ||
      row.reasoning_effort === 'high' ||
      row.reasoning_effort === 'max'
        ? row.reasoning_effort
        : null,
    plannerOutputJson: row.planner_output_json ?? null,
    plannerHash: row.planner_hash ?? null,
    plannerRequestJson: frozenPolicy
      ? frozenPolicy.requestJson
      : row.planner_request_json ?? null,
    contextAutomationPolicyVersion:
      frozenPolicy?.contextAutomationPolicyVersion ?? null,
    contextAutomationPolicyHash:
      frozenPolicy?.contextAutomationPolicyHash ?? null,
    contextAutomationPolicySnapshot:
      frozenPolicy?.contextAutomationPolicySnapshot ?? null,
    plannerRequestFingerprint: row.planner_request_fingerprint ?? null,
    startPosition:
      row.start_position != null ? Number(row.start_position) : null,
    expectedTailChapterId:
      row.expected_tail_chapter_id != null
        ? Number(row.expected_tail_chapter_id)
        : null,
    currentOrdinal: Number(row.current_ordinal ?? 1),
    completedCount: Number(row.completed_count ?? 0),
    activeItemOrdinal:
      row.active_item_ordinal != null ? Number(row.active_item_ordinal) : null,
    maxLlmCalls: row.max_llm_calls != null ? Number(row.max_llm_calls) : null,
    maxInputTokens:
      row.max_input_tokens != null ? Number(row.max_input_tokens) : null,
    maxOutputTokens:
      row.max_output_tokens != null ? Number(row.max_output_tokens) : null,
    usedLlmCalls: Number(row.used_llm_calls ?? 0),
    usedInputTokens: Number(row.used_input_tokens ?? 0),
    usedOutputTokens: Number(row.used_output_tokens ?? 0),
    outlineWorkflowVersion: Number(row.outline_workflow_version ?? 1),
    contextBudgetVersion: Number(row.context_budget_version ?? 1),
    pipelineTopologyVersion: Number(row.pipeline_topology_version ?? 1),
    writingMode:
      row.writing_mode === 'continuation' ? 'continuation' : 'outline',
    continuationAnchorJson: row.continuation_anchor_json ?? null,
    continuationExecutionPolicyJson:
      row.continuation_execution_policy_json ?? null,
    executionProfile:
      row.execution_profile === 'one_shot' ? 'one_shot' : 'standard',
    pauseReason: row.pause_reason ?? null,
    errorCode: row.error_code ?? null,
    errorMessage: row.error_message ?? null,
    leaseOwner: row.lease_owner ?? null,
    leaseExpiresAt:
      row.lease_expires_at != null ? Number(row.lease_expires_at) : null,
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
    activeContinuationRunId: row.active_continuation_run_id ?? null,
    activeRunNo: Number(row.active_run_no ?? 0),
    completionQuality:
      row.completion_quality as BatchItemCompletionQuality | null,
    adoptionFingerprint: row.adoption_fingerprint ?? null,
    adoptedRevisionId:
      row.adopted_revision_id != null ? Number(row.adopted_revision_id) : null,
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
  /** New V3 batches pass the normalized product tier explicitly. */
  reasoningEffort?: PipelineReasoningEffort | null;
  budget?: {
    maxLlmCalls?: number | null;
    maxInputTokens?: number | null;
    maxOutputTokens?: number | null;
  };
  /**
   * Frozen protocol versions (Schema 44+). `createBatch` is the NEW-batch
   * creation entry point, so the default is the CURRENT protocol (2); the
   * DB column default (1) exists only for pre-upgrade rows. Legacy callers
   * may pass 1 explicitly.
   */
  outlineWorkflowVersion?: number;
  contextBudgetVersion?: number;
  /** Schema 55: frozen pipeline topology version; new batches default to the
   * current compact_standard (2) so every child task inherits it. */
  pipelineTopologyVersion?: number;
  /** Frozen V3 policy copied to every child task at first execution. */
  contextAutomationPolicyV3?: ContextAutomationPolicyV3 | null;
  /** Schema 53: continuation mode + frozen anchor/policy JSON. */
  writingMode?: MultiChapterWritingMode;
  continuationAnchorJson?: string | null;
  continuationExecutionPolicyJson?: string | null;
  /** Schema 54: frozen One-Shot (极速) execution profile for the batch. */
  executionProfile?: 'standard' | 'one_shot' | null;
  createdAt?: number;
}

export async function createBatch(input: CreateBatchInput): Promise<void> {
  const now = input.createdAt ?? Date.now();
  const contextBudgetVersion =
    input.contextBudgetVersion ?? CURRENT_CONTEXT_BUDGET_VERSION;
  const frozenPolicy =
    Number(contextBudgetVersion) === V3_HIERARCHICAL_CONTEXT_BUDGET_VERSION ||
    Number(contextBudgetVersion) === PHASE2_CONTEXT_BUDGET_VERSION
      ? input.contextAutomationPolicyV3 &&
        isContextAutomationPolicyV3(input.contextAutomationPolicyV3)
        ? input.contextAutomationPolicyV3
        : cloneDefaultContextAutomationPolicyV3()
      : null;
  await execute(
    await openDatabase(),
    `INSERT INTO multi_chapter_batches (
       id, project_id, status, source_prompt, chapter_count,
       target_words_per_chapter, pipeline_mode, reasoning_effort,
       max_llm_calls, max_input_tokens, max_output_tokens,
       outline_workflow_version, context_budget_version, pipeline_topology_version,
       writing_mode, continuation_anchor_json, continuation_execution_policy_json,
       execution_profile,
       planner_request_json,
       created_at, updated_at
     ) VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.projectId,
      input.sourcePrompt,
      input.chapterCount,
      input.targetWordsPerChapter,
      input.pipelineMode,
      input.reasoningEffort ?? null,
      input.budget?.maxLlmCalls ?? null,
      input.budget?.maxInputTokens ?? null,
      input.budget?.maxOutputTokens ?? null,
      input.outlineWorkflowVersion ?? CURRENT_OUTLINE_WORKFLOW_VERSION,
      contextBudgetVersion,
      input.pipelineTopologyVersion ?? CURRENT_PIPELINE_TOPOLOGY_VERSION,
      input.writingMode ?? 'outline',
      input.writingMode === 'continuation'
        ? input.continuationAnchorJson ?? null
        : null,
      input.writingMode === 'continuation'
        ? input.continuationExecutionPolicyJson ?? null
        : null,
      input.executionProfile === 'one_shot' ? 'one_shot' : 'standard',
      frozenPolicy ? encodeFrozenBatchPlannerRequest(null, frozenPolicy) : null,
      now,
      now,
    ],
  );
}

export async function getBatchById(
  batchId: string,
): Promise<MultiChapterBatchRow | null> {
  const select = await batchMetadataSelect();
  const row = await one(
    `SELECT ${select} FROM multi_chapter_batches WHERE id = ?`,
    [batchId],
  );
  return row ? materializeBatchRow(row) : null;
}

/** Latest non-terminal batch for a project (running/paused/ready/waiting). */
export async function getActiveBatchByProject(
  projectId: number,
): Promise<MultiChapterBatchRow | null> {
  const select = await batchMetadataSelect();
  const row = await one(
    `SELECT ${select} FROM multi_chapter_batches
     WHERE project_id = ? AND status NOT IN ('completed', 'cancelled', 'failed')
     ORDER BY updated_at DESC LIMIT 1`,
    [projectId],
  );
  return row ? materializeBatchRow(row) : null;
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
    continuationAnchorJson?: string | null;
    continuationExecutionPolicyJson?: string | null;
  },
): Promise<void> {
  const sets = ['status = ?', 'updated_at = ?'];
  const params: unknown[] = [status, Date.now()];
  if (fields) {
    let plannerRequestJsonOverride = fields.plannerRequestJson;
    if (plannerRequestJsonOverride !== undefined) {
      const current = await one<Row>(
        'SELECT planner_request_json FROM multi_chapter_batches WHERE id = ?',
        [batchId],
      );
      const frozenPolicy = parseFrozenBatchPlannerEnvelope(
        current?.planner_request_json ?? null,
      );
      if (frozenPolicy) {
        plannerRequestJsonOverride = encodeFrozenBatchPlannerRequest(
          plannerRequestJsonOverride,
          frozenPolicy.contextAutomationPolicySnapshot,
        );
      }
    }
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
      ['continuationAnchorJson', 'continuation_anchor_json'],
      ['continuationExecutionPolicyJson', 'continuation_execution_policy_json'],
    ];
    for (const [key, column] of map) {
      if (fields[key] !== undefined) {
        sets.push(`${column} = ?`);
        params.push(
          key === 'plannerRequestJson'
            ? plannerRequestJsonOverride
            : fields[key],
        );
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
 *   - running                                       → paused_user
 *   - paused_* (any flavour): clear the dead lease
 *     so the next 开始批量写作 CAS can succeed. Status
 *     is preserved — user intent is already captured
 *     in the persisted status.
 *   - ready with execution traces (an item already
 *     created a chapter / bound a task / moved off
 *     pending — the reconciler started, status only
 *     flips to running on the first adoption)      → paused_user
 *   - ready with zero execution (fresh confirmed
 *     plan)                                         → untouched
 *   - waiting_retry: KEEP THE STATUS. The persisted
 *     `next_retry_at` is the durable retry schedule;
 *     parking it to paused_user would force the user
 *     to click "确认后继续" to drive the retry, defeating
 *     the whole auto-retry path. Only the stale lease
 *     (dead owner) is cleared.
 */
export async function pauseInterruptedBatches(
  now = Date.now(),
): Promise<number> {
  // waiting_retry: clear dead lease, keep status.
  const waiting = await execute(
    await openDatabase(),
    `UPDATE multi_chapter_batches
     SET lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = ?
     WHERE status = 'waiting_retry'
       AND lease_owner IS NOT NULL`,
    [now],
  );
  // paused_*: clear the lease unconditionally — paused status already
  // implies the previous executor has stopped, so any remaining lease is
  // stale by definition. Preserves the user-visible status.
  const pausedLeaseClear = await execute(
    await openDatabase(),
    `UPDATE multi_chapter_batches
     SET lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = ?
     WHERE status LIKE 'paused_%'
       AND lease_owner IS NOT NULL`,
    [now],
  );
  // running + ready-with-traces → paused_user (the legacy RB-5 path).
  const paused = await execute(
    await openDatabase(),
    `UPDATE multi_chapter_batches
     SET status = 'paused_user',
         pause_reason = 'interrupted',
         error_code = 'BATCH_INTERRUPTED',
         error_message = '应用中断，请确认后继续',
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = ?
     WHERE status = 'running'
        OR (status = 'ready' AND EXISTS (
              SELECT 1 FROM multi_chapter_batch_items
              WHERE batch_id = multi_chapter_batches.id
                AND (status <> 'pending'
                     OR chapter_id IS NOT NULL
                     OR active_pipeline_task_id IS NOT NULL)
            ))`,
    [now],
  );
  return (
    (waiting.rowsAffected ?? 0) +
    (pausedLeaseClear.rowsAffected ?? 0) +
    (paused.rowsAffected ?? 0)
  );
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

export async function createBatchItem(
  input: CreateBatchItemInput,
): Promise<void> {
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
    `SELECT ${BATCH_ITEM_METADATA_SELECT}
       FROM multi_chapter_batch_items WHERE batch_id = ? ORDER BY ordinal ASC`,
    [batchId],
  );
  return Promise.all(rows.map(materializeBatchItemRow));
}

export async function getBatchItem(
  batchId: string,
  ordinal: number,
): Promise<MultiChapterBatchItemRow | null> {
  const row = await one(
    `SELECT ${BATCH_ITEM_METADATA_SELECT}
       FROM multi_chapter_batch_items WHERE batch_id = ? AND ordinal = ?`,
    [batchId, ordinal],
  );
  return row ? materializeBatchItemRow(row) : null;
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
    activeContinuationRunId: string | null;
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
    activeContinuationRunId: 'active_continuation_run_id',
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
    `UPDATE multi_chapter_batch_items SET ${sets.join(
      ', ',
    )} WHERE batch_id = ? AND ordinal = ?`,
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
    `SELECT ${BATCH_ITEM_RUN_METADATA_SELECT}
       FROM multi_chapter_batch_item_runs
     WHERE batch_id = ? AND ordinal = ? ORDER BY run_no ASC`,
    [batchId, ordinal],
  );
  return Promise.all(rows.map(materializeBatchItemRunRow));
}

/**
 * Every pipeline_task_id ever bound to any item in this batch (append-only
 * audit; one row per bind). Used by {@link setBatchUsageFromRuns} to compute
 * the authoritative batch usage: cross-task, cross-run, crash-safe.
 */
export async function getBatchTaskIds(batchId: string): Promise<string[]> {
  const rows = await all(
    `SELECT DISTINCT pipeline_task_id FROM multi_chapter_batch_item_runs
     WHERE batch_id = ? AND pipeline_task_id IS NOT NULL`,
    [batchId],
  );
  return rows.map(r => String(r.pipeline_task_id));
}

interface AttemptUsageLike {
  status?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

/**
 * Aggregate a list of stage attempts into billable usage:
 *   - succeeded: bill input + output tokens
 *   - safe_to_retry / outcome_unknown / failed / blocked: bill input tokens
 *     (model billed for the request, even though output may be missing) and
 *     count the call (no output tokens to bill)
 *   - cancelled: 0 (caller never confirmed — provider typically does not bill)
 *
 * Centralised so the cross-task aggregator and the per-task counter return
 * the same shape. Defensive against undefined / null tokens.
 */
export function summarizeAttemptsUsage(attempts: AttemptUsageLike[]): {
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
} {
  let llmCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const attempt of attempts) {
    llmCalls += 1;
    const status = String(attempt.status ?? '');
    const inTok = Number(attempt.inputTokens ?? 0) || 0;
    const outTok = Number(attempt.outputTokens ?? 0) || 0;
    if (status === 'succeeded') {
      inputTokens += inTok;
      outputTokens += outTok;
    } else if (status === 'cancelled') {
      // Cancelled before the model was called → no billable usage.
      llmCalls -= 1;
    } else {
      // safe_to_retry / outcome_unknown / failed / blocked: provider charged
      // for the request even when output is unusable.
      inputTokens += inTok;
    }
  }
  return { llmCalls, inputTokens, outputTokens };
}

/**
 * Recompute the batch usage from the durable `item_runs.pipeline_task_id`
 * history (every LLM call ever made on behalf of this batch, including
 * abandoned runs after user resume). SET (not increment) — repeated reconcile
 * is idempotent and crash-safe.
 */
export async function setBatchUsageFromRuns(batchId: string): Promise<{
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
}> {
  const taskIds = await getBatchTaskIds(batchId);
  if (taskIds.length === 0) {
    // No runs yet → leave usage at zero.
    await execute(
      await openDatabase(),
      `UPDATE multi_chapter_batches
       SET used_llm_calls = 0, used_input_tokens = 0, used_output_tokens = 0, updated_at = ?
       WHERE id = ?`,
      [Date.now(), batchId],
    );
    return { llmCalls: 0, inputTokens: 0, outputTokens: 0 };
  }
  const placeholders = taskIds.map(() => '?').join(',');
  const rows = await all(
    `SELECT status, input_tokens, output_tokens
     FROM pipeline_stage_attempts
     WHERE pipeline_task_id IN (${placeholders})`,
    taskIds,
  );
  const usage = summarizeAttemptsUsage(
    rows.map(r => ({
      status: r.status,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
    })),
  );
  await execute(
    await openDatabase(),
    `UPDATE multi_chapter_batches
     SET used_llm_calls = ?, used_input_tokens = ?, used_output_tokens = ?, updated_at = ?
     WHERE id = ?`,
    [
      usage.llmCalls,
      usage.inputTokens,
      usage.outputTokens,
      Date.now(),
      batchId,
    ],
  );
  return usage;
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
    buildEnsureProjectWritingStatsStatement(input.projectId, timestamp),
    buildProjectWritingStatsDeltaStatement(input.projectId, 1, 0, timestamp),
    {
      sql: 'UPDATE projects SET updated_at = ? WHERE id = ?',
      params: [timestamp, input.projectId],
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
    /** Frozen batch versions (§4.4): every child task copies the batch. */
    outlineWorkflowVersion?: number | null;
    contextBudgetVersion?: number | null;
    /** Schema 55: child task inherits the batch's frozen topology. */
    pipelineTopologyVersion?: number | null;
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
              outline_workflow_version, context_budget_version, pipeline_topology_version,
              created_at, updated_at, resolved_at
            ) VALUES (?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, NULL)`,
      params: [
        params.task.id,
        params.task.targetType,
        params.task.targetId,
        params.task.status,
        params.task.finalText,
        params.task.error,
        params.task.outlineWorkflowVersion ?? 1,
        params.task.contextBudgetVersion ?? 1,
        params.task.pipelineTopologyVersion ?? 1,
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
 * is a no-op (repeated reconcile must not advance counters twice). A
 * fingerprint mismatch (standalone path, enforceFingerprintMatch=true) fails
 * closed with BATCH_ADOPTION_MISMATCH.
 */
export async function commitBatchItemAdoption(params: {
  batchId: string;
  ordinal: number;
  chapterCount: number;
  completionQuality: BatchItemCompletionQuality;
  adoptionFingerprint: string;
  adoptedRevisionId: number | null;
  options?: {
    /**
     * Continuation-mode first commit writes the fingerprint in the same
     * UPDATE (the atomic outline path does the same via folded statements):
     * the batch lease guarantees a single writer, so matching a fingerprint
     * that does not exist yet in the WHERE clause would always fail.
     */
    enforceFingerprintMatch?: boolean;
  };
}): Promise<void> {
  const statements = await buildCommitBatchItemAdoptionStatements(params, {
    enforceFingerprintMatch: params.options?.enforceFingerprintMatch ?? true,
  });
  if (statements.length === 0) return; // idempotent no-op
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

/**
 * CL-07: statement-builder variant so the batch reconciler can fold the item
 * + counter commit INTO the same transaction as the body/revisions writes
 * (one atomic adoption closed loop — no half-committed adoption windows).
 * Returns [] when the item is already committed with the same fingerprint.
 *
 * enforceFingerprintMatch: the standalone path matches the WHERE clause on the
 * persisted fingerprint (concurrent-writer guard). The atomic path passes
 * false — the fingerprint is WRITTEN by the same UPDATE, so matching it in the
 * WHERE would always fail; idempotency + single-writer safety are guaranteed
 * by the caller's pre-check and the batch lease.
 *
 * useLastInsertRowId (F2-01): the atomic adoption path cannot know the
 * pipeline revision id when the statement batch is built (it only exists at
 * execution time, after the INSERT runs). When enabled, the item UPDATE reads
 * last_insert_rowid() directly — in the atomic batch the previous statement is
 * always the pipeline-revision INSERT, so the value written is exactly that
 * revision's id. The standalone path keeps the parameterized form.
 */
export async function buildCommitBatchItemAdoptionStatements(
  params: {
    batchId: string;
    ordinal: number;
    chapterCount: number;
    completionQuality: BatchItemCompletionQuality;
    adoptionFingerprint: string;
    adoptedRevisionId: number | null;
  },
  options?: {
    enforceFingerprintMatch?: boolean;
    useLastInsertRowId?: boolean;
  },
): Promise<SqlStatement[]> {
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
    return [];
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
  const enforceFingerprintMatch = options?.enforceFingerprintMatch ?? false;
  const useLastInsertRowId = options?.useLastInsertRowId ?? false;
  const revisionColumn = useLastInsertRowId
    ? 'adopted_revision_id = last_insert_rowid()'
    : 'adopted_revision_id = ?';
  return [
    {
      // CL-07: the atomic adoption folds the fingerprint WRITE into this same
      // UPDATE (enforceFingerprintMatch=false). The standalone path keeps the
      // WHERE fingerprint guard (concurrent-writer protection).
      sql: `UPDATE multi_chapter_batch_items
            SET status = ?, completion_quality = ?, adoption_fingerprint = ?,
                error_code = NULL, error_message = NULL, next_retry_at = NULL,
                ${revisionColumn}, completed_at = ?, updated_at = ?
            WHERE batch_id = ? AND ordinal = ?${
              enforceFingerprintMatch ? ' AND adoption_fingerprint = ?' : ''
            }`,
      params: useLastInsertRowId
        ? [
            itemStatus,
            params.completionQuality,
            params.adoptionFingerprint,
            now,
            now,
            params.batchId,
            params.ordinal,
          ]
        : enforceFingerprintMatch
        ? [
            itemStatus,
            params.completionQuality,
            params.adoptionFingerprint,
            params.adoptedRevisionId,
            now,
            now,
            params.batchId,
            params.ordinal,
            params.adoptionFingerprint,
          ]
        : [
            itemStatus,
            params.completionQuality,
            params.adoptionFingerprint,
            params.adoptedRevisionId,
            now,
            now,
            params.batchId,
            params.ordinal,
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
}

/**
 * 4. Continuation-mode run binding (Schema 53). CAS-style UPDATE with both
 * namespace guards: the item must not already carry a continuation run AND
 * must never carry a pipeline task id (doc §6.2 — the two execution systems
 * keep disjoint identifier namespaces). Returns false when the row was
 * already bound (concurrent writer / crash recovery re-entry) — the caller
 * re-reads and follows the existing binding instead of starting a new run.
 */
export async function bindContinuationRunForItem(params: {
  batchId: string;
  ordinal: number;
  chapterId: number;
  continuationRunId: string;
  status?: MultiChapterBatchItemStatus;
}): Promise<boolean> {
  const now = Date.now();
  const result = await execute(
    await openDatabase(),
    `UPDATE multi_chapter_batch_items
     SET active_continuation_run_id = ?,
         status = ?,
         updated_at = ?
     WHERE batch_id = ? AND ordinal = ? AND chapter_id = ?
       AND active_continuation_run_id IS NULL
       AND active_pipeline_task_id IS NULL`,
    [
      params.continuationRunId,
      params.status ?? 'running_pipeline',
      now,
      params.batchId,
      params.ordinal,
      params.chapterId,
    ],
  );
  return (result.rowsAffected ?? 0) > 0;
}
