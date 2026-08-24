import type { PipelineConfig } from '../../types/pipeline';
import {
  DEFAULT_PIPELINE_REASONING_EFFORT,
  isPipelineReasoningTier,
  normalizePipelineReasoningTier,
} from '../../services/pipeline/reasoningPolicy';
import {
  deriveGenerationQualityProfile,
  isGenerationQualityProfile,
  mapGenerationQualityProfile,
  type GenerationQualityProfile,
} from '../../services/writing/contracts/generationQualityProfile';
import { execute } from '../connection/execute';
import { all, one } from '../connection/query';
import { openDatabase } from '../connection/openDatabase';
import {
  executeTransaction,
  type SqlStatement,
} from '../../services/database/transaction';
import { setSetting } from './settingsRepository';
import { resolveActiveWriterStyle } from '../../services/writerStyle/activeStyleResolver';
import type { Row } from './shared';
import type { PipelineCheckpointStage } from '../../services/pipeline/types';
import {
  checkpointsToStageResults,
  getStageCheckpointsForDerivedFinalRewrite,
  getStageCheckpointSummariesForTasks,
  type PipelineStageCheckpointRow,
  type PipelineStageCheckpointSummary,
} from './pipelineStageCheckpointRepository';

export async function getPipelineConfig(options?: {
  projectId?: number;
  /**
   * Read the frozen-era mode only for direct historical V2 state-machine
   * verification. Product/UI callers must keep seeing the unified full
   * pipeline; public Resume paths reject unfinished legacy tasks before this
   * compatibility read can be used.
   */
  includeHistoricalMode?: boolean;
}): Promise<PipelineConfig> {
  // 11.9 优化：原实现每个字段独立 getSetting（最多 9 次独立 SQL），合并为单次 SELECT
  const keys = [
    'pipeline_mode',
    'pipeline_reasoning_effort',
    'pipeline_execution_profile',
    'pipeline_generation_quality_profile',
    'pipeline_reasoning_profile_version',
    'pipeline_brief_visible_output_floor',
    'pipeline_brief_reasoning_headroom',
    'pipeline_draft_preset_id',
    'pipeline_review_preset_id',
    'pipeline_factcheck_preset_id',
    'pipeline_proof_preset_id',
    'pipeline_draft_max_tokens',
    'pipeline_review_max_tokens',
    'pipeline_factcheck_max_tokens',
    'pipeline_proof_max_tokens',
  ];
  const rows = await all<{ key: string; value: string }>(
    `SELECT key, value FROM settings WHERE key IN (${keys
      .map(() => '?')
      .join(', ')})`,
    keys,
  );
  const settingsMap = new Map(rows.map(r => [r.key, r.value]));
  const get = (k: string): string | null => settingsMap.get(k) ?? null;

  const savedReasoningEffort = get('pipeline_reasoning_effort');
  const savedProfileVersion = get('pipeline_reasoning_profile_version');
  // Generation modes are historical settings only. New settings expose one
  // complete pipeline; frozen old task snapshots still retain their mode.
  // The opt-in read exists solely for direct V2 state-machine audit paths;
  // normal product callers always receive full.
  const savedPipelineMode = get('pipeline_mode');
  const pipelineMode =
    options?.includeHistoricalMode &&
    (savedPipelineMode === 'noReview' ||
      savedPipelineMode === 'twoStage' ||
      savedPipelineMode === 'conditional' ||
      savedPipelineMode === 'full')
      ? (savedPipelineMode as PipelineConfig['pipelineMode'])
      : ('full' as const);

  const presetId = (k: string): number | null => {
    const v = get(k);
    return v !== null ? Number(v) : null;
  };
  let activeWriterStyleId: number | null = null;
  if (options?.projectId != null) {
    activeWriterStyleId = (
      await resolveActiveWriterStyle(options.projectId)
    ).activeStyleId;
  }

  const isV3Profile = ['2', '3', '4', '5'].includes(
    String(savedProfileVersion),
  );
  const normalizedTier =
    isV3Profile && isPipelineReasoningTier(savedReasoningEffort)
      ? savedReasoningEffort
      : normalizePipelineReasoningTier(savedReasoningEffort);
  // Settings migration is intentionally a single transaction so a crash
  // cannot leave the tier and profile version at different interpretations.
  if (savedProfileVersion !== '5' || savedReasoningEffort !== normalizedTier) {
    const database = await openDatabase();
    await executeTransaction(database, [
      {
        sql: 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
        params: ['pipeline_reasoning_effort', normalizedTier],
      },
      {
        sql: 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
        params: ['pipeline_reasoning_profile_version', '5'],
      },
    ]);
  }
  return {
    pipelineMode,
    reasoningEffort: isPipelineReasoningTier(normalizedTier)
      ? normalizedTier
      : DEFAULT_PIPELINE_REASONING_EFFORT,
    executionProfile:
      get('pipeline_execution_profile') === 'one_shot'
        ? ('one_shot' as const)
        : ('standard' as const),
    generationQualityProfile: deriveGenerationQualityProfile({
      qualityProfile: get('pipeline_generation_quality_profile'),
      executionProfile: get('pipeline_execution_profile'),
      reasoningEffort: isPipelineReasoningTier(normalizedTier)
        ? normalizedTier
        : DEFAULT_PIPELINE_REASONING_EFFORT,
    }),
    reasoningProfileVersion: 5,
    activeWriterStyleId,
    draftPresetId: presetId('pipeline_draft_preset_id'),
    reviewPresetId: presetId('pipeline_review_preset_id'),
    factCheckPresetId: presetId('pipeline_factcheck_preset_id'),
    proofPresetId: presetId('pipeline_proof_preset_id'),
    draftMaxTokens: Number(get('pipeline_draft_max_tokens') || 4000),
    reviewMaxTokens: Number(get('pipeline_review_max_tokens') || 1500),
    factCheckMaxTokens: Number(get('pipeline_factcheck_max_tokens') || 1500),
    proofMaxTokens: Number(get('pipeline_proof_max_tokens') || 4000),
    briefVisibleOutputFloor: Number(
      get('pipeline_brief_visible_output_floor') || 1200,
    ),
    briefReasoningHeadroom: Number(
      get('pipeline_brief_reasoning_headroom') || 1200,
    ),
  };
}

/**
 * Read the global One-Shot (极速) execution profile setting. Shared by the
 * Outline pipeline and the Continuation scenario preparation: one user-facing
 * tier switch governs both scenarios. Pre-Freeze read only — after Freeze the
 * frozen stagePolicy values are the sole authority.
 */
export async function getStoredWritingExecutionProfile(): Promise<
  'standard' | 'one_shot'
> {
  const rows = await all<{ key: string; value: string }>(
    "SELECT key, value FROM settings WHERE key = 'pipeline_execution_profile'",
  );
  return rows[0]?.value === 'one_shot' ? 'one_shot' : 'standard';
}

export async function getStoredGenerationQualityProfile(): Promise<GenerationQualityProfile> {
  const rows = await all<{ key: string; value: string }>(
    `SELECT key, value FROM settings WHERE key IN (?, ?, ?)`,
    [
      'pipeline_generation_quality_profile',
      'pipeline_execution_profile',
      'pipeline_reasoning_effort',
    ],
  );
  const settingsMap = new Map(rows.map(row => [row.key, row.value]));
  return deriveGenerationQualityProfile({
    qualityProfile: settingsMap.get('pipeline_generation_quality_profile'),
    executionProfile: settingsMap.get('pipeline_execution_profile'),
    reasoningEffort: settingsMap.get('pipeline_reasoning_effort'),
  });
}

export async function setPipelineConfig(  config: PipelineConfig,
  projectId?: number,
): Promise<void> {
  await setSetting('pipeline_mode', 'full');
  if (projectId != null) {
    await resolveActiveWriterStyle(projectId, config.activeWriterStyleId);
    await execute(
      await openDatabase(),
      'UPDATE projects SET active_writer_style_id = ?, updated_at = ? WHERE id = ?',
      [config.activeWriterStyleId, new Date().toISOString(), projectId],
    );
  }
  const explicitQuality = isGenerationQualityProfile(
    config.generationQualityProfile,
  )
    ? config.generationQualityProfile
    : null;
  const mapped = explicitQuality
    ? mapGenerationQualityProfile(explicitQuality)
    : null;
  const tier = mapped
    ? mapped.reasoningEffort
    : isPipelineReasoningTier(config.reasoningEffort)
    ? config.reasoningEffort
    : normalizePipelineReasoningTier(config.reasoningEffort);
  const executionProfile = mapped
    ? mapped.executionProfile
    : config.executionProfile === 'one_shot'
    ? 'one_shot'
    : 'standard';
  const qualityProfile =
    explicitQuality ||
    deriveGenerationQualityProfile({
      executionProfile,
      reasoningEffort: tier,
    });
  const database = await openDatabase();
  await executeTransaction(database, [
    {
      sql: 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
      params: ['pipeline_reasoning_effort', tier],
    },
    {
      sql: 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
      params: ['pipeline_execution_profile', executionProfile],
    },
    {
      sql: 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
      params: ['pipeline_generation_quality_profile', qualityProfile],
    },
    {
      sql: 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
      params: ['pipeline_reasoning_profile_version', '5'],
    },
  ]);
  await setSetting(
    'pipeline_draft_preset_id',
    config.draftPresetId !== null ? String(config.draftPresetId) : '',
  );
  await setSetting(
    'pipeline_review_preset_id',
    config.reviewPresetId !== null ? String(config.reviewPresetId) : '',
  );
  await setSetting(
    'pipeline_factcheck_preset_id',
    config.factCheckPresetId !== null ? String(config.factCheckPresetId) : '',
  );
  await setSetting(
    'pipeline_proof_preset_id',
    config.proofPresetId !== null ? String(config.proofPresetId) : '',
  );
  await setSetting('pipeline_draft_max_tokens', String(config.draftMaxTokens));
  await setSetting(
    'pipeline_review_max_tokens',
    String(config.reviewMaxTokens),
  );
  await setSetting(
    'pipeline_factcheck_max_tokens',
    String(config.factCheckMaxTokens),
  );
  await setSetting('pipeline_proof_max_tokens', String(config.proofMaxTokens));
  await setSetting(
    'pipeline_brief_visible_output_floor',
    String(config.briefVisibleOutputFloor ?? 1200),
  );
  await setSetting(
    'pipeline_brief_reasoning_headroom',
    String(config.briefReasoningHeadroom ?? 1200),
  );
}

export async function savePipelineTask(task: {
  id: string;
  targetType: string;
  targetId: number;
  status: string;
  stageResults: any[];
  finalText: string | null;
  error: string | null;
  inputFingerprint?: string | null;
  pipelineContextJson?: string | null;
  pipelineContextVersion?: number | null;
  pipelineContextHash?: string | null;
  outlineWorkflowVersion?: number | null;
  contextBudgetVersion?: number | null;
  pipelineTopologyVersion?: number | null;
  parentTaskId?: string | null;
  derivedKind?: string | null;
  derivedInstruction?: string | null;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
  resolvedAction?: string | null;
}): Promise<void> {
  // UPSERT via ON CONFLICT(id) DO UPDATE — NOT INSERT OR REPLACE.
  // REPLACE deletes the conflicting row first, which would cascade through
  // pipeline_stage_checkpoints.task_id ON DELETE CASCADE and wipe every
  // stage checkpoint. ON CONFLICT DO UPDATE performs an in-place UPDATE and
  // preserves child rows. id and created_at are immutable on update.
  // Large TEXT columns are COALESCE-preserved when the incoming snapshot
  // omitted them: loadFromDB / summary rows keep pipelineContextJson and
  // finalText lazy-null to stay under Android CursorWindow, and a cold-start
  // persist must not wipe a paid-for frozen snapshot.
  await execute(
    await openDatabase(),
    `INSERT INTO pipeline_tasks (
       id, target_type, target_id, status, stage_results, final_text, error,
       input_fingerprint, pipeline_context_json, pipeline_context_version,
       pipeline_context_hash, outline_workflow_version, context_budget_version,
       pipeline_topology_version,
       parent_task_id, derived_kind, derived_instruction,
       created_at, updated_at, resolved_at, resolved_action
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       target_type = excluded.target_type,
       target_id = excluded.target_id,
       status = excluded.status,
       stage_results = excluded.stage_results,
       final_text = COALESCE(excluded.final_text, pipeline_tasks.final_text),
       error = excluded.error,
       input_fingerprint = excluded.input_fingerprint,
       pipeline_context_json = COALESCE(excluded.pipeline_context_json, pipeline_tasks.pipeline_context_json),
       pipeline_context_version = COALESCE(excluded.pipeline_context_version, pipeline_tasks.pipeline_context_version),
       pipeline_context_hash = COALESCE(excluded.pipeline_context_hash, pipeline_tasks.pipeline_context_hash),
       outline_workflow_version = pipeline_tasks.outline_workflow_version,
       context_budget_version = pipeline_tasks.context_budget_version,
       pipeline_topology_version = pipeline_tasks.pipeline_topology_version,
       parent_task_id = COALESCE(excluded.parent_task_id, pipeline_tasks.parent_task_id),
       derived_kind = COALESCE(excluded.derived_kind, pipeline_tasks.derived_kind),
       derived_instruction = COALESCE(excluded.derived_instruction, pipeline_tasks.derived_instruction),
       updated_at = excluded.updated_at,
       resolved_at = excluded.resolved_at,
       resolved_action = excluded.resolved_action`,
    [
      task.id,
      task.targetType,
      task.targetId,
      task.status,
      JSON.stringify(task.stageResults),
      task.finalText,
      task.error,
      task.inputFingerprint ?? null,
      task.pipelineContextJson ?? null,
      task.pipelineContextVersion ?? null,
      task.pipelineContextHash ?? null,
      task.outlineWorkflowVersion ?? 1,
      task.contextBudgetVersion ?? 1,
      task.pipelineTopologyVersion ?? 1,
      task.parentTaskId ?? null,
      task.derivedKind ?? null,
      task.derivedInstruction ?? null,
      task.createdAt,
      task.updatedAt,
      task.resolvedAt,
      task.resolvedAction || null,
    ],
  );
}

/**
 * Atomic first-time creation of a pipeline task and its pending stage
 * checkpoints in a single SQLite transaction.
 *
 * Invariant: after success, both the parent row and one `pending` checkpoint
 * row per requested stage exist together; after failure (or a thrown error),
 * NEITHER exists — no orphan checkpoints, no half-written parent row, no
 * ghost task. This is the fix for FOREIGN KEY 787: previously `createTask`
 * flushed the parent row asynchronously, so `ensurePendingCheckpoints` could
 * run before the parent existed and hit the FK constraint.
 *
 * The statements run inside `executeTransaction`, which uses the native
 * `database.transaction` callback; any statement failure rolls back the
 * whole batch (savepoint semantics in the test double, native ROLLBACK in
 * production). `PRAGMA foreign_keys = ON` is set once at connection init
 * (initializeDatabase), so the checkpoint INSERTs are FK-checked against the
 * parent within the same transaction.
 */
export async function createPipelineTaskWithCheckpoints(
  task: {
    id: string;
    targetType: string;
    targetId: number;
    status: string;
    stageResults: any[];
    finalText: string | null;
    error: string | null;
    inputFingerprint?: string | null;
    pipelineContextJson?: string | null;
    pipelineContextVersion?: number | null;
    pipelineContextHash?: string | null;
    outlineWorkflowVersion?: number | null;
    contextBudgetVersion?: number | null;
    pipelineTopologyVersion?: number | null;
    parentTaskId?: string | null;
    derivedKind?: string | null;
    derivedInstruction?: string | null;
    createdAt: number;
    updatedAt: number;
    resolvedAt: number | null;
    resolvedAction?: string | null;
  },
  stages: PipelineCheckpointStage[],
): Promise<void> {
  const now = Date.now();
  const statements: SqlStatement[] = [
    {
      sql: `INSERT INTO pipeline_tasks (
              id, target_type, target_id, status, stage_results, final_text, error,
              input_fingerprint, pipeline_context_json, pipeline_context_version,
              pipeline_context_hash, outline_workflow_version, context_budget_version,
              pipeline_topology_version,
              parent_task_id, derived_kind, derived_instruction,
              created_at, updated_at, resolved_at, resolved_action
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        task.id,
        task.targetType,
        task.targetId,
        task.status,
        JSON.stringify(task.stageResults),
        task.finalText,
        task.error,
        task.inputFingerprint ?? null,
        task.pipelineContextJson ?? null,
        task.pipelineContextVersion ?? null,
        task.pipelineContextHash ?? null,
        task.outlineWorkflowVersion ?? 1,
        task.contextBudgetVersion ?? 1,
        task.pipelineTopologyVersion ?? 1,
        task.parentTaskId ?? null,
        task.derivedKind ?? null,
        task.derivedInstruction ?? null,
        task.createdAt,
        task.updatedAt,
        task.resolvedAt,
        task.resolvedAction || null,
      ],
    },
  ];
  for (const stage of stages) {
    statements.push({
      sql: `INSERT INTO pipeline_stage_checkpoints (
              task_id, stage, status, attempt_count, updated_at
            ) VALUES (?, ?, 'pending', 0, ?)`,
      params: [task.id, stage, now],
    });
  }
  await executeTransaction(await openDatabase(), statements);
}

/**
 * Atomically create a derived Final-only task and copy the already-validated
 * upstream checkpoints into it. The source task remains untouched; the child
 * owns a fresh pending proof checkpoint and therefore can never re-run Draft,
 * Review, FactCheck, or Brief.
 */
export async function createDerivedPipelineTaskWithCheckpoints(
  task: {
    id: string;
    targetType: string;
    targetId: number;
    status: string;
    stageResults: any[];
    finalText: string | null;
    error: string | null;
    inputFingerprint?: string | null;
    pipelineContextJson?: string | null;
    pipelineContextVersion?: number | null;
    pipelineContextHash?: string | null;
    outlineWorkflowVersion?: number | null;
    contextBudgetVersion?: number | null;
    pipelineTopologyVersion?: number | null;
    parentTaskId: string;
    derivedKind: string;
    derivedInstruction: string;
    createdAt: number;
    updatedAt: number;
    resolvedAt: number | null;
    resolvedAction?: string | null;
  },
  checkpoints: Array<
    Pick<
      PipelineStageCheckpointRow,
      | 'stage'
      | 'status'
      | 'outputText'
      | 'errorCode'
      | 'errorMessage'
      | 'inputTokens'
      | 'outputTokens'
      | 'totalTokens'
      | 'durationMs'
      | 'attemptCount'
      | 'startedAt'
      | 'completedAt'
      | 'updatedAt'
    >
  >,
): Promise<void> {
  const statements: SqlStatement[] = [
    {
      sql: `INSERT INTO pipeline_tasks (
              id, target_type, target_id, status, stage_results, final_text, error,
              input_fingerprint, pipeline_context_json, pipeline_context_version,
              pipeline_context_hash, outline_workflow_version, context_budget_version,
              pipeline_topology_version,
              parent_task_id, derived_kind, derived_instruction,
              created_at, updated_at, resolved_at, resolved_action
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        task.id,
        task.targetType,
        task.targetId,
        task.status,
        JSON.stringify(task.stageResults),
        task.finalText,
        task.error,
        task.inputFingerprint ?? null,
        task.pipelineContextJson ?? null,
        task.pipelineContextVersion ?? null,
        task.pipelineContextHash ?? null,
        task.outlineWorkflowVersion ?? 1,
        task.contextBudgetVersion ?? 1,
        task.pipelineTopologyVersion ?? 1,
        task.parentTaskId,
        task.derivedKind,
        task.derivedInstruction,
        task.createdAt,
        task.updatedAt,
        task.resolvedAt,
        task.resolvedAction || null,
      ],
    },
  ];
  for (const checkpoint of checkpoints) {
    statements.push({
      sql: `INSERT INTO pipeline_stage_checkpoints (
              task_id, stage, status, output_text, error_code, error_message,
              input_tokens, output_tokens, total_tokens, duration_ms,
              attempt_count, started_at, completed_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        task.id,
        checkpoint.stage,
        checkpoint.status,
        checkpoint.outputText ?? null,
        checkpoint.errorCode ?? null,
        checkpoint.errorMessage ?? null,
        checkpoint.inputTokens ?? null,
        checkpoint.outputTokens ?? null,
        checkpoint.totalTokens ?? null,
        checkpoint.durationMs ?? null,
        checkpoint.attemptCount ?? 0,
        checkpoint.startedAt ?? null,
        checkpoint.completedAt ?? null,
        checkpoint.updatedAt ?? Date.now(),
      ],
    });
  }
  await executeTransaction(await openDatabase(), statements);
}

/** Fetch a single pipeline task by id (diagnostic parent-exists check). */
export async function getPipelineTaskById(id: string): Promise<any | null> {
  // Compatibility API retained for tests/legacy callers, but routed through
  // the narrow, chunked detail reader so it can never issue a wide-row SELECT.
  return getPipelineTaskResumePayload(id);
}

export interface PipelineTaskDerivedFinalMetadata {
  id: string;
  targetType: string;
  targetId: number;
  status: string;
  error: string | null;
  inputFingerprint: string | null;
  pipelineContextVersion: number | null;
  pipelineContextHash: string | null;
  outlineWorkflowVersion: number | null;
  contextBudgetVersion: number | null;
  pipelineTopologyVersion: number | null;
  parentTaskId: string | null;
  derivedKind: string | null;
  derivedInstruction: string | null;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
  resolvedAction: string | null;
}

/**
 * Narrow source-task projection for Derived Final. Never select the task row's
 * stage_results, final_text or pipeline_context_json here: those TEXT columns
 * can collectively exceed Android CursorWindow even when the caller only
 * needs source metadata.
 */
export async function getPipelineTaskForDerivedFinalRewrite(
  id: string,
): Promise<PipelineTaskDerivedFinalMetadata | null> {
  const row = await one<Row>(
    `SELECT id, target_type, target_id, status, error,
            input_fingerprint, pipeline_context_version, pipeline_context_hash,
            outline_workflow_version, context_budget_version, pipeline_topology_version,
            parent_task_id, derived_kind, derived_instruction,
            created_at, updated_at, resolved_at, resolved_action
       FROM pipeline_tasks
      WHERE id = ?`,
    [id],
  );
  if (!row) return null;
  return {
    id: String(row.id),
    targetType: String(row.target_type),
    targetId: Number(row.target_id),
    status: String(row.status),
    error: row.error ?? null,
    inputFingerprint: row.input_fingerprint ?? null,
    pipelineContextVersion:
      row.pipeline_context_version != null
        ? Number(row.pipeline_context_version)
        : null,
    pipelineContextHash: row.pipeline_context_hash ?? null,
    outlineWorkflowVersion:
      row.outline_workflow_version != null
        ? Number(row.outline_workflow_version)
        : null,
    contextBudgetVersion:
      row.context_budget_version != null
        ? Number(row.context_budget_version)
        : null,
    pipelineTopologyVersion:
      row.pipeline_topology_version != null
        ? Number(row.pipeline_topology_version)
        : null,
    parentTaskId: row.parent_task_id ?? null,
    derivedKind: row.derived_kind ?? null,
    derivedInstruction: row.derived_instruction ?? null,
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
    resolvedAt: row.resolved_at != null ? Number(row.resolved_at) : null,
    resolvedAction: row.resolved_action ?? null,
  };
}

const PIPELINE_TEXT_CHUNK_CHARACTERS = 128 * 1024;

async function readPipelineTextColumn(
  column: 'final_text' | 'pipeline_context_json',
  id: string,
): Promise<string | null> {
  const first = await one<Row>(
    `SELECT length(${column}) AS payload_length,
            substr(${column}, 1, ?) AS payload_chunk
       FROM pipeline_tasks
      WHERE id = ?`,
    [PIPELINE_TEXT_CHUNK_CHARACTERS, id],
  );
  if (!first) return null;
  if (first.payload_length == null) return null;
  const totalLength = Math.max(0, Number(first.payload_length) || 0);
  let payload = String(first.payload_chunk ?? '');
  for (
    let offset = PIPELINE_TEXT_CHUNK_CHARACTERS + 1;
    offset <= totalLength;
    offset += PIPELINE_TEXT_CHUNK_CHARACTERS
  ) {
    const next = await one<Row>(
      `SELECT substr(${column}, ?, ?) AS payload_chunk
         FROM pipeline_tasks
        WHERE id = ?`,
      [offset, PIPELINE_TEXT_CHUNK_CHARACTERS, id],
    );
    payload += String(next?.payload_chunk ?? '');
  }
  return payload;
}

/** Read final_text only, in bounded chunks, for Derived Final validation. */
export function getPipelineTaskFinalTextPayload(
  id: string,
): Promise<string | null> {
  return readPipelineTextColumn('final_text', id);
}

/** Read the frozen context JSON only, in bounded chunks, for Derived Final. */
export function getPipelineTaskContextPayload(
  id: string,
): Promise<string | null> {
  return readPipelineTextColumn('pipeline_context_json', id);
}

/**
 * Cold-start / resume detail reader. Metadata, final text, frozen context and
 * checkpoint output are fetched through separate narrow/chunked queries; no
 * SQLite row contains the task's large TEXT columns together.
 */
export async function getPipelineTaskResumePayload(
  id: string,
): Promise<any | null> {
  const metadata = await getPipelineTaskForDerivedFinalRewrite(id);
  if (!metadata) return null;
  const [pipelineContextJson, finalText, checkpointRows] = await Promise.all([
    getPipelineTaskContextPayload(id),
    getPipelineTaskFinalTextPayload(id),
    getStageCheckpointsForDerivedFinalRewrite(id),
  ]);
  const stageResults = checkpointsToStageResults(checkpointRows).map(row => ({
    ...row,
    stage: row.stage as any,
  }));
  return {
    ...metadata,
    stageResults,
    finalText,
    pipelineContextJson,
  };
}

/**
 * Read only the payload needed by result adoption.
 *
 * `pipeline_tasks` deliberately keeps several potentially large TEXT values
 * (the frozen context, stage projections and final text) on the same row.
 * Android CursorWindow applies its limit to the selected row, so selecting
 * the whole row during adoption can fail even when `final_text` itself is
 * small enough. Keep this critical path on a narrow projection and read the
 * final text in bounded chunks so an unusually long generated chapter also
 * cannot overflow a CursorWindow row by itself.
 */
export async function getPipelineTaskAdoptionPayload(
  id: string,
): Promise<{ id: string; finalText: string | null } | null> {
  const chunkCharacters = 128 * 1024;
  const first = await one<Row>(
    `SELECT id,
            length(final_text) AS final_text_length,
            substr(final_text, 1, ?) AS final_text_chunk
       FROM pipeline_tasks
      WHERE id = ?`,
    [chunkCharacters, id],
  );
  if (!first) return null;

  if (first.final_text_length == null) {
    return { id: String(first.id), finalText: null };
  }

  const totalLength = Math.max(0, Number(first.final_text_length) || 0);
  let finalText = String(first.final_text_chunk ?? '');
  for (
    let offset = chunkCharacters + 1;
    offset <= totalLength;
    offset += chunkCharacters
  ) {
    const next = await one<Row>(
      `SELECT substr(final_text, ?, ?) AS final_text_chunk
         FROM pipeline_tasks
        WHERE id = ?`,
      [offset, chunkCharacters, id],
    );
    finalText += String(next?.final_text_chunk ?? '');
  }

  return { id: String(first.id), finalText };
}

const PIPELINE_TASK_SUMMARY_COLUMNS = `
  id, target_type, target_id, status, error,
  input_fingerprint, pipeline_context_version, pipeline_context_hash,
  outline_workflow_version, context_budget_version, pipeline_topology_version,
  parent_task_id, derived_kind, derived_instruction,
  created_at, updated_at, resolved_at, resolved_action`;

function checkpointSummariesToStageResults(
  rows: PipelineStageCheckpointSummary[],
): Array<{
  stage: string;
  text: string;
  status: 'success' | 'failed' | 'skipped';
  error?: string;
  errorCode?: string;
  tokens?: { input: number; output: number; total: number };
  durationMs: number;
}> {
  return rows
    .filter(
      row =>
        row.stage !== 'finalize' &&
        (row.status === 'succeeded' ||
          row.status === 'failed' ||
          row.status === 'skipped'),
    )
    .map(row => ({
      stage: String(row.stage),
      text: '',
      status:
        row.status === 'succeeded'
          ? ('success' as const)
          : row.status === 'skipped'
            ? ('skipped' as const)
            : ('failed' as const),
      error: row.errorMessage || undefined,
      errorCode: row.errorCode || undefined,
      tokens:
        row.inputTokens != null ||
        row.outputTokens != null ||
        row.totalTokens != null
          ? {
              input: row.inputTokens || 0,
              output: row.outputTokens || 0,
              total: row.totalTokens || 0,
            }
          : undefined,
      durationMs: row.durationMs || 0,
    }));
}

function mapPipelineTaskSummary(
  row: Row,
  checkpointRows: PipelineStageCheckpointSummary[],
) {
  return {
    id: String(row.id),
    targetType: row.target_type,
    targetId: Number(row.target_id),
    status: row.status,
    stageResults: checkpointSummariesToStageResults(checkpointRows),
    // Large payloads are intentionally lazy. Result/Resume/Adoption paths
    // fetch them through their dedicated chunk readers.
    finalText: null,
    error: row.error ?? null,
    inputFingerprint: row.input_fingerprint ?? null,
    pipelineContextJson: null,
    pipelineContextVersion:
      row.pipeline_context_version != null
        ? Number(row.pipeline_context_version)
        : null,
    pipelineContextHash: row.pipeline_context_hash ?? null,
    outlineWorkflowVersion:
      row.outline_workflow_version != null
        ? Number(row.outline_workflow_version)
        : null,
    contextBudgetVersion:
      row.context_budget_version != null
        ? Number(row.context_budget_version)
        : null,
    pipelineTopologyVersion:
      row.pipeline_topology_version != null
        ? Number(row.pipeline_topology_version)
        : null,
    parentTaskId: row.parent_task_id ?? null,
    derivedKind: row.derived_kind ?? null,
    derivedInstruction: row.derived_instruction ?? null,
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
    resolvedAt: row.resolved_at != null ? Number(row.resolved_at) : null,
    resolvedAction: row.resolved_action ?? null,
  };
}

async function getPipelineTaskSummaries(
  whereSql = '',
  params: unknown[] = [],
): Promise<any[]> {
  const rows = await all<Row>(
    `SELECT ${PIPELINE_TASK_SUMMARY_COLUMNS}
       FROM pipeline_tasks
      ${whereSql}
      ORDER BY created_at DESC`,
    params,
  );
  const checkpointRows = await getStageCheckpointSummariesForTasks(
    rows.map(row => String(row.id)),
  );
  const byTask = new Map<string, PipelineStageCheckpointSummary[]>();
  for (const checkpoint of checkpointRows) {
    const list = byTask.get(checkpoint.taskId) || [];
    list.push(checkpoint);
    byTask.set(checkpoint.taskId, list);
  }
  return rows.map(row =>
    mapPipelineTaskSummary(row, byTask.get(String(row.id)) || []),
  );
}

/** Narrow metadata + checkpoint summaries for batch/status decisions. */
export function getPipelineTaskSummaryById(id: string): Promise<any | null> {
  return getPipelineTaskSummaries('WHERE id = ?', [id]).then(
    rows => rows[0] || null,
  );
}

export async function getUnresolvedPipelineTasks(): Promise<any[]> {
  return getPipelineTaskSummaries('WHERE resolved_at IS NULL');
}

export async function getAllPipelineTasks(): Promise<any[]> {
  return getPipelineTaskSummaries();
}

export async function deletePipelineTask(id: string): Promise<void> {
  await execute(
    await openDatabase(),
    'DELETE FROM pipeline_tasks WHERE id = ?',
    [id],
  );
}

export async function deleteResolvedPipelineTasks(): Promise<void> {
  await execute(
    await openDatabase(),
    `DELETE FROM pipeline_tasks
      WHERE resolved_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM pipeline_tasks AS child
           WHERE child.parent_task_id = pipeline_tasks.id
        )`,
  );
}

/**
 * Dedicated critical-path write for the frozen pipeline context snapshot.
 * Must succeed (exactly 1 row) before the first LLM call. Does not go through
 * the fire-and-forget store persistence queue.
 */
export async function updatePipelineTaskContext(
  taskId: string,
  snapshot: {
    json: string;
    version: number;
    hash: string;
  },
): Promise<void> {
  const database = await openDatabase();
  const result = await execute(
    database,
    `UPDATE pipeline_tasks
     SET pipeline_context_json = ?,
         pipeline_context_version = ?,
         pipeline_context_hash = ?,
         updated_at = ?
     WHERE id = ?`,
    [snapshot.json, snapshot.version, snapshot.hash, Date.now(), taskId],
  );
  const rowsAffected = Number((result as any)?.rowsAffected ?? 0);
  if (rowsAffected !== 1) {
    throw new Error(
      `更新流水线上下文快照失败：任务 ${taskId} 影响行数 ${rowsAffected}（期望 1）`,
    );
  }
}

/**
 * F3-01: targeted resume-state write for a user-confirmed resume.
 *
 * Unlike a wide-row overwrite, this UPDATE only flips the fields the
 * state machine needs to re-enter the task. `savePipelineTask` itself now
 * also COALESCE-preserves existing large TEXT blobs when the incoming
 * snapshot omitted them (summary/lazy-load rows).
 *
 *   status          = 'interrupted'   (resume path, see determineNextPipelineAction)
 *   error           = NULL            (stale failure text must not block resume)
 *   resolved_at     = NULL            (task re-opened; adoption not yet done)
 *   resolved_action = NULL
 *   updated_at      = now
 *
 * It NEVER touches:
 *   id / target_type / target_id / created_at
 *   stage_results / final_text
 *   input_fingerprint / pipeline_context_json / pipeline_context_version /
 *   pipeline_context_hash
 *
 * so a task that already paid for draft/review/factCheck keeps its frozen
 * execution + draft context + input fingerprint, and the pipeline state
 * machine resumes ONLY the failed stage (same task, same frozen request,
 * succeeded stages never re-run, no double billing).
 */
export async function updatePipelineTaskResumeState(
  taskId: string,
  now = Date.now(),
): Promise<void> {
  const database = await openDatabase();
  const result = await execute(
    database,
    `UPDATE pipeline_tasks
     SET status = 'interrupted',
         error = NULL,
         resolved_at = NULL,
         resolved_action = NULL,
         updated_at = ?
     WHERE id = ?`,
    [now, taskId],
  );
  const rowsAffected = Number((result as any)?.rowsAffected ?? 0);
  if (rowsAffected !== 1) {
    throw new Error(
      `恢复流水线任务失败：任务 ${taskId} 影响行数 ${rowsAffected}（期望 1）`,
    );
  }
}
