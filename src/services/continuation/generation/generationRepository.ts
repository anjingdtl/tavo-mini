/**
 * Phase 3 generation / state persistence (table-level).
 * Business orchestration lives in services, not here.
 */
import type SQLite from 'react-native-sqlite-storage';
import { openDatabase } from '../../../data/connection/openDatabase';
import { executeTransaction } from '../../database/transaction';
import { sha256Hex } from '../hashUtils';
import { v4 } from '../../uuidBridge';
import {
  appendContinuationGenerationTraceEvent,
  ensureContinuationGenerationTrace,
} from './continuationGenerationTrace';
import { normalizeContinuationProposalSubjectRefType } from './types';
import type {
  CheckCategory,
  CheckResolutionStatus,
  CheckSeverity,
  ContinuationArtifact,
  ContinuationCheckResult,
  ContinuationGenerationRun,
  ContinuationGenerationStageResult,
  ContinuationGenerationSettings,
  ContinuationArtifactEligibility,
  ContinuationOutboxItem,
  ContinuationPlan,
  ContinuationRunState,
  ContinuationStageName,
  ContinuationStageResultStatus,
  ContinuationV4StageName,
  ContinuationV5PhysicalNode,
  ContinuationStageResultStageName,
  ContinuationArtifactStage,
  ContinuationStateEvent,
  ContinuationStateProposal,
  OutboxOperation,
  ProposalStatus,
  ProposalType,
  StrictnessProfile,
  TypedEntityRef,
  ContinuationContextSnapshot,
  ContinuationContextTrace,
} from './types';
import type { ContinuationV4StageBudget } from './continuationV4Budget';

function nowIso(): string {
  return new Date().toISOString();
}

function asBool(v: number | boolean | null | undefined): boolean {
  return v === 1 || v === true;
}

function rowSettings(r: any): ContinuationGenerationSettings {
  return {
    projectId: r.project_id,
    strictnessProfile: r.strictness_profile,
    worldRuleLevel: r.world_rule_level,
    characterLevel: r.character_level,
    relationshipLevel: r.relationship_level,
    plotLevel: r.plot_level,
    experienceLevel: r.experience_level,
    knowledgeLevel: r.knowledge_level,
    styleLevel: r.style_level,
    allowNewCharacters: asBool(r.allow_new_characters),
    allowNewLocations: asBool(r.allow_new_locations),
    allowNewOrganizations: asBool(r.allow_new_organizations),
    majorRelationshipChangePolicy: r.major_relationship_change_policy,
    majorPowerChangePolicy: r.major_power_change_policy,
    characterDeathPolicy: r.character_death_policy,
    resurrectionPolicy: r.resurrection_policy,
    plannerLlmConfigId: r.planner_llm_config_id ?? null,
    writerLlmConfigId: r.writer_llm_config_id ?? null,
    checkerLlmConfigId: r.checker_llm_config_id ?? null,
    repairLlmConfigId: r.repair_llm_config_id ?? null,
    stateExtractionLlmConfigId: r.state_extraction_llm_config_id ?? null,
    controlLlmConfigId: r.control_llm_config_id ?? null,
    plannerConfirmationPolicy: r.planner_confirmation_policy,
    checkerEnabled: asBool(r.checker_enabled),
    maxRepairRounds: r.max_repair_rounds,
    targetChapterChars: r.target_chapter_chars,
    customRulesJson: r.custom_rules_json ?? '[]',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Metadata projection for continuation_generation_runs reads.
 *
 * A 50+ chapter continuation project accumulates multi-megabyte
 * context_snapshot_json values in run rows. On low-RAM devices the Android
 * CursorWindow shrinks to 1MB, so any SELECT that materializes the snapshot
 * column throws SQLiteBlobTooBigException and fails the whole pipeline
 * (observed as stage_failed on a 51-chapter project). Metadata reads must
 * therefore project the giant column away; consumers that truly need the
 * snapshot body use getRunContextSnapshotJson(), which streams it in chunks
 * via substr(). workflowVersion and the kernel trace id are extracted in
 * SQL with json_extract so metadata-only callers keep their semantics.
 */
const RUN_METADATA_SELECT = `
  id, project_id, chapter_id, target_position, source_id,
  NULL AS source_snapshot_json,
  canon_snapshot_id, canon_revision, story_memory_fingerprint,
  story_memory_through_position, input_revision_hash, user_instruction,
  settings_snapshot_json, NULL AS context_trace_json, token_usage_json,
  NULL AS context_snapshot_json,
  json_extract(context_snapshot_json, '$.workflowVersion') AS workflow_version,
  json_extract(context_snapshot_json, '$.writingKernelTrace.generationTraceId') AS generation_trace_id,
  json_extract(context_snapshot_json, '$.generationTraceId') AS generation_trace_id_fallback,
  state, stage, completion_reason, adopted_revision_hash, finalized_revision_hash,
  error_code, error_message, created_at, updated_at, completed_at`;

/**
 * Large continuation payloads are never selected as a whole row. A single
 * substr() result stays below the Android CursorWindow limit even when the
 * stored chapter, structured envelope, or receipt JSON is much larger.
 */
const LARGE_PAYLOAD_CHUNK_CHARS = 128 * 1024;

const ARTIFACT_METADATA_SELECT = `
  id, run_id, stage, repair_round, parent_artifact_id,
  NULL AS content, content_hash, eligibility_status, rejection_code, created_at`;

const STAGE_RESULT_METADATA_SELECT = `
  id, run_id, stage, status, request_reserved, request_count,
  model_config_id, input_tokens, output_tokens, min_output_tokens,
  max_output_tokens, NULL AS output_json, artifact_id, error_code,
  error_message, started_at, completed_at, created_at, updated_at`;

const STATE_PROPOSAL_METADATA_SELECT = `
  id, project_id, chapter_id, source_run_id, extraction_content_hash,
  chapter_revision_hash, proposal_type, subject_ref_type, subject_ref_id,
  NULL AS payload_json, proposal_fingerprint, evidence_start, evidence_end,
  status, decision_note, decided_at, created_at, updated_at`;

const STATE_EVENT_METADATA_SELECT = `
  id, proposal_id, project_id, chapter_id, chapter_position,
  chapter_revision_hash, event_type, NULL AS entity_refs_json,
  NULL AS payload_json, valid_from_position, valid_to_position,
  created_at, invalidated_at, invalidation_reason`;

const OUTBOX_METADATA_SELECT = `
  id, project_id, chapter_id, operation, NULL AS payload_json, dedupe_key,
  state, attempt_count, last_error, created_at, updated_at, completed_at`;

type LargePayloadTable =
  | 'continuation_generation_runs'
  | 'continuation_generation_artifacts'
  | 'continuation_generation_stage_results'
  | 'pipeline_stage_attempts'
  | 'continuation_state_proposals'
  | 'continuation_state_events'
  | 'continuation_state_sync_outbox';

type LargePayloadColumn =
  | 'context_snapshot_json'
  | 'source_snapshot_json'
  | 'context_trace_json'
  | 'content'
  | 'output_json'
  | 'frozen_request_json'
  | 'reasoning_content_temp'
  | 'response_candidate_temp'
  | 'validation_details_json'
  | 'entity_refs_json'
  | 'payload_json';

async function readLargePayloadColumn(input: {
  table: LargePayloadTable;
  column: LargePayloadColumn;
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
    offset += LARGE_PAYLOAD_CHUNK_CHARS
  ) {
    const [chunkResult] = await db.executeSql(
      `SELECT substr(${input.column}, ?, ?) AS payload_chunk
         FROM ${input.table}
        WHERE ${input.whereSql}`,
      [offset, LARGE_PAYLOAD_CHUNK_CHARS, ...input.params],
    );
    if (chunkResult.rows.length === 0) break;
    payload += String(chunkResult.rows.item(0).payload_chunk ?? '');
  }
  return payload;
}

async function materializeArtifactRow(
  row: any,
): Promise<ContinuationArtifact> {
  const artifact = rowArtifact(row);
  const content = await readLargePayloadColumn({
    table: 'continuation_generation_artifacts',
    column: 'content',
    whereSql: 'id = ?',
    params: [artifact.id],
  });
  if (content == null) {
    throw new Error(
      `continuation artifact ${artifact.id} content disappeared during read`,
    );
  }
  return { ...artifact, content };
}

async function materializeStageResultRow(
  row: any,
): Promise<ContinuationGenerationStageResult> {
  const result = rowStageResult(row);
  const outputJson = await readLargePayloadColumn({
    table: 'continuation_generation_stage_results',
    column: 'output_json',
    whereSql: 'id = ?',
    params: [result.id],
  });
  return { ...result, outputJson };
}

async function materializeProposalRow(row: any): Promise<ContinuationStateProposal> {
  const payloadJson = await readLargePayloadColumn({
    table: 'continuation_state_proposals',
    column: 'payload_json',
    whereSql: 'id = ?',
    params: [row.id],
  });
  return rowProposal({ ...row, payload_json: payloadJson ?? '' });
}

async function materializeEventRow(row: any): Promise<ContinuationStateEvent> {
  const [entityRefsJson, payloadJson] = await Promise.all([
    readLargePayloadColumn({
      table: 'continuation_state_events',
      column: 'entity_refs_json',
      whereSql: 'id = ?',
      params: [row.id],
    }),
    readLargePayloadColumn({
      table: 'continuation_state_events',
      column: 'payload_json',
      whereSql: 'id = ?',
      params: [row.id],
    }),
  ]);
  return rowEvent({
    ...row,
    entity_refs_json: entityRefsJson ?? '[]',
    payload_json: payloadJson ?? '',
  });
}

async function materializeOutboxRow(row: any): Promise<ContinuationOutboxItem> {
  const payloadJson = await readLargePayloadColumn({
    table: 'continuation_state_sync_outbox',
    column: 'payload_json',
    whereSql: 'id = ?',
    params: [row.id],
  });
  return rowOutbox({ ...row, payload_json: payloadJson ?? '' });
}

function rowRun(r: any): ContinuationGenerationRun {
  let workflowVersion: 2 | 4 | 5 | undefined;
  const extracted = Number(r.workflow_version);
  if (extracted === 2 || extracted === 4 || extracted === 5) {
    workflowVersion = extracted;
  } else {
    try {
      const value = JSON.parse(r.context_snapshot_json || '{}')?.workflowVersion;
      workflowVersion =
        value === 2 || value === 4 || value === 5 ? value : undefined;
    } catch {
      workflowVersion = undefined;
    }
  }
  return {
    id: r.id,
    workflowVersion,
    projectId: r.project_id,
    chapterId: r.chapter_id,
    targetPosition: r.target_position,
    sourceId: r.source_id ?? null,
    sourceSnapshotJson: r.source_snapshot_json,
    canonSnapshotId: r.canon_snapshot_id ?? null,
    canonRevision: r.canon_revision,
    storyMemoryFingerprint: r.story_memory_fingerprint,
    storyMemoryThroughPosition: r.story_memory_through_position,
    inputRevisionHash: r.input_revision_hash,
    userInstruction: r.user_instruction,
    settingsSnapshotJson: r.settings_snapshot_json,
    contextSnapshotJson: r.context_snapshot_json ?? null,
    contextTraceJson: r.context_trace_json ?? null,
    tokenUsageJson: r.token_usage_json ?? '{}',
    state: r.state,
    stage: r.stage,
    completionReason: r.completion_reason ?? null,
    adoptedRevisionHash: r.adopted_revision_hash ?? null,
    finalizedRevisionHash: r.finalized_revision_hash ?? null,
    errorCode: r.error_code ?? null,
    errorMessage: r.error_message ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at ?? null,
  };
}

function rowArtifact(r: any): ContinuationArtifact {
  return {
    id: r.id,
    runId: r.run_id,
    stage: r.stage,
    repairRound: r.repair_round,
    parentArtifactId: r.parent_artifact_id ?? null,
    content: r.content,
    contentHash: r.content_hash,
    eligibilityStatus: r.eligibility_status ?? 'eligible',
    rejectionCode: r.rejection_code ?? null,
    createdAt: r.created_at,
  };
}

function rowStageResult(r: any): ContinuationGenerationStageResult {
  return {
    id: r.id,
    runId: r.run_id,
    stage: r.stage,
    status: r.status,
    requestReserved: asBool(r.request_reserved),
    requestCount: Number(r.request_count ?? 0),
    modelConfigId: r.model_config_id ?? null,
    inputTokens: r.input_tokens ?? null,
    outputTokens: r.output_tokens ?? null,
    minOutputTokens: r.min_output_tokens ?? null,
    maxOutputTokens: r.max_output_tokens ?? null,
    outputJson: r.output_json ?? null,
    artifactId: r.artifact_id ?? null,
    errorCode: r.error_code ?? null,
    errorMessage: r.error_message ?? null,
    startedAt: r.started_at ?? null,
    completedAt: r.completed_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowCheck(r: any): ContinuationCheckResult {
  let evidenceIds: number[] = [];
  try {
    evidenceIds = JSON.parse(r.evidence_ids_json || '[]');
  } catch {
    evidenceIds = [];
  }
  return {
    id: r.id,
    runId: r.run_id,
    chapterId: r.chapter_id,
    artifactId: r.artifact_id,
    artifactHash: r.artifact_hash,
    category: r.category,
    subtype: r.subtype,
    severity: r.severity,
    confidence: r.confidence,
    generatedStart: r.generated_start ?? null,
    generatedEnd: r.generated_end ?? null,
    generatedExcerpt: r.generated_excerpt,
    description: r.description,
    entityRefType: r.entity_ref_type ?? null,
    entityRefId: r.entity_ref_id ?? null,
    evidenceIds,
    suggestedFix: r.suggested_fix ?? null,
    resolutionStatus: r.resolution_status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowProposal(r: any): ContinuationStateProposal {
  return {
    id: r.id,
    projectId: r.project_id,
    chapterId: r.chapter_id,
    sourceRunId: r.source_run_id ?? null,
    extractionContentHash: r.extraction_content_hash,
    chapterRevisionHash: r.chapter_revision_hash,
    proposalType: r.proposal_type,
    subjectRefType: r.subject_ref_type ?? null,
    subjectRefId: r.subject_ref_id ?? null,
    payloadJson: r.payload_json,
    proposalFingerprint: r.proposal_fingerprint,
    evidenceStart: r.evidence_start,
    evidenceEnd: r.evidence_end,
    status: r.status,
    decisionNote: r.decision_note ?? null,
    decidedAt: r.decided_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowEvent(r: any): ContinuationStateEvent {
  let entityRefs: TypedEntityRef[] = [];
  try {
    entityRefs = JSON.parse(r.entity_refs_json || '[]');
  } catch {
    entityRefs = [];
  }
  return {
    id: r.id,
    proposalId: r.proposal_id,
    projectId: r.project_id,
    chapterId: r.chapter_id,
    chapterPosition: r.chapter_position,
    chapterRevisionHash: r.chapter_revision_hash,
    eventType: r.event_type,
    entityRefs,
    payloadJson: r.payload_json,
    validFromPosition: r.valid_from_position,
    validToPosition: r.valid_to_position ?? null,
    createdAt: r.created_at,
    invalidatedAt: r.invalidated_at ?? null,
    invalidationReason: r.invalidation_reason ?? null,
  };
}

function rowOutbox(r: any): ContinuationOutboxItem {
  return {
    id: r.id,
    projectId: r.project_id,
    chapterId: r.chapter_id ?? null,
    operation: r.operation,
    payloadJson: r.payload_json,
    dedupeKey: r.dedupe_key,
    state: r.state,
    attemptCount: r.attempt_count,
    lastError: r.last_error ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at ?? null,
  };
}

export function defaultGenerationSettings(
  projectId: number,
  ts = nowIso(),
): ContinuationGenerationSettings {
  return {
    projectId,
    strictnessProfile: 'balanced',
    worldRuleLevel: 'strict',
    characterLevel: 'strict',
    relationshipLevel: 'strict',
    plotLevel: 'balanced',
    experienceLevel: 'strict',
    knowledgeLevel: 'strict',
    // 原著续写必须严格遵循已启用的原著画风画像，不能降级为可选项。
    styleLevel: 'strict',
    allowNewCharacters: true,
    allowNewLocations: true,
    allowNewOrganizations: true,
    majorRelationshipChangePolicy: 'require_confirmation',
    majorPowerChangePolicy: 'require_confirmation',
    characterDeathPolicy: 'require_confirmation',
    resurrectionPolicy: 'forbid',
    plannerLlmConfigId: null,
    writerLlmConfigId: null,
    checkerLlmConfigId: null,
    repairLlmConfigId: null,
    stateExtractionLlmConfigId: null,
    controlLlmConfigId: null,
    plannerConfirmationPolicy: 'risk_only',
    checkerEnabled: true,
    maxRepairRounds: 1,
    targetChapterChars: 3000,
    customRulesJson: '[]',
    createdAt: ts,
    updatedAt: ts,
  };
}

export async function ensureGenerationSettings(
  projectId: number,
): Promise<ContinuationGenerationSettings> {
  const db = await openDatabase();
  const [res] = await db.executeSql(
    'SELECT * FROM continuation_generation_settings WHERE project_id = ?',
    [projectId],
  );
  if (res.rows.length > 0) {
    const existing = rowSettings(res.rows.item(0));
    // 旧项目可能保存了 off/balanced。读取时一次性收敛，避免旧配置绕过
    // 续写必需的原著画风注入。
    if (existing.styleLevel !== 'strict') {
      const updatedAt = nowIso();
      await db.executeSql(
        'UPDATE continuation_generation_settings SET style_level = ?, updated_at = ? WHERE project_id = ?',
        ['strict', updatedAt, projectId],
      );
      return { ...existing, styleLevel: 'strict', updatedAt };
    }
    return existing;
  }
  const s = defaultGenerationSettings(projectId);
  await db.executeSql(
    `INSERT INTO continuation_generation_settings (
      project_id, strictness_profile, world_rule_level, character_level,
      relationship_level, plot_level, experience_level, knowledge_level,
      style_level, allow_new_characters, allow_new_locations, allow_new_organizations,
      major_relationship_change_policy, major_power_change_policy,
      character_death_policy, resurrection_policy,
      planner_confirmation_policy, checker_enabled, max_repair_rounds,
      target_chapter_chars, custom_rules_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      s.projectId,
      s.strictnessProfile,
      s.worldRuleLevel,
      s.characterLevel,
      s.relationshipLevel,
      s.plotLevel,
      s.experienceLevel,
      s.knowledgeLevel,
      s.styleLevel,
      s.allowNewCharacters ? 1 : 0,
      s.allowNewLocations ? 1 : 0,
      s.allowNewOrganizations ? 1 : 0,
      s.majorRelationshipChangePolicy,
      s.majorPowerChangePolicy,
      s.characterDeathPolicy,
      s.resurrectionPolicy,
      s.plannerConfirmationPolicy,
      s.checkerEnabled ? 1 : 0,
      s.maxRepairRounds,
      s.targetChapterChars,
      s.customRulesJson,
      s.createdAt,
      s.updatedAt,
    ],
  );
  return s;
}

export async function updateGenerationSettings(
  projectId: number,
  patch: Partial<ContinuationGenerationSettings>,
): Promise<ContinuationGenerationSettings> {
  const current = await ensureGenerationSettings(projectId);
  const next: ContinuationGenerationSettings = {
    ...current,
    ...patch,
    projectId,
    // 即便是遗留调用方传入 off/balanced，也不得关闭原著画风约束。
    styleLevel: 'strict',
    updatedAt: nowIso(),
  };
  const db = await openDatabase();
  await db.executeSql(
    `UPDATE continuation_generation_settings SET
      strictness_profile=?, world_rule_level=?, character_level=?,
      relationship_level=?, plot_level=?, experience_level=?, knowledge_level=?,
      style_level=?, allow_new_characters=?, allow_new_locations=?,
      allow_new_organizations=?, major_relationship_change_policy=?,
      major_power_change_policy=?, character_death_policy=?, resurrection_policy=?,
      planner_llm_config_id=?, writer_llm_config_id=?, checker_llm_config_id=?,
      repair_llm_config_id=?, state_extraction_llm_config_id=?,
      control_llm_config_id=?,
      planner_confirmation_policy=?, checker_enabled=?, max_repair_rounds=?,
      target_chapter_chars=?, custom_rules_json=?, updated_at=?
    WHERE project_id=?`,
    [
      next.strictnessProfile,
      next.worldRuleLevel,
      next.characterLevel,
      next.relationshipLevel,
      next.plotLevel,
      next.experienceLevel,
      next.knowledgeLevel,
      next.styleLevel,
      next.allowNewCharacters ? 1 : 0,
      next.allowNewLocations ? 1 : 0,
      next.allowNewOrganizations ? 1 : 0,
      next.majorRelationshipChangePolicy,
      next.majorPowerChangePolicy,
      next.characterDeathPolicy,
      next.resurrectionPolicy,
      next.plannerLlmConfigId,
      next.writerLlmConfigId,
      next.checkerLlmConfigId,
      next.repairLlmConfigId,
      next.stateExtractionLlmConfigId,
      next.controlLlmConfigId,
      next.plannerConfirmationPolicy,
      next.checkerEnabled ? 1 : 0,
      next.maxRepairRounds,
      next.targetChapterChars,
      next.customRulesJson,
      next.updatedAt,
      projectId,
    ],
  );
  return next;
}

export function newContinuationRunId(): string {
  return `ct_${v4().replace(/-/g, '')}`;
}

export async function insertRun(
  run: Omit<
    ContinuationGenerationRun,
    'createdAt' | 'updatedAt' | 'completedAt'
  > & {
    createdAt?: string;
    updatedAt?: string;
  },
): Promise<ContinuationGenerationRun> {
  const ts = nowIso();
  const row: ContinuationGenerationRun = {
    ...run,
    createdAt: run.createdAt ?? ts,
    updatedAt: run.updatedAt ?? ts,
    completedAt: null,
  };
  const db = await openDatabase();
  await db.executeSql(
    `INSERT INTO continuation_generation_runs (
      id, project_id, chapter_id, target_position, source_id, source_snapshot_json,
      canon_snapshot_id, canon_revision, story_memory_fingerprint,
      story_memory_through_position, input_revision_hash, user_instruction,
      settings_snapshot_json, context_snapshot_json, context_trace_json,
      token_usage_json, state, stage, completion_reason, adopted_revision_hash,
      finalized_revision_hash, error_code, error_message, created_at, updated_at, completed_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      row.id,
      row.projectId,
      row.chapterId,
      row.targetPosition,
      row.sourceId,
      row.sourceSnapshotJson,
      row.canonSnapshotId,
      row.canonRevision,
      row.storyMemoryFingerprint,
      row.storyMemoryThroughPosition,
      row.inputRevisionHash,
      row.userInstruction,
      row.settingsSnapshotJson,
      row.contextSnapshotJson,
      row.contextTraceJson,
      row.tokenUsageJson,
      row.state,
      row.stage,
      row.completionReason,
      row.adoptedRevisionHash,
      row.finalizedRevisionHash,
      row.errorCode,
      row.errorMessage,
      row.createdAt,
      row.updatedAt,
      row.completedAt,
    ],
  );
  return row;
}

export async function getRunById(
  runId: string,
): Promise<ContinuationGenerationRun | null> {
  const db = await openDatabase();
  const [res] = await db.executeSql(
    `SELECT ${RUN_METADATA_SELECT} FROM continuation_generation_runs WHERE id = ?`,
    [runId],
  );
  if (res.rows.length === 0) return null;
  return rowRun(res.rows.item(0));
}

/**
 * Streamed reader for a run's frozen context snapshot. Reads the giant
 * context_snapshot_json column in substr() chunks so the row never has to
 * fit inside the platform CursorWindow. Character semantics: SQLite length()
 * and substr() both count TEXT in characters, matching JS string concat.
 */
export async function getRunContextSnapshotJson(
  runId: string,
): Promise<string | null> {
  const payload = await readLargePayloadColumn({
    table: 'continuation_generation_runs',
    column: 'context_snapshot_json',
    whereSql: 'id = ?',
    params: [runId],
  });
  // Preserve the historical empty-snapshot contract (NULL for both a missing
  // row and a NULL/empty snapshot) while using the shared bounded reader.
  return payload ? payload : null;
}

/** Read the frozen Source snapshot only when an old caller explicitly needs it. */
export async function getRunSourceSnapshotJson(
  runId: string,
): Promise<string | null> {
  return readLargePayloadColumn({
    table: 'continuation_generation_runs',
    column: 'source_snapshot_json',
    whereSql: 'id = ?',
    params: [runId],
  });
}

/** Read the trace payload only for state transitions that must append an event. */
export async function getRunContextTraceJson(
  runId: string,
): Promise<string | null> {
  return readLargePayloadColumn({
    table: 'continuation_generation_runs',
    column: 'context_trace_json',
    whereSql: 'id = ?',
    params: [runId],
  });
}

/**
 * Explicit opt-in full run read. Normal lists/status reads stay metadata-only;
 * legacy state-machine and adoption paths use this boundary when they really
 * need the frozen snapshot and trace bodies.
 */
export async function getRunByIdWithContext(
  runId: string,
): Promise<ContinuationGenerationRun | null> {
  const run = await getRunById(runId);
  if (!run) return null;
  const [contextSnapshotJson, contextTraceJson] = await Promise.all([
    getRunContextSnapshotJson(runId),
    getRunContextTraceJson(runId),
  ]);
  return { ...run, contextSnapshotJson, contextTraceJson };
}

/**
 * The kernel trace id for a run, extracted in SQL (never loads the body).
 * Prefers the writing kernel trace field, falling back to the snapshot-level
 * id used by older snapshots.
 */
export async function getRunGenerationTraceId(
  runId: string,
): Promise<string | null> {
  const db = await openDatabase();
  const [res] = await db.executeSql(
    `SELECT
       json_extract(context_snapshot_json, '$.writingKernelTrace.generationTraceId') AS tid,
       json_extract(context_snapshot_json, '$.generationTraceId') AS fallback
     FROM continuation_generation_runs WHERE id = ?`,
    [runId],
  );
  if (res.rows.length === 0) return null;
  const row = res.rows.item(0);
  return row.tid ?? row.fallback ?? null;
}

export async function listRunsForProject(
  projectId: number,
  limit = 50,
): Promise<ContinuationGenerationRun[]> {
  const db = await openDatabase();
  const [res] = await db.executeSql(
    `SELECT ${RUN_METADATA_SELECT} FROM continuation_generation_runs
     WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`,
    [projectId, limit],
  );
  const out: ContinuationGenerationRun[] = [];
  for (let i = 0; i < res.rows.length; i++) out.push(rowRun(res.rows.item(i)));
  return out;
}

export async function listRunningRuns(): Promise<ContinuationGenerationRun[]> {
  const db = await openDatabase();
  const [res] = await db.executeSql(
    `SELECT ${RUN_METADATA_SELECT} FROM continuation_generation_runs
     WHERE state IN ('queued', 'running')`,
  );
  const out: ContinuationGenerationRun[] = [];
  for (let i = 0; i < res.rows.length; i++) out.push(rowRun(res.rows.item(i)));
  return out;
}

/**
 * Compare-and-set state transition. Returns false if expected state mismatch.
 */
export async function casUpdateRunState(
  runId: string,
  expectedStates: ContinuationRunState[],
  patch: {
    state?: ContinuationRunState;
    stage?: ContinuationStageName;
    contextSnapshotJson?: string | null;
    contextTraceJson?: string | null;
    tokenUsageJson?: string;
    completionReason?: 'adopted' | 'abandoned' | null;
    adoptedRevisionHash?: string | null;
    finalizedRevisionHash?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    completedAt?: string | null;
  },
): Promise<boolean> {
  const db = await openDatabase();
  const placeholders = expectedStates.map(() => '?').join(',');
  const sets: string[] = ['updated_at = ?'];
  const params: any[] = [nowIso()];
  if (patch.state !== undefined) {
    sets.push('state = ?');
    params.push(patch.state);
  }
  if (patch.stage !== undefined) {
    sets.push('stage = ?');
    params.push(patch.stage);
  }
  if (patch.contextSnapshotJson !== undefined) {
    sets.push('context_snapshot_json = ?');
    params.push(patch.contextSnapshotJson);
  }
  if (patch.contextTraceJson !== undefined) {
    sets.push('context_trace_json = ?');
    params.push(patch.contextTraceJson);
  }
  if (patch.tokenUsageJson !== undefined) {
    sets.push('token_usage_json = ?');
    params.push(patch.tokenUsageJson);
  }
  if (patch.completionReason !== undefined) {
    sets.push('completion_reason = ?');
    params.push(patch.completionReason);
  }
  if (patch.adoptedRevisionHash !== undefined) {
    sets.push('adopted_revision_hash = ?');
    params.push(patch.adoptedRevisionHash);
  }
  if (patch.finalizedRevisionHash !== undefined) {
    sets.push('finalized_revision_hash = ?');
    params.push(patch.finalizedRevisionHash);
  }
  if (patch.errorCode !== undefined) {
    sets.push('error_code = ?');
    params.push(patch.errorCode);
  }
  if (patch.errorMessage !== undefined) {
    sets.push('error_message = ?');
    params.push(patch.errorMessage);
  }
  if (patch.completedAt !== undefined) {
    sets.push('completed_at = ?');
    params.push(patch.completedAt);
  }
  params.push(runId, ...expectedStates);
  const [res] = await db.executeSql(
    `UPDATE continuation_generation_runs SET ${sets.join(', ')}
     WHERE id = ? AND state IN (${placeholders})`,
    params,
  );
  return (res.rowsAffected ?? 0) > 0;
}

export async function markRunsInterruptedOnColdStart(): Promise<number> {
  const db = await openDatabase();
  const ts = nowIso();
  const [runningRows] = await db.executeSql(
    `SELECT id, state, stage
      FROM continuation_generation_runs
      WHERE state IN ('queued', 'running')`,
  );
  let interruptedRuns = 0;
  for (let index = 0; index < runningRows.rows.length; index += 1) {
    const row = runningRows.rows.item(index);
    const [snapshotJson, existingContextTraceJson] = await Promise.all([
      getRunContextSnapshotJson(String(row.id)),
      getRunContextTraceJson(String(row.id)),
    ]);
    let contextTraceJson: string | null = null;
    try {
      const snapshot = JSON.parse(
        snapshotJson || '{}',
      ) as ContinuationContextSnapshot;
      const trace = existingContextTraceJson
        ? (JSON.parse(existingContextTraceJson) as ContinuationContextTrace)
        : ({
            sourceId: snapshot.source.sourceId,
            canonSnapshotId: snapshot.canon.snapshotId,
            canonRevision: snapshot.canon.revision,
            targetPosition: snapshot.targetPosition,
            entityRefs: [],
            storyMemoryFingerprint: snapshot.storyMemory.stateFingerprint,
            freshness: snapshot.bundles.effectiveState.freshness,
            categories: [],
            totalInputTokens: 0,
            reservedOutputTokens: 0,
            omittedCapabilities: [],
          } satisfies ContinuationContextTrace);
      const unified = ensureContinuationGenerationTrace(trace, snapshot, {
        runId: String(row.id),
        state: row.state as ContinuationRunState,
        stage: row.stage as ContinuationStageName,
      });
      contextTraceJson = JSON.stringify(
        appendContinuationGenerationTraceEvent(unified, {
          event: 'interrupted',
          state: 'interrupted',
          stage: row.stage as ContinuationStageName,
          reason: 'cold_start',
          finalization: {
            status: 'not_started',
            finalizedRevisionHash: null,
            completionReason: null,
          },
        }),
      );
    } catch {
      // Historical rows without a frozen snapshot remain recoverable; no
      // invented evidence is written for them.
    }
    const [updated] = await db.executeSql(
      `UPDATE continuation_generation_runs
       SET state = 'interrupted', error_code = 'cold_start',
           error_message = '应用重启，运行中断',
           context_trace_json = COALESCE(?, context_trace_json), updated_at = ?
       WHERE id = ? AND state IN ('queued', 'running')`,
      [contextTraceJson, ts, row.id],
    );
    interruptedRuns += updated.rowsAffected ?? 0;
  }
  const [outboxRes] = await db.executeSql(
    `UPDATE continuation_state_sync_outbox
     SET state = 'interrupted', updated_at = ?
     WHERE state = 'running'`,
    [ts],
  );
  return interruptedRuns + (outboxRes.rowsAffected ?? 0);
}

export async function markRunsOutdatedForProject(
  projectId: number,
  reason: string,
): Promise<void> {
  const db = await openDatabase();
  await db.executeSql(
    `UPDATE continuation_generation_runs
     SET state = 'outdated', error_code = 'outdated', error_message = ?, updated_at = ?
     WHERE project_id = ? AND state IN (
       'queued', 'running', 'awaiting_user', 'awaiting_regeneration', 'interrupted'
     )`,
    [reason, nowIso(), projectId],
  );
}

/**
 * Same-stage retries still need a distinct storage body when the caller is
 * deliberately recording another attempt. Cross-stage copies, however, are
 * exact artifacts and must retain the original body/hash (Schema 57 makes the
 * uniqueness boundary stage-local).
 */
export function withDistinctArtifactBody(
  content: string,
  salt: string,
): string {
  const stripped = content.replace(/\u200b+$/g, '').replace(/\n+$/g, '');
  return `${stripped}\n\u200b${salt}`;
}

export async function ensureUniqueArtifactContent(
  runId: string,
  content: string,
  stage?: ContinuationArtifactStage,
): Promise<string> {
  const db = await openDatabase();
  let candidate = content;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const hash = sha256Hex(candidate);
    const [res] = await db.executeSql(
      stage
        ? `SELECT id FROM continuation_generation_artifacts
           WHERE run_id = ? AND content_hash = ? AND stage = ? LIMIT 1`
        : `SELECT id FROM continuation_generation_artifacts
           WHERE run_id = ? AND content_hash = ? LIMIT 1`,
      stage ? [runId, hash, stage] : [runId, hash],
    );
    if (res.rows.length === 0) return candidate;
    candidate = withDistinctArtifactBody(content, `${attempt + 1}_${Date.now()}`);
  }
  return withDistinctArtifactBody(content, v4().replace(/-/g, ''));
}

export async function insertArtifact(input: {
  runId: string;
  stage: ContinuationArtifactStage;
  content: string;
  repairRound?: number;
  parentArtifactId?: string | null;
  eligibilityStatus?: ContinuationArtifactEligibility;
  rejectionCode?: string | null;
  /** When true, never reuse another stage's row on hash collision — uniquify instead. */
  requireStageMatch?: boolean;
}): Promise<ContinuationArtifact> {
  const createdAt = nowIso();
  const db = await openDatabase();
  let content = input.content;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const id = `ca_${v4().replace(/-/g, '')}`;
    const contentHash = sha256Hex(content);
    try {
      await db.executeSql(
        `INSERT INTO continuation_generation_artifacts (
          id, run_id, stage, repair_round, parent_artifact_id, content, content_hash,
          eligibility_status, rejection_code, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.runId,
          input.stage,
          input.repairRound ?? 0,
          input.parentArtifactId ?? null,
          content,
          contentHash,
          input.eligibilityStatus ?? 'eligible',
          input.rejectionCode ?? null,
          createdAt,
        ],
      );
      return {
        id,
        runId: input.runId,
        stage: input.stage,
        repairRound: input.repairRound ?? 0,
        parentArtifactId: input.parentArtifactId ?? null,
        content,
        contentHash,
        eligibilityStatus: input.eligibilityStatus ?? 'eligible',
        rejectionCode: input.rejectionCode ?? null,
        createdAt,
      };
    } catch (e: any) {
      // Stage-local UNIQUE(run_id, content_hash, stage) — optionally reuse an
      // existing same-stage row, else uniquify a deliberate same-stage retry.
      const [res] = await db.executeSql(
        `SELECT ${ARTIFACT_METADATA_SELECT} FROM continuation_generation_artifacts
         WHERE run_id = ? AND content_hash = ?`,
        [input.runId, contentHash],
      );
      if (res.rows.length > 0) {
        const existing = await materializeArtifactRow(res.rows.item(0));
        if (
          !input.requireStageMatch ||
          existing.stage === input.stage
        ) {
          return existing;
        }
        content = withDistinctArtifactBody(
          input.content,
          `${input.stage}_${attempt + 1}_${Date.now()}`,
        );
        continue;
      }
      throw e;
    }
  }
  throw new Error(
    `insertArtifact 无法为 stage=${input.stage} 写入唯一 content_hash`,
  );
}

export async function getLatestArtifact(
  runId: string,
): Promise<ContinuationArtifact | null> {
  const db = await openDatabase();
  const [res] = await db.executeSql(
    `SELECT ${ARTIFACT_METADATA_SELECT} FROM continuation_generation_artifacts
     WHERE run_id = ? ORDER BY created_at DESC LIMIT 1`,
    [runId],
  );
  if (res.rows.length === 0) return null;
  return materializeArtifactRow(res.rows.item(0));
}

/**
 * The only repository query intended for an adoption candidate. V4/V5 must
 * never infer eligibility from the newest created_at artifact because rejected
 * and intermediate drafts are intentionally retained for audit/recovery.
 *
 * V5 deliverable is stage=final only; intermediate V1/V2 can never be eligible.
 */
export async function getLatestEligibleArtifact(
  runId: string,
): Promise<ContinuationArtifact | null> {
  const db = await openDatabase();
  const [res] = await db.executeSql(
    `SELECT ${ARTIFACT_METADATA_SELECT} FROM continuation_generation_artifacts
     WHERE run_id = ? AND eligibility_status = 'eligible'
       AND stage IN ('writer', 'repair', 'user_edit', 'final')
     ORDER BY
       CASE stage
         WHEN 'final' THEN 0
         WHEN 'repair' THEN 1
         WHEN 'writer' THEN 2
         ELSE 3
       END,
       created_at DESC, id DESC
     LIMIT 1`,
    [runId],
  );
  if (res.rows.length === 0) return null;
  return materializeArtifactRow(res.rows.item(0));
}

/** Read the newest artifact for one producing stage. */
export async function getLatestArtifactForStage(
  runId: string,
  stage: Extract<
    ContinuationArtifact['stage'],
    'writer' | 'repair' | 'draft' | 'revision_1' | 'final'
  >,
): Promise<ContinuationArtifact | null> {
  const db = await openDatabase();
  const [res] = await db.executeSql(
    `SELECT ${ARTIFACT_METADATA_SELECT} FROM continuation_generation_artifacts
     WHERE run_id = ? AND stage = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    [runId, stage],
  );
  if (res.rows.length === 0) return null;
  return materializeArtifactRow(res.rows.item(0));
}

export async function getArtifactById(
  id: string,
): Promise<ContinuationArtifact | null> {
  const db = await openDatabase();
  const [res] = await db.executeSql(
    `SELECT ${ARTIFACT_METADATA_SELECT}
       FROM continuation_generation_artifacts WHERE id = ?`,
    [id],
  );
  if (res.rows.length === 0) return null;
  return materializeArtifactRow(res.rows.item(0));
}

/**
 * Read an artifact that MUST belong to the given run (fix-plan §7.1). The SQL
 * matches BOTH id AND run_id, so a caller passing another run's artifact id is
 * rejected at the data layer — the ownership check cannot be bypassed by a
 * stale or swapped id. Returns null if no row matches both predicates.
 */
export async function getArtifactForRun(
  runId: string,
  artifactId: string,
): Promise<ContinuationArtifact | null> {
  const db = await openDatabase();
  const [res] = await db.executeSql(
    `SELECT ${ARTIFACT_METADATA_SELECT}
       FROM continuation_generation_artifacts WHERE id = ? AND run_id = ?`,
    [artifactId, runId],
  );
  if (res.rows.length === 0) return null;
  return materializeArtifactRow(res.rows.item(0));
}

export async function getEligibleArtifactForRun(
  runId: string,
  artifactId: string,
): Promise<ContinuationArtifact | null> {
  const db = await openDatabase();
  const [res] = await db.executeSql(
    `SELECT ${ARTIFACT_METADATA_SELECT}
       FROM continuation_generation_artifacts
     WHERE id = ? AND run_id = ? AND eligibility_status = 'eligible'`,
    [artifactId, runId],
  );
  if (res.rows.length === 0) return null;
  return materializeArtifactRow(res.rows.item(0));
}

export function newContinuationStageResultId(): string {
  return `csr_${v4().replace(/-/g, '')}`;
}

export async function getStageResult(
  runId: string,
  stage: ContinuationStageResultStageName,
): Promise<ContinuationGenerationStageResult | null> {
  const db = await openDatabase();
  const [res] = await db.executeSql(
    `SELECT ${STAGE_RESULT_METADATA_SELECT}
       FROM continuation_generation_stage_results
     WHERE run_id = ? AND stage = ?`,
    [runId, stage],
  );
  if (res.rows.length === 0) return null;
  return materializeStageResultRow(res.rows.item(0));
}

export async function listStageResults(
  runId: string,
): Promise<ContinuationGenerationStageResult[]> {
  const db = await openDatabase();
  const [res] = await db.executeSql(
    `SELECT ${STAGE_RESULT_METADATA_SELECT}
       FROM continuation_generation_stage_results
     WHERE run_id = ?
     ORDER BY CASE stage
       WHEN 'writer' THEN 1
       WHEN 'checker' THEN 2
       WHEN 'control' THEN 3
       WHEN 'repair' THEN 4
       WHEN 'local_verify' THEN 5
       WHEN 'draft_writer' THEN 11
       WHEN 'narrative_architect' THEN 12
       WHEN 'revision_writer' THEN 13
       WHEN 'adversarial_auditor' THEN 14
       WHEN 'final_reviser' THEN 15
       WHEN 'final_validate' THEN 16
       ELSE 50
     END`,
    [runId],
  );
  const rows: any[] = [];
  for (let i = 0; i < res.rows.length; i += 1) rows.push(res.rows.item(i));
  return Promise.all(rows.map(materializeStageResultRow));
}

/**
 * Create the complete V4 stage ledger before the first physical request.
 * Physical stages remain queued until reserveContinuationStage claims them;
 * local_verify is explicitly zero-request and is therefore queued with
 * request_reserved=0/request_count=0 from the start. INSERT OR IGNORE makes
 * cold-start/resume initialization idempotent.
 */
export async function ensureContinuationV4StageResults(input: {
  runId: string;
  stages: Record<
    Exclude<ContinuationV4StageName, 'local_verify'>,
    Pick<
      ContinuationV4StageBudget,
      'configId' | 'compiledPromptTokens' | 'minimumOutputTokens' | 'maximumOutputTokens'
    >
  >;
}): Promise<ContinuationGenerationStageResult[]> {
  const db = await openDatabase();
  const ts = nowIso();
  const physicalStages: Array<
    Exclude<ContinuationV4StageName, 'local_verify'>
  > = ['writer', 'checker', 'control', 'repair'];
  const statements = physicalStages.map(stage => {
    const budget = input.stages[stage];
    return {
      sql: `INSERT OR IGNORE INTO continuation_generation_stage_results (
        id, run_id, stage, status, request_reserved, request_count,
        model_config_id, input_tokens, min_output_tokens, max_output_tokens,
        output_json, artifact_id, error_code, error_message,
        started_at, completed_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'queued', 0, 0, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      params: [
        newContinuationStageResultId(),
        input.runId,
        stage,
        budget.configId,
        budget.minimumOutputTokens,
        budget.maximumOutputTokens,
        ts,
        ts,
      ],
    };
  });
  statements.push({
    sql: `INSERT OR IGNORE INTO continuation_generation_stage_results (
      id, run_id, stage, status, request_reserved, request_count,
      model_config_id, input_tokens, min_output_tokens, max_output_tokens,
      output_json, artifact_id, error_code, error_message,
      started_at, completed_at, created_at, updated_at
    ) VALUES (?, ?, 'local_verify', 'queued', 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    params: [newContinuationStageResultId(), input.runId, ts, ts],
  });
  await executeTransaction(db, statements);
  return listStageResults(input.runId);
}

export interface ContinuationStageReservation {
  runId: string;
  stage: ContinuationStageResultStageName;
  modelConfigId: number | null;
  inputTokens: number | null;
  minOutputTokens: number | null;
  maxOutputTokens: number | null;
}

/**
 * Reserve exactly one physical request for a V4 stage. A persisted row is
 * authoritative on resume: a reservation with request_count=1 is never
 * silently replaced by another request.
 */
export async function reserveContinuationStage(
  input: ContinuationStageReservation,
): Promise<{
  reserved: boolean;
  result: ContinuationGenerationStageResult;
}> {
  const db = await openDatabase();
  const existing = await getStageResult(input.runId, input.stage);
  if (existing) {
    // V4 initializes physical rows as queued. Claim that placeholder exactly
    // once; any already-reserved/failed/interrupted row is authoritative and
    // must never be retried on resume.
    if (
      existing.status !== 'queued' ||
      existing.requestReserved ||
      existing.requestCount !== 0
    ) {
      return { reserved: false, result: existing };
    }
    const ts = nowIso();
    const [claim] = await db.executeSql(
      `UPDATE continuation_generation_stage_results SET
        status = 'running', request_reserved = 1, request_count = 1,
        model_config_id = ?, input_tokens = ?, min_output_tokens = ?,
        max_output_tokens = ?, started_at = ?, updated_at = ?
       WHERE run_id = ? AND stage = ? AND status = 'queued'
         AND request_reserved = 0 AND request_count = 0`,
      [
        input.modelConfigId,
        input.inputTokens,
        input.minOutputTokens,
        input.maxOutputTokens,
        ts,
        ts,
        input.runId,
        input.stage,
      ],
    );
    if ((claim.rowsAffected ?? 0) === 1) {
      const claimed = await getStageResult(input.runId, input.stage);
      if (!claimed) throw new Error('续写阶段 queued reservation 写入后无法读取');
      return { reserved: true, result: claimed };
    }
    const winner = await getStageResult(input.runId, input.stage);
    if (winner) return { reserved: false, result: winner };
    throw new Error('续写阶段 queued reservation 竞争后无法读取结果');
  }

  const id = newContinuationStageResultId();
  const ts = nowIso();
  try {
    await db.executeSql(
      `INSERT INTO continuation_generation_stage_results (
        id, run_id, stage, status, request_reserved, request_count,
        model_config_id, input_tokens, min_output_tokens, max_output_tokens,
        started_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'running', 1, 1, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.runId,
        input.stage,
        input.modelConfigId,
        input.inputTokens,
        input.minOutputTokens,
        input.maxOutputTokens,
        ts,
        ts,
        ts,
      ],
    );
  } catch (error) {
    // UNIQUE(run_id, stage): another resume won the reservation race.
    const winner = await getStageResult(input.runId, input.stage);
    if (winner) return { reserved: false, result: winner };
    throw error;
  }
  const result = await getStageResult(input.runId, input.stage);
  if (!result) throw new Error('续写阶段 reservation 写入后无法读取');
  return { reserved: true, result };
}

export interface ContinuationStageResultPatch {
  runId: string;
  stage: ContinuationStageResultStageName;
  status: ContinuationStageResultStatus;
  outputJson?: string | null;
  artifactId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  completedAt?: string | null;
}

/**
 * Create the complete V5 stage ledger before the first physical request.
 * final_validate is zero-request from the start.
 */
export async function ensureContinuationV5StageResults(input: {
  runId: string;
  stages: Record<
    ContinuationV5PhysicalNode,
    {
      configId: number;
      compiledPromptTokens: number;
      minimumOutputTokens: number;
      maximumOutputTokens: number;
    }
  >;
  /**
   * Phase 6 §6.2 — the compact Standard continuation ledger must NOT contain
   * legacy fake never-dispatched rows. When true only `draft_writer`,
   * `revision_writer` and `unified_qa` (+ `final_validate`) are created;
   * `narrative_architect` / `adversarial_auditor` / `final_reviser` are
   * omitted entirely for the compact production path. Legacy resume passes
   * false to keep the historical full V5 ledger.
   */
  compactOnly?: boolean;
}): Promise<ContinuationGenerationStageResult[]> {
  const db = await openDatabase();
  const ts = nowIso();
  const ALL_PHYSICAL: ContinuationV5PhysicalNode[] = [
    'draft_writer',
    'narrative_architect',
    'revision_writer',
    'adversarial_auditor',
    // Phase 4 §7.2: the unified_qa node is the compact Standard V5 ledger
    // entry. It reuses the auditor's budget envelope so legacy and compact
    // share the same token envelope math.
    'unified_qa',
    'final_reviser',
  ];
  const physicalStages: ContinuationV5PhysicalNode[] = input.compactOnly
    ? ['draft_writer', 'revision_writer', 'unified_qa']
    : ALL_PHYSICAL;
  const statements = physicalStages.map(stage => {
    const budget = input.stages[stage];
    return {
      sql: `INSERT OR IGNORE INTO continuation_generation_stage_results (
        id, run_id, stage, status, request_reserved, request_count,
        model_config_id, input_tokens, min_output_tokens, max_output_tokens,
        output_json, artifact_id, error_code, error_message,
        started_at, completed_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'queued', 0, 0, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      params: [
        newContinuationStageResultId(),
        input.runId,
        stage,
        budget.configId,
        budget.minimumOutputTokens,
        budget.maximumOutputTokens,
        ts,
        ts,
      ],
    };
  });
  statements.push({
    sql: `INSERT OR IGNORE INTO continuation_generation_stage_results (
      id, run_id, stage, status, request_reserved, request_count,
      model_config_id, input_tokens, min_output_tokens, max_output_tokens,
      output_json, artifact_id, error_code, error_message,
      started_at, completed_at, created_at, updated_at
    ) VALUES (?, ?, 'final_validate', 'queued', 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    params: [newContinuationStageResultId(), input.runId, ts, ts],
  });
  await executeTransaction(db, statements);
  return listStageResults(input.runId);
}

/** Atomically settle V5 Final Reviser + Final Validator boundary. */
export async function finalizeContinuationV5Final(input: {
  runId: string;
  finalReviserStageResultId: string;
  finalValidateStageResultId: string;
  parentArtifactId: string;
  content: string;
  eligibilityStatus: Extract<
    ContinuationArtifactEligibility,
    'eligible' | 'rejected'
  >;
  rejectionCode?: string | null;
  tokenUsageJson: string;
  outputTokens?: number | null;
  finalReviserOutputJson?: string | null;
  finalValidateOutputJson?: string | null;
  finalValidateStatus?: Extract<
    ContinuationStageResultStatus,
    'success' | 'failed'
  >;
  /** Optional unified Trace snapshot written in the same settlement transaction. */
  contextTraceJson?: string | null;
  runState?: Extract<
    ContinuationRunState,
    'awaiting_user' | 'awaiting_regeneration'
  >;
  errorCode?: string | null;
  errorMessage?: string | null;
  expectedRunStates?: ContinuationRunState[];
  ts?: string;
}): Promise<{
  artifact: ContinuationArtifact;
  finalReviserStageResult: ContinuationGenerationStageResult;
  finalValidateStageResult: ContinuationGenerationStageResult;
}> {
  const db = await openDatabase();
  const ts = input.ts ?? nowIso();
  const artifactId = `ca_${v4().replace(/-/g, '')}`;
  // V3 Final may equal V2 Revision/Draft; Schema 57 keeps that body exact.
  const uniqueContent = await ensureUniqueArtifactContent(
    input.runId,
    input.content,
    'final',
  );
  const contentHash = sha256Hex(uniqueContent);
  const expectedStates = input.expectedRunStates ?? ['running'];
  const statePlaceholders = expectedStates.map(() => '?').join(', ');
  const runState = input.runState ?? 'awaiting_user';
  const statements: Array<{ sql: string; params?: any[] }> = [
    {
      sql: `INSERT INTO continuation_generation_artifacts (
        id, run_id, stage, repair_round, parent_artifact_id, content,
        content_hash, eligibility_status, rejection_code, created_at
      ) VALUES (?, ?, 'final', 2, ?, ?, ?, ?, ?, ?)`,
      params: [
        artifactId,
        input.runId,
        input.parentArtifactId,
        uniqueContent,
        contentHash,
        input.eligibilityStatus,
        input.rejectionCode ?? null,
        ts,
      ],
    },
  ];
  const reviserUpdateIndex = statements.length + 1;
  statements.push({
    sql: `UPDATE continuation_generation_stage_results SET
        status = 'success', output_json = ?, artifact_id = ?, output_tokens = ?,
        completed_at = ?, updated_at = ?
      WHERE id = ? AND run_id = ? AND stage = 'final_reviser'
        AND request_reserved = 1 AND request_count = 1`,
    params: [
      input.finalReviserOutputJson ?? null,
      artifactId,
      input.outputTokens ?? null,
      ts,
      ts,
      input.finalReviserStageResultId,
      input.runId,
    ],
  });
  const validateUpdateIndex = statements.length + 1;
  statements.push({
    sql: `UPDATE continuation_generation_stage_results SET
        status = ?, output_json = ?, artifact_id = ?,
        error_code = ?, error_message = ?,
        completed_at = ?, updated_at = ?
      WHERE id = ? AND run_id = ? AND stage = 'final_validate'
        AND request_reserved = 0 AND request_count = 0`,
    params: [
      input.finalValidateStatus ??
        (input.eligibilityStatus === 'eligible' ? 'success' : 'failed'),
      input.finalValidateOutputJson ?? null,
      artifactId,
      input.rejectionCode ?? null,
      input.errorMessage ?? null,
      ts,
      ts,
      input.finalValidateStageResultId,
      input.runId,
    ],
  });
  statements.push({
    sql: `UPDATE continuation_generation_runs SET
        state = ?, stage = 'awaiting_user',
        token_usage_json = ?, error_code = ?, error_message = ?,
        context_trace_json = COALESCE(?, context_trace_json), updated_at = ?
      WHERE id = ? AND state IN (${statePlaceholders})`,
    params: [
      runState,
      input.tokenUsageJson,
      input.errorCode ?? input.rejectionCode ?? null,
      input.errorMessage ?? null,
      input.contextTraceJson ?? null,
      ts,
      input.runId,
      ...expectedStates,
    ],
  });
  const finalUpdateIndex = statements.length;
  await executeTransaction(db, statements, {
    onStatementComplete: (oneBasedIndex, rowsAffected) => {
      if (
        (oneBasedIndex === reviserUpdateIndex ||
          oneBasedIndex === validateUpdateIndex) &&
        rowsAffected !== 1
      ) {
        throw new Error('续写 V5 finalize 缺少有效 stage result，事务回滚');
      }
      if (oneBasedIndex === finalUpdateIndex && rowsAffected !== 1) {
        throw new Error('续写 V5 finalize 发现 run 状态已变化，事务回滚');
      }
    },
  });
  const artifact = await getArtifactById(artifactId);
  const finalReviserStageResult = await getStageResult(
    input.runId,
    'final_reviser',
  );
  const finalValidateStageResult = await getStageResult(
    input.runId,
    'final_validate',
  );
  if (!artifact || !finalReviserStageResult || !finalValidateStageResult) {
    throw new Error('续写 V5 finalize 提交后读取结果失败');
  }
  return { artifact, finalReviserStageResult, finalValidateStageResult };
}

/** Resume-only: re-run validator decision on an existing V3 artifact. */
export async function finalizeContinuationV5ValidatorOnly(input: {
  runId: string;
  finalArtifactId: string;
  finalValidateStageResultId: string;
  eligibilityStatus: Extract<
    ContinuationArtifactEligibility,
    'eligible' | 'rejected'
  >;
  rejectionCode?: string | null;
  finalValidateOutputJson?: string | null;
  tokenUsageJson: string;
  runState?: Extract<
    ContinuationRunState,
    'awaiting_user' | 'awaiting_regeneration'
  >;
  errorCode?: string | null;
  errorMessage?: string | null;
  /** Optional unified Trace snapshot written in the same settlement transaction. */
  contextTraceJson?: string | null;
  expectedRunStates?: ContinuationRunState[];
  ts?: string;
}): Promise<ContinuationGenerationStageResult> {
  const db = await openDatabase();
  const ts = input.ts ?? nowIso();
  const expectedStates = input.expectedRunStates ?? ['running'];
  const statePlaceholders = expectedStates.map(() => '?').join(', ');
  const runState = input.runState ?? 'awaiting_user';
  const statements: Array<{ sql: string; params?: any[] }> = [
    {
      sql: `UPDATE continuation_generation_artifacts SET
        eligibility_status = ?, rejection_code = ?
        WHERE id = ? AND run_id = ? AND stage = 'final'`,
      params: [
        input.eligibilityStatus,
        input.rejectionCode ?? null,
        input.finalArtifactId,
        input.runId,
      ],
    },
    {
      sql: `UPDATE continuation_generation_stage_results SET
        status = ?, output_json = ?, artifact_id = ?,
        error_code = ?, error_message = ?,
        completed_at = ?, updated_at = ?
      WHERE id = ? AND run_id = ? AND stage = 'final_validate'
        AND request_reserved = 0 AND request_count = 0`,
      params: [
        input.eligibilityStatus === 'eligible' ? 'success' : 'failed',
        input.finalValidateOutputJson ?? null,
        input.finalArtifactId,
        input.rejectionCode ?? null,
        input.errorMessage ?? null,
        ts,
        ts,
        input.finalValidateStageResultId,
        input.runId,
      ],
    },
    {
      sql: `UPDATE continuation_generation_runs SET
        state = ?, stage = 'awaiting_user',
        token_usage_json = ?, error_code = ?, error_message = ?,
        context_trace_json = COALESCE(?, context_trace_json), updated_at = ?
      WHERE id = ? AND state IN (${statePlaceholders})`,
      params: [
        runState,
        input.tokenUsageJson,
        input.errorCode ?? input.rejectionCode ?? null,
        input.errorMessage ?? null,
        input.contextTraceJson ?? null,
        ts,
        input.runId,
        ...expectedStates,
      ],
    },
  ];
  await executeTransaction(db, statements);
  const result = await getStageResult(input.runId, 'final_validate');
  if (!result) throw new Error('续写 V5 validator-only finalize 读取失败');
  return result;
}

export async function updateStageResult(
  input: ContinuationStageResultPatch,
): Promise<ContinuationGenerationStageResult | null> {
  const db = await openDatabase();
  const completedAt = input.completedAt ?? nowIso();
  await db.executeSql(
    `UPDATE continuation_generation_stage_results SET
       status = ?, output_json = ?, artifact_id = ?,
       input_tokens = COALESCE(?, input_tokens),
       output_tokens = COALESCE(?, output_tokens),
       error_code = ?, error_message = ?, completed_at = ?, updated_at = ?
     WHERE run_id = ? AND stage = ? AND request_count BETWEEN 0 AND 1`,
    [
      input.status,
      input.outputJson ?? null,
      input.artifactId ?? null,
      input.inputTokens ?? null,
      input.outputTokens ?? null,
      input.errorCode ?? null,
      input.errorMessage ?? null,
      completedAt,
      nowIso(),
      input.runId,
      input.stage,
    ],
  );
  return getStageResult(input.runId, input.stage);
}

export interface ContinuationV4LocalCheckInput {
  category: CheckCategory;
  subtype: string;
  severity: CheckSeverity;
  confidence: number;
  generatedStart: number | null;
  generatedEnd: number | null;
  generatedExcerpt: string;
  description: string;
  entityRefType?: string | null;
  entityRefId?: string | null;
  evidenceIds?: number[];
  suggestedFix?: string | null;
}

export interface ContinuationV4FinalizeInput {
  runId: string;
  expectedRunStates?: ContinuationRunState[];
  repairStageResultId: string;
  localVerifyStageResultId: string;
  parentArtifactId: string;
  content: string;
  repairRound?: number;
  eligibilityStatus: ContinuationArtifactEligibility;
  rejectionCode?: string | null;
  localChecks?: ContinuationV4LocalCheckInput[];
  writerArtifactId: string;
  markWriterChecksObsolete: boolean;
  tokenUsageJson: string;
  outputTokens?: number | null;
  repairOutputJson?: string | null;
  localVerifyOutputJson?: string | null;
  localVerifyStatus?: Extract<ContinuationStageResultStatus, 'success' | 'failed'>;
  ts?: string;
}

/**
 * Atomically persist a completed Repair + Local Final Gate boundary.
 * Everything that could have failed before this call (LLM, parsing and local
 * calculations) is intentionally passed in as data. The transaction itself
 * performs no network, file, Canon or asynchronous selection work.
 */
export async function finalizeContinuationV4Repair(
  input: ContinuationV4FinalizeInput,
): Promise<{
  artifact: ContinuationArtifact;
  repairStageResult: ContinuationGenerationStageResult;
  localVerifyStageResult: ContinuationGenerationStageResult;
}> {
  const db = await openDatabase();
  const ts = input.ts ?? nowIso();
  const artifactId = `ca_${v4().replace(/-/g, '')}`;
  const contentHash = sha256Hex(input.content);
  const expectedStates = input.expectedRunStates ?? ['running'];
  const statePlaceholders = expectedStates.map(() => '?').join(', ');
  const statements: Array<{ sql: string; params?: any[] }> = [
    {
      sql: `INSERT INTO continuation_generation_artifacts (
        id, run_id, stage, repair_round, parent_artifact_id, content,
        content_hash, eligibility_status, rejection_code, created_at
      ) VALUES (?, ?, 'repair', ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        artifactId,
        input.runId,
        input.repairRound ?? 0,
        input.parentArtifactId,
        input.content,
        contentHash,
        input.eligibilityStatus,
        input.rejectionCode ?? null,
        ts,
      ],
    },
  ];

  for (const check of input.localChecks ?? []) {
    statements.push({
      sql: `INSERT INTO continuation_check_results (
        run_id, chapter_id, artifact_id, artifact_hash, category, subtype,
        severity, confidence, generated_start, generated_end,
        generated_excerpt, description, entity_ref_type, entity_ref_id,
        evidence_ids_json, suggested_fix, resolution_status, created_at,
        updated_at
      ) SELECT ?, r.chapter_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        'open', ?, ?
      FROM continuation_generation_runs r WHERE r.id = ?`,
      params: [
        input.runId,
        artifactId,
        contentHash,
        check.category,
        check.subtype,
        check.severity,
        check.confidence,
        check.generatedStart,
        check.generatedEnd,
        check.generatedExcerpt,
        check.description,
        check.entityRefType ?? null,
        check.entityRefId ?? null,
        JSON.stringify(check.evidenceIds ?? []),
        check.suggestedFix ?? null,
        ts,
        ts,
        input.runId,
      ],
    });
  }

  if (input.markWriterChecksObsolete) {
    statements.push({
      sql: `UPDATE continuation_check_results
        SET resolution_status = 'obsolete', updated_at = ?
        WHERE run_id = ? AND artifact_id = ? AND resolution_status = 'open'`,
      params: [ts, input.runId, input.writerArtifactId],
    });
  }

  const localVerifyStatus = input.localVerifyStatus ?? 'success';
  const repairStageUpdateIndex = statements.length + 1;
  statements.push({
    sql: `UPDATE continuation_generation_stage_results SET
        status = 'success', output_json = ?, artifact_id = ?, output_tokens = ?,
        completed_at = ?, updated_at = ?
      WHERE id = ? AND run_id = ? AND stage = 'repair'
        AND request_reserved = 1 AND request_count = 1`,
    params: [
      input.repairOutputJson ?? null,
      artifactId,
      input.outputTokens ?? null,
      ts,
      ts,
      input.repairStageResultId,
      input.runId,
    ],
  });
  const localVerifyUpdateIndex = statements.length + 1;
  statements.push({
    sql: `UPDATE continuation_generation_stage_results SET
        status = ?, output_json = ?, artifact_id = ?,
        completed_at = ?, updated_at = ?
      WHERE id = ? AND run_id = ? AND stage = 'local_verify'
        AND request_reserved = 0 AND request_count = 0`,
    params: [
      localVerifyStatus,
      input.localVerifyOutputJson ?? null,
      artifactId,
      ts,
      ts,
      input.localVerifyStageResultId,
      input.runId,
    ],
  });

  statements.push({
    sql: `UPDATE continuation_generation_runs SET
        state = 'awaiting_user', stage = 'awaiting_user',
        token_usage_json = ?, updated_at = ?
      WHERE id = ? AND state IN (${statePlaceholders})`,
    params: [input.tokenUsageJson, ts, input.runId, ...expectedStates],
  });

  const finalUpdateIndex = statements.length;
  await executeTransaction(db, statements, {
    onStatementComplete: (oneBasedIndex, rowsAffected) => {
      if (
        (oneBasedIndex === repairStageUpdateIndex ||
          oneBasedIndex === localVerifyUpdateIndex) &&
        rowsAffected !== 1
      ) {
        throw new Error('续写 V4 finalize 缺少有效 stage result，事务回滚');
      }
      if (oneBasedIndex === finalUpdateIndex && rowsAffected !== 1) {
        throw new Error('续写 V4 finalize 发现 run 状态已变化，事务回滚');
      }
    },
  });

  const artifact = await getArtifactById(artifactId);
  const repairStageResult = await getStageResult(input.runId, 'repair');
  const localVerifyStageResult = await getStageResult(
    input.runId,
    'local_verify',
  );
  if (!artifact || !repairStageResult || !localVerifyStageResult) {
    throw new Error('续写 V4 finalize 提交后读取结果失败');
  }
  return { artifact, repairStageResult, localVerifyStageResult };
}

export interface ContinuationV4RepairRejectionInput {
  runId: string;
  expectedRunStates?: ContinuationRunState[];
  repairStageResultId: string;
  localVerifyStageResultId: string;
  writerArtifactId: string;
  writerArtifactHash: string;
  rejectionCode: string;
  rejectionMessage: string;
  localChecks?: ContinuationV4LocalCheckInput[];
  tokenUsageJson: string;
  outputTokens?: number | null;
  repairOutputJson?: string | null;
  localVerifyOutputJson?: string | null;
  ts?: string;
}

/**
 * Atomically settle a Repair response that cannot become a second artifact.
 *
 * The artifact table deliberately de-duplicates identical content within a
 * run. If Repair returns the Writer content unchanged, inserting a second
 * row would violate that invariant. Persist the rejection and local checks on
 * the existing Writer artifact instead, so the consumed request is auditable
 * and the Writer remains the only eligible candidate.
 */
export async function finalizeContinuationV4RepairRejection(
  input: ContinuationV4RepairRejectionInput,
): Promise<{
  repairStageResult: ContinuationGenerationStageResult;
  localVerifyStageResult: ContinuationGenerationStageResult;
}> {
  const db = await openDatabase();
  const ts = input.ts ?? nowIso();
  const expectedStates = input.expectedRunStates ?? ['running'];
  const statePlaceholders = expectedStates.map(() => '?').join(', ');
  const statements: Array<{ sql: string; params?: any[] }> = [];

  for (const check of input.localChecks ?? []) {
    statements.push({
      sql: `INSERT INTO continuation_check_results (
        run_id, chapter_id, artifact_id, artifact_hash, category, subtype,
        severity, confidence, generated_start, generated_end,
        generated_excerpt, description, entity_ref_type, entity_ref_id,
        evidence_ids_json, suggested_fix, resolution_status, created_at,
        updated_at
      ) SELECT ?, r.chapter_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        'open', ?, ?
      FROM continuation_generation_runs r
      WHERE r.id = ?`,
      params: [
        input.runId,
        input.writerArtifactId,
        input.writerArtifactHash,
        check.category,
        check.subtype,
        check.severity,
        check.confidence,
        check.generatedStart,
        check.generatedEnd,
        check.generatedExcerpt,
        check.description,
        check.entityRefType ?? null,
        check.entityRefId ?? null,
        JSON.stringify(check.evidenceIds ?? []),
        check.suggestedFix ?? null,
        ts,
        ts,
        input.runId,
      ],
    });
  }

  const repairStageUpdateIndex = statements.length + 1;
  statements.push({
    sql: `UPDATE continuation_generation_stage_results SET
        status = 'failed', output_json = ?, artifact_id = NULL, output_tokens = ?,
        error_code = ?, error_message = ?, completed_at = ?, updated_at = ?
      WHERE id = ? AND run_id = ? AND stage = 'repair'
        AND request_reserved = 1 AND request_count = 1`,
    params: [
      input.repairOutputJson ?? null,
      input.outputTokens ?? null,
      input.rejectionCode,
      input.rejectionMessage,
      ts,
      ts,
      input.repairStageResultId,
      input.runId,
    ],
  });

  const localVerifyUpdateIndex = statements.length + 1;
  statements.push({
    sql: `UPDATE continuation_generation_stage_results SET
        status = 'failed', output_json = ?, artifact_id = ?,
        error_code = ?, error_message = ?, completed_at = ?, updated_at = ?
      WHERE id = ? AND run_id = ? AND stage = 'local_verify'
        AND request_reserved = 0 AND request_count = 0`,
    params: [
      input.localVerifyOutputJson ?? null,
      input.writerArtifactId,
      input.rejectionCode,
      input.rejectionMessage,
      ts,
      ts,
      input.localVerifyStageResultId,
      input.runId,
    ],
  });

  statements.push({
    sql: `UPDATE continuation_generation_runs SET
        state = 'awaiting_user', stage = 'awaiting_user',
        token_usage_json = ?, error_code = ?, error_message = ?, updated_at = ?
      WHERE id = ? AND state IN (${statePlaceholders})`,
    params: [
      input.tokenUsageJson,
      input.rejectionCode,
      input.rejectionMessage,
      ts,
      input.runId,
      ...expectedStates,
    ],
  });
  const finalUpdateIndex = statements.length;

  await executeTransaction(db, statements, {
    onStatementComplete: (oneBasedIndex, rowsAffected) => {
      if (
        (oneBasedIndex === repairStageUpdateIndex ||
          oneBasedIndex === localVerifyUpdateIndex) &&
        rowsAffected !== 1
      ) {
        throw new Error('续写 V4 Repair rejection 缺少有效 stage result，事务回滚');
      }
      if (oneBasedIndex === finalUpdateIndex && rowsAffected !== 1) {
        throw new Error('续写 V4 Repair rejection 发现 run 状态已变化，事务回滚');
      }
    },
  });

  const repairStageResult = await getStageResult(input.runId, 'repair');
  const localVerifyStageResult = await getStageResult(
    input.runId,
    'local_verify',
  );
  if (!repairStageResult || !localVerifyStageResult) {
    throw new Error('续写 V4 Repair rejection 提交后读取结果失败');
  }
  return { repairStageResult, localVerifyStageResult };
}

export interface ContinuationV4LocalGateInput {
  runId: string;
  repairArtifactId: string;
  localVerifyStageResultId: string;
  writerArtifactId: string;
  eligibilityStatus: ContinuationArtifactEligibility;
  rejectionCode?: string | null;
  localChecks?: ContinuationV4LocalCheckInput[];
  markWriterChecksObsolete: boolean;
  localVerifyOutputJson?: string | null;
  localVerifyStatus?: Extract<ContinuationStageResultStatus, 'success' | 'failed'>;
  tokenUsageJson: string;
  expectedRunStates?: ContinuationRunState[];
  ts?: string;
}

/**
 * Resume boundary for a Repair artifact that was persisted before the app was
 * stopped. No LLM or Canon read occurs here: only the local gate result,
 * eligibility, checks and run CAS are committed atomically.
 */
export async function finalizeContinuationV4LocalGate(
  input: ContinuationV4LocalGateInput,
): Promise<{
  artifact: ContinuationArtifact;
  localVerifyStageResult: ContinuationGenerationStageResult;
}> {
  const db = await openDatabase();
  const ts = input.ts ?? nowIso();
  const expectedStates = input.expectedRunStates ?? ['running'];
  const statePlaceholders = expectedStates.map(() => '?').join(', ');
  const statements: Array<{ sql: string; params?: any[] }> = [
    {
      sql: `UPDATE continuation_generation_artifacts SET
        eligibility_status = ?, rejection_code = ?
        WHERE id = ? AND run_id = ? AND stage = 'repair'`,
      params: [
        input.eligibilityStatus,
        input.rejectionCode ?? null,
        input.repairArtifactId,
        input.runId,
      ],
    },
  ];
  for (const check of input.localChecks ?? []) {
    statements.push({
      sql: `INSERT INTO continuation_check_results (
        run_id, chapter_id, artifact_id, artifact_hash, category, subtype,
        severity, confidence, generated_start, generated_end,
        generated_excerpt, description, entity_ref_type, entity_ref_id,
        evidence_ids_json, suggested_fix, resolution_status, created_at,
        updated_at
      ) SELECT ?, r.chapter_id, a.id, a.content_hash, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        'open', ?, ?
      FROM continuation_generation_runs r
      JOIN continuation_generation_artifacts a ON a.id = ? AND a.run_id = r.id
      WHERE r.id = ?`,
      params: [
        input.runId,
        check.category,
        check.subtype,
        check.severity,
        check.confidence,
        check.generatedStart,
        check.generatedEnd,
        check.generatedExcerpt,
        check.description,
        check.entityRefType ?? null,
        check.entityRefId ?? null,
        JSON.stringify(check.evidenceIds ?? []),
        check.suggestedFix ?? null,
        ts,
        ts,
        input.repairArtifactId,
        input.runId,
      ],
    });
  }
  if (input.markWriterChecksObsolete) {
    statements.push({
      sql: `UPDATE continuation_check_results SET
        resolution_status = 'obsolete', updated_at = ?
        WHERE run_id = ? AND artifact_id = ? AND resolution_status = 'open'`,
      params: [ts, input.runId, input.writerArtifactId],
    });
  }
  const localVerifyStatus = input.localVerifyStatus ?? 'success';
  const localVerifyUpdateIndex = statements.length + 1;
  statements.push({
    sql: `UPDATE continuation_generation_stage_results SET
      status = ?, output_json = ?, artifact_id = ?,
      completed_at = ?, updated_at = ?
      WHERE id = ? AND run_id = ? AND stage = 'local_verify'
        AND request_reserved = 0 AND request_count = 0`,
    params: [
      localVerifyStatus,
      input.localVerifyOutputJson ?? null,
      input.repairArtifactId,
      ts,
      ts,
      input.localVerifyStageResultId,
      input.runId,
    ],
  });
  statements.push({
    sql: `UPDATE continuation_generation_runs SET
      state = 'awaiting_user', stage = 'awaiting_user',
      token_usage_json = ?, updated_at = ?
      WHERE id = ? AND state IN (${statePlaceholders})`,
    params: [input.tokenUsageJson, ts, input.runId, ...expectedStates],
  });
  const finalUpdateIndex = statements.length;
  await executeTransaction(db, statements, {
    onStatementComplete: (oneBasedIndex, rowsAffected) => {
      if (oneBasedIndex === 1 && rowsAffected !== 1) {
        throw new Error('续写 V4 local gate 找不到 Repair artifact，事务回滚');
      }
      if (oneBasedIndex === localVerifyUpdateIndex && rowsAffected !== 1) {
        throw new Error('续写 V4 local gate 缺少 queued local_verify，事务回滚');
      }
      if (oneBasedIndex === finalUpdateIndex && rowsAffected !== 1) {
        throw new Error('续写 V4 local gate 发现 run 状态已变化，事务回滚');
      }
    },
  });
  const artifact = await getArtifactById(input.repairArtifactId);
  const localVerifyStageResult = await getStageResult(input.runId, 'local_verify');
  if (!artifact || !localVerifyStageResult) {
    throw new Error('续写 V4 local gate 提交后读取结果失败');
  }
  return { artifact, localVerifyStageResult };
}

export async function savePlan(
  runId: string,
  plan: ContinuationPlan,
  confirmationStatus: 'not_required' | 'pending' | 'confirmed' | 'rejected',
): Promise<{ planHash: string }> {
  const planJson = JSON.stringify(plan);
  const planHash = sha256Hex(planJson);
  const db = await openDatabase();
  await db.executeSql(
    `INSERT OR REPLACE INTO continuation_plans (
      run_id, schema_version, plan_json, plan_hash, confirmation_status, confirmed_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      runId,
      plan.schemaVersion,
      planJson,
      planHash,
      confirmationStatus,
      confirmationStatus === 'confirmed' ? nowIso() : null,
      nowIso(),
    ],
  );
  return { planHash };
}

export async function getPlan(runId: string): Promise<{
  plan: ContinuationPlan;
  planHash: string;
  confirmationStatus: string;
} | null> {
  const db = await openDatabase();
  const [res] = await db.executeSql(
    'SELECT * FROM continuation_plans WHERE run_id = ?',
    [runId],
  );
  if (res.rows.length === 0) return null;
  const r = res.rows.item(0);
  return {
    plan: JSON.parse(r.plan_json) as ContinuationPlan,
    planHash: r.plan_hash,
    confirmationStatus: r.confirmation_status,
  };
}

export async function insertCheckResults(
  rows: Array<{
    runId: string;
    chapterId: number;
    artifactId: string;
    artifactHash: string;
    category: CheckCategory;
    subtype: string;
    severity: CheckSeverity;
    confidence: number;
    generatedStart: number | null;
    generatedEnd: number | null;
    generatedExcerpt: string;
    description: string;
    entityRefType?: string | null;
    entityRefId?: string | null;
    evidenceIds?: number[];
    suggestedFix?: string | null;
  }>,
): Promise<void> {
  if (rows.length === 0) return;
  const db = await openDatabase();
  const ts = nowIso();
  const statements = rows.map(r => ({
    sql: `INSERT INTO continuation_check_results (
      run_id, chapter_id, artifact_id, artifact_hash, category, subtype,
      severity, confidence, generated_start, generated_end, generated_excerpt,
      description, entity_ref_type, entity_ref_id, evidence_ids_json,
      suggested_fix, resolution_status, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    params: [
      r.runId,
      r.chapterId,
      r.artifactId,
      r.artifactHash,
      r.category,
      r.subtype,
      r.severity,
      r.confidence,
      r.generatedStart,
      r.generatedEnd,
      r.generatedExcerpt,
      r.description,
      r.entityRefType ?? null,
      r.entityRefId ?? null,
      JSON.stringify(r.evidenceIds ?? []),
      r.suggestedFix ?? null,
      'open',
      ts,
      ts,
    ],
  }));
  await executeTransaction(db, statements);
}

export async function listChecksForArtifact(
  runId: string,
  artifactId: string,
): Promise<ContinuationCheckResult[]> {
  const db = await openDatabase();
  const [res] = await db.executeSql(
    `SELECT * FROM continuation_check_results
     WHERE run_id = ? AND artifact_id = ? ORDER BY id`,
    [runId, artifactId],
  );
  const out: ContinuationCheckResult[] = [];
  for (let i = 0; i < res.rows.length; i++)
    out.push(rowCheck(res.rows.item(i)));
  return out;
}

/** Read every check history row for result/repair telemetry. */
export async function listChecksForRun(
  runId: string,
): Promise<ContinuationCheckResult[]> {
  const db = await openDatabase();
  const [res] = await db.executeSql(
    `SELECT * FROM continuation_check_results
     WHERE run_id = ? ORDER BY id`,
    [runId],
  );
  const out: ContinuationCheckResult[] = [];
  for (let i = 0; i < res.rows.length; i++) out.push(rowCheck(res.rows.item(i)));
  return out;
}

export async function markChecksObsolete(
  runId: string,
  artifactId: string,
): Promise<void> {
  const db = await openDatabase();
  await db.executeSql(
    `UPDATE continuation_check_results
     SET resolution_status = 'obsolete', updated_at = ?
     WHERE run_id = ? AND artifact_id = ? AND resolution_status = 'open'`,
    [nowIso(), runId, artifactId],
  );
}

/**
 * Keep the initial check rows attached to the parent artifact while marking
 * the issues that the deterministic/Repair pass addressed. The final
 * artifact gets a new set of checks, so artifact hash binding is never lost.
 */
export async function markChecksAutoRepaired(
  runId: string,
  artifactId: string,
  checkIds: number[],
): Promise<void> {
  if (checkIds.length === 0) return;
  const db = await openDatabase();
  const params: any[] = [nowIso(), runId, artifactId];
  let suffix = '';
  suffix = ` AND id IN (${checkIds.map(() => '?').join(',')})`;
  params.push(...checkIds);
  await db.executeSql(
    `UPDATE continuation_check_results
     SET resolution_status = 'auto_repaired', updated_at = ?
     WHERE run_id = ? AND artifact_id = ?
       AND resolution_status = 'open'
       AND severity IN ('error', 'blocking')${suffix}`,
    params,
  );
}

/**
 * Explicitly accept open severe checks for the currently selected artifact.
 * Normal adoption never calls this; it is only for the user's risk-acceptance
 * action after local repair verification still fails.
 */
export function buildAcceptOpenChecksStatement(input: {
  runId: string;
  artifactId: string;
  ts?: string;
}): { sql: string; params: unknown[] } {
  return {
    sql: `UPDATE continuation_check_results
      SET resolution_status = 'accepted_by_user', updated_at = ?
      WHERE run_id = ? AND artifact_id = ?
        AND resolution_status = 'open'
        AND severity IN ('error', 'blocking')`,
    params: [input.ts ?? nowIso(), input.runId, input.artifactId],
  };
}

export async function resolveCheck(
  checkId: number,
  status: CheckResolutionStatus,
): Promise<void> {
  const db = await openDatabase();
  await db.executeSql(
    `UPDATE continuation_check_results
     SET resolution_status = ?, updated_at = ? WHERE id = ?`,
    [status, nowIso(), checkId],
  );
}

export function proposalFingerprint(input: {
  proposalType: ProposalType;
  subjectRefType: string | null;
  subjectRefId: string | null;
  payloadJson: string;
  evidenceStart: number;
  evidenceEnd: number;
}): string {
  const normalized = JSON.stringify({
    t: input.proposalType,
    st: input.subjectRefType,
    si: input.subjectRefId,
    p: JSON.parse(input.payloadJson),
    es: input.evidenceStart,
    ee: input.evidenceEnd,
  });
  return sha256Hex(normalized);
}

export interface ContinuationProposalInsertRow {
  projectId: number;
  chapterId: number;
  sourceRunId: string | null;
  extractionContentHash: string;
  chapterRevisionHash: string;
  proposalType: ProposalType;
  subjectRefType?: string | null;
  subjectRefId?: string | null;
  payloadJson: string;
  evidenceStart: number;
  evidenceEnd: number;
}

export interface PreparedContinuationProposalInsert {
  id: string;
  proposalFingerprint: string;
  row: ContinuationProposalInsertRow;
  statement: { sql: string; params: unknown[] };
}

/**
 * Build proposal INSERTs without opening a transaction. Finalization uses the
 * same builder to commit the chapter body, its authoritative proposals and
 * the Story Memory rebuild outbox as one local transaction.
 */
export function buildProposalInsertStatements(
  rows: ContinuationProposalInsertRow[],
  ts: string = nowIso(),
): PreparedContinuationProposalInsert[] {
  return rows.map(row => {
    const rawSubjectRefType = row.subjectRefType;
    const normalizedSubjectRefType =
      normalizeContinuationProposalSubjectRefType(rawSubjectRefType);
    if (
      typeof rawSubjectRefType === 'string' &&
      rawSubjectRefType.trim() &&
      !normalizedSubjectRefType
    ) {
      throw new Error(
        `CONTINUATION_PROPOSAL_SUBJECT_REF_INVALID: ${rawSubjectRefType}`,
      );
    }
    const normalizedRow: ContinuationProposalInsertRow = {
      ...row,
      subjectRefType: normalizedSubjectRefType,
    };
    const id = `cp_${v4().replace(/-/g, '')}`;
    const proposalFingerprintValue = proposalFingerprint({
      proposalType: normalizedRow.proposalType,
      subjectRefType: normalizedRow.subjectRefType ?? null,
      subjectRefId: normalizedRow.subjectRefId ?? null,
      payloadJson: normalizedRow.payloadJson,
      evidenceStart: normalizedRow.evidenceStart,
      evidenceEnd: normalizedRow.evidenceEnd,
    });
    return {
      id,
      proposalFingerprint: proposalFingerprintValue,
      row: normalizedRow,
      statement: {
        sql: `INSERT INTO continuation_state_proposals (
          id, project_id, chapter_id, source_run_id, extraction_content_hash,
          chapter_revision_hash, proposal_type, subject_ref_type, subject_ref_id,
          payload_json, proposal_fingerprint, evidence_start, evidence_end,
          status, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(project_id, chapter_id, chapter_revision_hash, proposal_fingerprint)
        DO NOTHING`,
        params: [
          id,
          normalizedRow.projectId,
          normalizedRow.chapterId,
          normalizedRow.sourceRunId,
          normalizedRow.extractionContentHash,
          normalizedRow.chapterRevisionHash,
          normalizedRow.proposalType,
          normalizedRow.subjectRefType ?? null,
          normalizedRow.subjectRefId ?? null,
          normalizedRow.payloadJson,
          proposalFingerprintValue,
          normalizedRow.evidenceStart,
          normalizedRow.evidenceEnd,
          'pending',
          ts,
          ts,
        ],
      },
    };
  });
}

export async function insertProposals(
  rows: ContinuationProposalInsertRow[],
): Promise<ContinuationStateProposal[]> {
  const db = await openDatabase();
  const out: ContinuationStateProposal[] = [];
  const preparedRows = buildProposalInsertStatements(rows);
  // H8-Generation 修复：原逐条 INSERT try/catch UNIQUE 冲突，N 条 proposals
  // 就是 N 次独立事务（sqlite-storage 自动提交），中途崩溃会留下部分插入。
  // 改单事务批量插入：INSERT OR IGNORE 跳过冲突，事务结束后统一查询填充 out。
  // 注意：executeTransaction 同步构建 statements，所以预先计算所有 id/fp。
  await executeTransaction(
    db,
    preparedRows.map(prepared => prepared.statement),
  );
  // 事务提交后，统一查询每行对应的记录（新插入或已存在的冲突行）。
  for (const { proposalFingerprint: fp, row: r } of preparedRows) {
    const [existing] = await db.executeSql(
      `SELECT ${STATE_PROPOSAL_METADATA_SELECT}
       FROM continuation_state_proposals
       WHERE project_id = ? AND chapter_id = ? AND chapter_revision_hash = ?
         AND proposal_fingerprint = ?`,
      [r.projectId, r.chapterId, r.chapterRevisionHash, fp],
    );
    if (existing.rows.length > 0)
      out.push(await materializeProposalRow(existing.rows.item(0)));
  }
  return out;
}

export async function listProposals(
  projectId: number,
  status?: ProposalStatus,
): Promise<ContinuationStateProposal[]> {
  const db = await openDatabase();
  const [res] = status
    ? await db.executeSql(
        `SELECT ${STATE_PROPOSAL_METADATA_SELECT}
         FROM continuation_state_proposals
         WHERE project_id = ? AND status = ? ORDER BY created_at DESC`,
        [projectId, status],
      )
    : await db.executeSql(
        `SELECT ${STATE_PROPOSAL_METADATA_SELECT}
         FROM continuation_state_proposals
         WHERE project_id = ? ORDER BY created_at DESC`,
        [projectId],
      );
  const rows: any[] = [];
  for (let i = 0; i < res.rows.length; i++) rows.push(res.rows.item(i));
  return Promise.all(rows.map(materializeProposalRow));
}

/**
 * Remaining pending proposals after ONE Memory auto-commit.
 * Routine State Update is committed in extract_state; leftover rows are
 * the conflict / unmergeable / low-confidence confirmation gate.
 */
export async function countPendingMajorProposals(
  projectId: number,
): Promise<number> {
  const db = await openDatabase();
  const [res] = await db.executeSql(
    `SELECT COUNT(*) AS c FROM continuation_state_proposals
     WHERE project_id = ? AND status = 'pending'`,
    [projectId],
  );
  return res.rows.item(0).c as number;
}

export async function countPendingStateExtractions(
  projectId: number,
): Promise<number> {
  const db = await openDatabase();
  const [res] = await db.executeSql(
    `SELECT COUNT(*) AS c FROM continuation_state_sync_outbox
     WHERE project_id = ? AND operation = 'extract_state'
       AND state IN ('pending', 'running', 'interrupted', 'failed')`,
    [projectId],
  );
  return res.rows.item(0).c as number;
}

export async function insertStateEvent(input: {
  proposalId: string;
  projectId: number;
  chapterId: number;
  chapterPosition: number;
  chapterRevisionHash: string;
  eventType: string;
  entityRefs: TypedEntityRef[];
  payloadJson: string;
  validFromPosition: number;
}): Promise<ContinuationStateEvent> {
  const id = `ce_${v4().replace(/-/g, '')}`;
  const createdAt = nowIso();
  const db = await openDatabase();
  await db.executeSql(
    `INSERT INTO continuation_state_events (
      id, proposal_id, project_id, chapter_id, chapter_position,
      chapter_revision_hash, event_type, entity_refs_json, payload_json,
      valid_from_position, created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      input.proposalId,
      input.projectId,
      input.chapterId,
      input.chapterPosition,
      input.chapterRevisionHash,
      input.eventType,
      JSON.stringify(input.entityRefs),
      input.payloadJson,
      input.validFromPosition,
      createdAt,
    ],
  );
  return {
    id,
    proposalId: input.proposalId,
    projectId: input.projectId,
    chapterId: input.chapterId,
    chapterPosition: input.chapterPosition as any,
    chapterRevisionHash: input.chapterRevisionHash,
    eventType: input.eventType,
    entityRefs: input.entityRefs,
    payloadJson: input.payloadJson,
    validFromPosition: input.validFromPosition as any,
    validToPosition: null,
    createdAt,
    invalidatedAt: null,
    invalidationReason: null,
  };
}

export async function listValidEventsBefore(
  projectId: number,
  targetPosition: number,
): Promise<ContinuationStateEvent[]> {
  const db = await openDatabase();
  const [res] = await db.executeSql(
    `SELECT ${STATE_EVENT_METADATA_SELECT}
     FROM continuation_state_events
     WHERE project_id = ? AND invalidated_at IS NULL
       AND valid_from_position < ?
     ORDER BY valid_from_position ASC, created_at ASC`,
    [projectId, targetPosition],
  );
  const rows: any[] = [];
  for (let i = 0; i < res.rows.length; i++) rows.push(res.rows.item(i));
  return Promise.all(rows.map(materializeEventRow));
}

export async function invalidateEventsFromPosition(
  projectId: number,
  fromPosition: number,
  reason: string,
): Promise<number> {
  const db = await openDatabase();
  const [res] = await db.executeSql(
    `UPDATE continuation_state_events
     SET invalidated_at = ?, invalidation_reason = ?
     WHERE project_id = ? AND invalidated_at IS NULL
       AND (valid_from_position >= ? OR chapter_position >= ?)`,
    [nowIso(), reason, projectId, fromPosition, fromPosition],
  );
  return res.rowsAffected ?? 0;
}

export async function invalidateProposalsForChapter(
  chapterId: number,
  reason: string,
): Promise<void> {
  const db = await openDatabase();
  await db.executeSql(
    `UPDATE continuation_state_proposals
     SET status = 'invalidated', decision_note = ?, decided_at = ?, updated_at = ?
     WHERE chapter_id = ? AND status IN ('pending', 'accepted')`,
    [reason, nowIso(), nowIso(), chapterId],
  );
}

export async function updateProposalStatus(
  proposalId: string,
  status: ProposalStatus,
  decisionNote?: string | null,
): Promise<void> {
  const db = await openDatabase();
  await db.executeSql(
    `UPDATE continuation_state_proposals
     SET status = ?, decision_note = ?, decided_at = ?, updated_at = ?
     WHERE id = ?`,
    [status, decisionNote ?? null, nowIso(), nowIso(), proposalId],
  );
}

export async function getProposalById(
  id: string,
): Promise<ContinuationStateProposal | null> {
  const db = await openDatabase();
  const [res] = await db.executeSql(
    `SELECT ${STATE_PROPOSAL_METADATA_SELECT}
       FROM continuation_state_proposals WHERE id = ?`,
    [id],
  );
  if (res.rows.length === 0) return null;
  return materializeProposalRow(res.rows.item(0));
}

export async function insertEntity(input: {
  projectId: number;
  entityType: 'character' | 'location' | 'organization';
  canonicalName: string;
  createdFromProposalId: string;
  profileJson?: string;
}): Promise<string> {
  const id = `cen_${v4().replace(/-/g, '')}`;
  const ts = nowIso();
  const db = await openDatabase();
  await db.executeSql(
    `INSERT INTO continuation_entities (
      id, project_id, entity_type, canonical_name, profile_json,
      created_from_proposal_id, status, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      id,
      input.projectId,
      input.entityType,
      input.canonicalName,
      input.profileJson ?? '{}',
      input.createdFromProposalId,
      'active',
      ts,
      ts,
    ],
  );
  return id;
}

/**
 * Build an INSERT statement for the outbox that can be embedded inside an
 * external executeTransaction (Spec §11.1). Using `INSERT OR IGNORE` makes it
 * idempotent against the UNIQUE(dedupe_key) constraint, so re-finalizing a
 * chapter never duplicates the extract_state task. The statement builder is
 * the single source of truth for the outbox INSERT shape; callers that need
 * to commit the outbox record atomically with related writes (finalize,
 * confirmProposal, invalidateContinuationStateFromPosition) must use this
 * helper instead of hand-writing the SQL to avoid schema drift.
 */
export function buildOutboxInsertStatement(input: {
  id: string;
  projectId: number;
  chapterId: number | null;
  operation: OutboxOperation;
  payload: Record<string, unknown>;
  dedupeKey: string;
  ts?: string;
}): { sql: string; params: unknown[] } {
  const ts = input.ts ?? nowIso();
  return {
    sql: `INSERT OR IGNORE INTO continuation_state_sync_outbox (
        id, project_id, chapter_id, operation, payload_json, dedupe_key,
        state, attempt_count, created_at, updated_at
      ) VALUES (?,?,?,?,?,?, 'pending', 0, ?, ?)`,
    params: [
      input.id,
      input.projectId,
      input.chapterId,
      input.operation,
      JSON.stringify(input.payload),
      input.dedupeKey,
      ts,
      ts,
    ],
  };
}

export async function enqueueOutbox(input: {
  projectId: number;
  chapterId: number | null;
  operation: OutboxOperation;
  payload: Record<string, unknown>;
  dedupeKey: string;
}): Promise<ContinuationOutboxItem> {
  const id = `co_${v4().replace(/-/g, '')}`;
  const ts = nowIso();
  const db = await openDatabase();
  try {
    const stmt = buildOutboxInsertStatement({ ...input, id, ts });
    const [res] = await db.executeSql(stmt.sql, stmt.params as any[]);
    // INSERT OR IGNORE: a duplicate dedupe_key is a no-op (rowsAffected === 0)
    // rather than a throw. Fall through to the dedupe lookup so callers always
    // receive the canonical row for that dedupe key, matching the prior
    // UNIQUE-conflict semantics.
    if ((res?.rowsAffected ?? 1) > 0) {
      return {
        id,
        projectId: input.projectId,
        chapterId: input.chapterId,
        operation: input.operation,
        payloadJson: JSON.stringify(input.payload),
        dedupeKey: input.dedupeKey,
        state: 'pending',
        attemptCount: 0,
        lastError: null,
        createdAt: ts,
        updatedAt: ts,
        completedAt: null,
      };
    }
    const [existing] = await db.executeSql(
      `SELECT ${OUTBOX_METADATA_SELECT}
         FROM continuation_state_sync_outbox WHERE dedupe_key = ?`,
      [input.dedupeKey],
    );
    if (existing.rows.length > 0) return materializeOutboxRow(existing.rows.item(0));
    throw new Error('outbox insert failed');
  } catch (e) {
    // Some drivers/stubs still surface the UNIQUE violation as a throw rather
    // than rowsAffected === 0; keep this path so behavior is consistent.
    const [res] = await db.executeSql(
      `SELECT ${OUTBOX_METADATA_SELECT}
         FROM continuation_state_sync_outbox WHERE dedupe_key = ?`,
      [input.dedupeKey],
    );
    if (res.rows.length > 0) return materializeOutboxRow(res.rows.item(0));
    throw e instanceof Error ? e : new Error('outbox insert failed');
  }
}

export async function listPendingOutbox(
  limit = 20,
): Promise<ContinuationOutboxItem[]> {
  const db = await openDatabase();
  // extract_state first so a current-chapter Ready Gate is not starved
  // behind a FIFO storm of older apply_event / rebuild_story_memory rows
  // (observed on project 16: 139 pending replay leftovers sat in front of
  // extract_state:239 and BATCH_CONTINUATION_STATE_SYNC_TIMEOUT fired
  // while the already-adopted last chapter waited). apply_event is a
  // bookkeeping no-op and is next; rebuilds stay FIFO among themselves.
  const [res] = await db.executeSql(
    `SELECT ${OUTBOX_METADATA_SELECT}
     FROM continuation_state_sync_outbox
     WHERE state IN ('pending', 'interrupted')
     ORDER BY CASE operation
       WHEN 'extract_state' THEN 0
       WHEN 'apply_event' THEN 1
       ELSE 2
     END, created_at ASC
     LIMIT ?`,
    [limit],
  );
  const rows: any[] = [];
  for (let i = 0; i < res.rows.length; i++) rows.push(res.rows.item(i));
  return Promise.all(rows.map(materializeOutboxRow));
}

/** The latest adopted continuation run is the authoritative source for a
 * later finalize when the editor no longer carries navigation state. */
export async function findLatestAdoptedRunForChapter(
  projectId: number,
  chapterId: number,
): Promise<ContinuationGenerationRun | null> {
  const db = await openDatabase();
  const [res] = await db.executeSql(
    `SELECT ${RUN_METADATA_SELECT} FROM continuation_generation_runs
     WHERE project_id = ? AND chapter_id = ?
       AND state = 'completed' AND completion_reason = 'adopted'
     ORDER BY completed_at DESC, created_at DESC LIMIT 1`,
    [projectId, chapterId],
  );
  if (res.rows.length === 0) return null;
  return rowRun(res.rows.item(0));
}

/**
 * Latest generation run that finished the pipeline and is waiting for the
 * user to adopt/abandon. Used so leaving the result screen (tab switch etc.)
 * does not strand an eligible artifact with no UI re-entry.
 */
export async function findLatestPendingReviewRunForChapter(
  projectId: number,
  chapterId: number,
): Promise<ContinuationGenerationRun | null> {
  const db = await openDatabase();
  const [res] = await db.executeSql(
    `SELECT ${RUN_METADATA_SELECT} FROM continuation_generation_runs
     WHERE project_id = ? AND chapter_id = ?
       AND state IN ('awaiting_user', 'awaiting_regeneration')
     ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
    [projectId, chapterId],
  );
  if (res.rows.length === 0) return null;
  return rowRun(res.rows.item(0));
}

/**
 * All project runs awaiting user review (adopt/abandon), newest first.
 * Workspace uses this to badge chapters that still have unadopted results.
 */
export async function listPendingReviewRunsForProject(
  projectId: number,
  limit = 50,
): Promise<ContinuationGenerationRun[]> {
  const db = await openDatabase();
  const [res] = await db.executeSql(
    `SELECT ${RUN_METADATA_SELECT} FROM continuation_generation_runs
     WHERE project_id = ? AND state IN ('awaiting_user', 'awaiting_regeneration')
     ORDER BY updated_at DESC, created_at DESC LIMIT ?`,
    [projectId, limit],
  );
  const out: ContinuationGenerationRun[] = [];
  for (let i = 0; i < res.rows.length; i++) out.push(rowRun(res.rows.item(i)));
  return out;
}

export async function casOutboxState(
  id: string,
  expected: string[],
  next: {
    state: string;
    lastError?: string | null;
    completedAt?: string | null;
    bumpAttempt?: boolean;
  },
): Promise<boolean> {
  const db = await openDatabase();
  const placeholders = expected.map(() => '?').join(',');
  const attemptSql = next.bumpAttempt
    ? ', attempt_count = attempt_count + 1'
    : '';
  const [res] = await db.executeSql(
    `UPDATE continuation_state_sync_outbox
     SET state = ?, last_error = ?, updated_at = ?, completed_at = ?${attemptSql}
     WHERE id = ? AND state IN (${placeholders})`,
    [
      next.state,
      next.lastError ?? null,
      nowIso(),
      next.completedAt ?? null,
      id,
      ...expected,
    ],
  );
  return (res.rowsAffected ?? 0) > 0;
}

export async function getOutboxByDedupe(
  dedupeKey: string,
): Promise<ContinuationOutboxItem | null> {
  const db = await openDatabase();
  const [res] = await db.executeSql(
    `SELECT ${OUTBOX_METADATA_SELECT}
       FROM continuation_state_sync_outbox WHERE dedupe_key = ?`,
    [dedupeKey],
  );
  if (res.rows.length === 0) return null;
  return materializeOutboxRow(res.rows.item(0));
}

/**
 * Maximum attempts before the worker stops auto-claiming an outbox item
 * (fix-plan §3). Past this the row stays `failed` and is only re-tried by an
 * explicit user action (`retryContinuationOutbox`). Keeps automatic retry from
 * looping forever and re-billing on persistent errors.
 */
export const MAX_OUTBOX_AUTO_RETRY_ATTEMPTS = 5;

/**
 * Manually retry a single outbox row (fix-plan §3). Only `failed` and
 * `interrupted` rows are eligible. Atomically resets state to `pending` and
 * clears the last error and restarts the automatic-attempt budget so the
 * worker can claim it again. The count represents the current automatic retry
 * streak, not lifetime history; retaining it would make an exhausted item
 * permanently unclaimable after a user explicitly retries it.
 */
export async function retryContinuationOutbox(id: string): Promise<boolean> {
  const db = await openDatabase();
  const [res] = await db.executeSql(
    `UPDATE continuation_state_sync_outbox
     SET state = 'pending', attempt_count = 0, last_error = NULL, updated_at = ?
     WHERE id = ? AND state IN ('failed', 'interrupted')`,
    [nowIso(), id],
  );
  return (res.rowsAffected ?? 0) > 0;
}

/**
 * Retry all `failed` outbox rows for a project (fix-plan §3). Intended for
 * cold-start recovery and a "retry all" UI action. Returns the count reset.
 * Configuration-missing errors (`error_code` style reasons encoded in
 * last_error) are intentionally NOT filtered here — the caller/UI decides what
 * to surface; the worker's own attempt budget prevents runaway billing.
 *
 * The LIMIT lives in a sub-select: Android's bundled SQLite is built without
 * SQLITE_ENABLE_UPDATE_DELETE_LIMIT, so `UPDATE ... ORDER BY ... LIMIT`
 * raises a syntax error on devices while passing under sql.js in tests
 * (observed: the "retry all" button silently failed on a 39-row backlog).
 */
export async function retryFailedContinuationOutbox(
  projectId: number,
  limit = 50,
): Promise<number> {
  const db = await openDatabase();
  const ts = nowIso();
  const [res] = await db.executeSql(
    `UPDATE continuation_state_sync_outbox
     SET state = 'pending', attempt_count = 0, last_error = NULL, updated_at = ?
     WHERE id IN (
       SELECT id FROM continuation_state_sync_outbox
       WHERE project_id = ? AND state = 'failed'
       ORDER BY created_at ASC LIMIT ?
     )`,
    [ts, projectId, limit],
  );
  return res.rowsAffected ?? 0;
}

/**
 * Per-project outbox health summary for the UI (fix-plan §3.4). Returns
 * pending/failed counts plus the most recent failure reason so the sync card
 * can show a retry button without exposing the prompt, chapter body or any
 * credentials (last_error is the worker's short message only).
 */
export async function getOutboxSummary(projectId: number): Promise<{
  pendingCount: number;
  failedCount: number;
  lastError: string | null;
  lastFailedDedupeKey: string | null;
}> {
  const db = await openDatabase();
  const [pendingRes] = await db.executeSql(
    `SELECT COUNT(*) AS c FROM continuation_state_sync_outbox
     WHERE project_id = ? AND state IN ('pending', 'interrupted', 'running')`,
    [projectId],
  );
  const [failedRes] = await db.executeSql(
    `SELECT COUNT(*) AS c, MAX(updated_at) AS latest FROM continuation_state_sync_outbox
     WHERE project_id = ? AND state = 'failed'`,
    [projectId],
  );
  let lastError: string | null = null;
  let lastFailedDedupeKey: string | null = null;
  const latest = failedRes.rows.item(0).latest;
  if (latest) {
    const [errRes] = await db.executeSql(
      `SELECT last_error, dedupe_key FROM continuation_state_sync_outbox
       WHERE project_id = ? AND state = 'failed' AND updated_at = ?
       ORDER BY created_at DESC LIMIT 1`,
      [projectId, latest],
    );
    if (errRes.rows.length > 0) {
      lastError = errRes.rows.item(0).last_error ?? null;
      lastFailedDedupeKey = errRes.rows.item(0).dedupe_key ?? null;
    }
  }
  return {
    pendingCount: pendingRes.rows.item(0).c as number,
    failedCount: failedRes.rows.item(0).c as number,
    lastError,
    lastFailedDedupeKey,
  };
}

/** Read a single outbox row by id (for the retry UI). */
export async function getOutboxById(
  id: string,
): Promise<ContinuationOutboxItem | null> {
  const db = await openDatabase();
  const [res] = await db.executeSql(
    `SELECT ${OUTBOX_METADATA_SELECT}
       FROM continuation_state_sync_outbox WHERE id = ?`,
    [id],
  );
  if (res.rows.length === 0) return null;
  return materializeOutboxRow(res.rows.item(0));
}

/**
 * Outbox rows for a project, filtered by state, newest first. Used by the sync
 * status card to list failed items individually.
 */
export async function listOutboxForProject(
  projectId: number,
  state?: string,
): Promise<ContinuationOutboxItem[]> {
  const db = await openDatabase();
  const [res] = state
    ? await db.executeSql(
        `SELECT ${OUTBOX_METADATA_SELECT}
         FROM continuation_state_sync_outbox
         WHERE project_id = ? AND state = ? ORDER BY updated_at DESC`,
        [projectId, state],
      )
    : await db.executeSql(
        `SELECT ${OUTBOX_METADATA_SELECT}
         FROM continuation_state_sync_outbox
         WHERE project_id = ? ORDER BY updated_at DESC`,
        [projectId],
      );
  const rows: any[] = [];
  for (let i = 0; i < res.rows.length; i++) rows.push(res.rows.item(i));
  return Promise.all(rows.map(materializeOutboxRow));
}

/** Transaction helper for multi-statement local commits (no LLM). */
export async function runLocalTransaction(
  statements: Array<{ sql: string; params?: any[] }>,
): Promise<void> {
  const db = await openDatabase();
  await executeTransaction(db, statements);
}

export async function withDatabase<T>(
  fn: (db: SQLite.SQLiteDatabase) => Promise<T>,
): Promise<T> {
  const db = await openDatabase();
  return fn(db);
}

export function contentRevisionHash(content: string): string {
  return sha256Hex(content);
}

export function profileForStrictness(
  profile: StrictnessProfile,
): StrictnessProfile {
  return profile;
}
