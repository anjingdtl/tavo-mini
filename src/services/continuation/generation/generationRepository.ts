/**
 * Phase 3 generation / state persistence (table-level).
 * Business orchestration lives in services, not here.
 */
import type SQLite from 'react-native-sqlite-storage';
import { openDatabase } from '../../../data/connection/openDatabase';
import { executeTransaction } from '../../database/transaction';
import { sha256Hex } from '../hashUtils';
import { v4 } from '../../uuidBridge';
import type {
  CheckCategory,
  CheckResolutionStatus,
  CheckSeverity,
  ContinuationArtifact,
  ContinuationCheckResult,
  ContinuationGenerationRun,
  ContinuationGenerationSettings,
  ContinuationOutboxItem,
  ContinuationPlan,
  ContinuationRunState,
  ContinuationStageName,
  ContinuationStateEvent,
  ContinuationStateProposal,
  OutboxOperation,
  ProposalStatus,
  ProposalType,
  StrictnessProfile,
  TypedEntityRef,
} from './types';

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
    plannerConfirmationPolicy: r.planner_confirmation_policy,
    checkerEnabled: asBool(r.checker_enabled),
    maxRepairRounds: r.max_repair_rounds,
    targetChapterChars: r.target_chapter_chars,
    customRulesJson: r.custom_rules_json ?? '[]',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowRun(r: any): ContinuationGenerationRun {
  return {
    id: r.id,
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
    createdAt: r.created_at,
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
    styleLevel: 'balanced',
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
    return rowSettings(res.rows.item(0));
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
  run: Omit<ContinuationGenerationRun, 'createdAt' | 'updatedAt' | 'completedAt'> & {
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
    'SELECT * FROM continuation_generation_runs WHERE id = ?',
    [runId],
  );
  if (res.rows.length === 0) return null;
  return rowRun(res.rows.item(0));
}

export async function listRunsForProject(
  projectId: number,
  limit = 50,
): Promise<ContinuationGenerationRun[]> {
  const db = await openDatabase();
  const [res] = await db.executeSql(
    `SELECT * FROM continuation_generation_runs
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
    `SELECT * FROM continuation_generation_runs
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
  const [res] = await db.executeSql(
    `UPDATE continuation_generation_runs
     SET state = 'interrupted', error_code = 'cold_start',
         error_message = '应用重启，运行中断', updated_at = ?
     WHERE state IN ('queued', 'running')`,
    [ts],
  );
  const [outboxRes] = await db.executeSql(
    `UPDATE continuation_state_sync_outbox
     SET state = 'interrupted', updated_at = ?
     WHERE state = 'running'`,
    [ts],
  );
  return (res.rowsAffected ?? 0) + (outboxRes.rowsAffected ?? 0);
}

export async function markRunsOutdatedForProject(
  projectId: number,
  reason: string,
): Promise<void> {
  const db = await openDatabase();
  await db.executeSql(
    `UPDATE continuation_generation_runs
     SET state = 'outdated', error_code = 'outdated', error_message = ?, updated_at = ?
     WHERE project_id = ? AND state IN ('queued', 'running', 'awaiting_user', 'interrupted')`,
    [reason, nowIso(), projectId],
  );
}

export async function insertArtifact(input: {
  runId: string;
  stage: 'writer' | 'repair' | 'user_edit';
  content: string;
  repairRound?: number;
  parentArtifactId?: string | null;
}): Promise<ContinuationArtifact> {
  const id = `ca_${v4().replace(/-/g, '')}`;
  const contentHash = sha256Hex(input.content);
  const createdAt = nowIso();
  const db = await openDatabase();
  try {
    await db.executeSql(
      `INSERT INTO continuation_generation_artifacts (
        id, run_id, stage, repair_round, parent_artifact_id, content, content_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.runId,
        input.stage,
        input.repairRound ?? 0,
        input.parentArtifactId ?? null,
        input.content,
        contentHash,
        createdAt,
      ],
    );
  } catch (e: any) {
    // UNIQUE(run_id, content_hash) — return existing
    const [res] = await db.executeSql(
      `SELECT * FROM continuation_generation_artifacts
       WHERE run_id = ? AND content_hash = ?`,
      [input.runId, contentHash],
    );
    if (res.rows.length > 0) return rowArtifact(res.rows.item(0));
    throw e;
  }
  return {
    id,
    runId: input.runId,
    stage: input.stage,
    repairRound: input.repairRound ?? 0,
    parentArtifactId: input.parentArtifactId ?? null,
    content: input.content,
    contentHash,
    createdAt,
  };
}

export async function getLatestArtifact(
  runId: string,
): Promise<ContinuationArtifact | null> {
  const db = await openDatabase();
  const [res] = await db.executeSql(
    `SELECT * FROM continuation_generation_artifacts
     WHERE run_id = ? ORDER BY created_at DESC LIMIT 1`,
    [runId],
  );
  if (res.rows.length === 0) return null;
  return rowArtifact(res.rows.item(0));
}

export async function getArtifactById(
  id: string,
): Promise<ContinuationArtifact | null> {
  const db = await openDatabase();
  const [res] = await db.executeSql(
    'SELECT * FROM continuation_generation_artifacts WHERE id = ?',
    [id],
  );
  if (res.rows.length === 0) return null;
  return rowArtifact(res.rows.item(0));
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
    'SELECT * FROM continuation_generation_artifacts WHERE id = ? AND run_id = ?',
    [artifactId, runId],
  );
  if (res.rows.length === 0) return null;
  return rowArtifact(res.rows.item(0));
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

export async function getPlan(
  runId: string,
): Promise<{
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

export async function insertProposals(
  rows: Array<{
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
  }>,
): Promise<ContinuationStateProposal[]> {
  const db = await openDatabase();
  const out: ContinuationStateProposal[] = [];
  const ts = nowIso();
  for (const r of rows) {
    const id = `cp_${v4().replace(/-/g, '')}`;
    const fp = proposalFingerprint({
      proposalType: r.proposalType,
      subjectRefType: r.subjectRefType ?? null,
      subjectRefId: r.subjectRefId ?? null,
      payloadJson: r.payloadJson,
      evidenceStart: r.evidenceStart,
      evidenceEnd: r.evidenceEnd,
    });
    try {
      await db.executeSql(
        `INSERT INTO continuation_state_proposals (
          id, project_id, chapter_id, source_run_id, extraction_content_hash,
          chapter_revision_hash, proposal_type, subject_ref_type, subject_ref_id,
          payload_json, proposal_fingerprint, evidence_start, evidence_end,
          status, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          r.projectId,
          r.chapterId,
          r.sourceRunId,
          r.extractionContentHash,
          r.chapterRevisionHash,
          r.proposalType,
          r.subjectRefType ?? null,
          r.subjectRefId ?? null,
          r.payloadJson,
          fp,
          r.evidenceStart,
          r.evidenceEnd,
          'pending',
          ts,
          ts,
        ],
      );
      out.push({
        id,
        projectId: r.projectId,
        chapterId: r.chapterId,
        sourceRunId: r.sourceRunId,
        extractionContentHash: r.extractionContentHash,
        chapterRevisionHash: r.chapterRevisionHash,
        proposalType: r.proposalType,
        subjectRefType: r.subjectRefType ?? null,
        subjectRefId: r.subjectRefId ?? null,
        payloadJson: r.payloadJson,
        proposalFingerprint: fp,
        evidenceStart: r.evidenceStart,
        evidenceEnd: r.evidenceEnd,
        status: 'pending',
        decisionNote: null,
        decidedAt: null,
        createdAt: ts,
        updatedAt: ts,
      });
    } catch {
      // UNIQUE conflict — already exists for this revision fingerprint
      const [existing] = await db.executeSql(
        `SELECT * FROM continuation_state_proposals
         WHERE project_id = ? AND chapter_id = ? AND chapter_revision_hash = ?
           AND proposal_fingerprint = ?`,
        [r.projectId, r.chapterId, r.chapterRevisionHash, fp],
      );
      if (existing.rows.length > 0) out.push(rowProposal(existing.rows.item(0)));
    }
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
        `SELECT * FROM continuation_state_proposals
         WHERE project_id = ? AND status = ? ORDER BY created_at DESC`,
        [projectId, status],
      )
    : await db.executeSql(
        `SELECT * FROM continuation_state_proposals
         WHERE project_id = ? ORDER BY created_at DESC`,
        [projectId],
      );
  const out: ContinuationStateProposal[] = [];
  for (let i = 0; i < res.rows.length; i++) out.push(rowProposal(res.rows.item(i)));
  return out;
}

export async function countPendingMajorProposals(
  projectId: number,
): Promise<number> {
  const db = await openDatabase();
  const [res] = await db.executeSql(
    `SELECT COUNT(*) AS c FROM continuation_state_proposals
     WHERE project_id = ? AND status = 'pending'
       AND proposal_type IN (
         'relationship_change', 'new_world_fact', 'new_character',
         'character_state'
       )`,
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
    `SELECT * FROM continuation_state_events
     WHERE project_id = ? AND invalidated_at IS NULL
       AND valid_from_position < ?
     ORDER BY valid_from_position ASC, created_at ASC`,
    [projectId, targetPosition],
  );
  const out: ContinuationStateEvent[] = [];
  for (let i = 0; i < res.rows.length; i++) out.push(rowEvent(res.rows.item(i)));
  return out;
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
    'SELECT * FROM continuation_state_proposals WHERE id = ?',
    [id],
  );
  if (res.rows.length === 0) return null;
  return rowProposal(res.rows.item(0));
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
      'SELECT * FROM continuation_state_sync_outbox WHERE dedupe_key = ?',
      [input.dedupeKey],
    );
    if (existing.rows.length > 0) return rowOutbox(existing.rows.item(0));
    throw new Error('outbox insert failed');
  } catch (e) {
    // Some drivers/stubs still surface the UNIQUE violation as a throw rather
    // than rowsAffected === 0; keep this path so behavior is consistent.
    const [res] = await db.executeSql(
      'SELECT * FROM continuation_state_sync_outbox WHERE dedupe_key = ?',
      [input.dedupeKey],
    );
    if (res.rows.length > 0) return rowOutbox(res.rows.item(0));
    throw e instanceof Error ? e : new Error('outbox insert failed');
  }
}

export async function listPendingOutbox(
  limit = 20,
): Promise<ContinuationOutboxItem[]> {
  const db = await openDatabase();
  const [res] = await db.executeSql(
    `SELECT * FROM continuation_state_sync_outbox
     WHERE state IN ('pending', 'interrupted')
     ORDER BY created_at ASC LIMIT ?`,
    [limit],
  );
  const out: ContinuationOutboxItem[] = [];
  for (let i = 0; i < res.rows.length; i++) out.push(rowOutbox(res.rows.item(i)));
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
    'SELECT * FROM continuation_state_sync_outbox WHERE dedupe_key = ?',
    [dedupeKey],
  );
  if (res.rows.length === 0) return null;
  return rowOutbox(res.rows.item(0));
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
 * clears the last error so the worker can claim it again. `attempt_count` is
 * preserved as audit history — manual retry must NOT reset the budget, only
 * surface the row for the worker's next pass.
 */
export async function retryContinuationOutbox(id: string): Promise<boolean> {
  const db = await openDatabase();
  const [res] = await db.executeSql(
    `UPDATE continuation_state_sync_outbox
     SET state = 'pending', last_error = NULL, updated_at = ?
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
 */
export async function retryFailedContinuationOutbox(
  projectId: number,
  limit = 50,
): Promise<number> {
  const db = await openDatabase();
  const ts = nowIso();
  const [res] = await db.executeSql(
    `UPDATE continuation_state_sync_outbox
     SET state = 'pending', last_error = NULL, updated_at = ?
     WHERE project_id = ? AND state = 'failed'
     ORDER BY created_at ASC LIMIT ?`,
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
export async function getOutboxSummary(
  projectId: number,
): Promise<{
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
    'SELECT * FROM continuation_state_sync_outbox WHERE id = ?',
    [id],
  );
  if (res.rows.length === 0) return null;
  return rowOutbox(res.rows.item(0));
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
        `SELECT * FROM continuation_state_sync_outbox
         WHERE project_id = ? AND state = ? ORDER BY updated_at DESC`,
        [projectId, state],
      )
    : await db.executeSql(
        `SELECT * FROM continuation_state_sync_outbox
         WHERE project_id = ? ORDER BY updated_at DESC`,
        [projectId],
      );
  const out: ContinuationOutboxItem[] = [];
  for (let i = 0; i < res.rows.length; i++) out.push(rowOutbox(res.rows.item(i)));
  return out;
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
