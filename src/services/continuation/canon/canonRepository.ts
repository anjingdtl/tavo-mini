/**
 * Low-level Canon persistence (Spec §6). UI and Phase 3 must not import this
 * for reads — use CanonQueryService / review / analysis services instead.
 */
import type SQLite from 'react-native-sqlite-storage';
import type { SourceChapterPosition, Utf16Offset } from '../../../types/novel';
import { openDatabase } from '../../../data/connection/openDatabase';
import { all, one } from '../../../data/connection/query';
import { execute } from '../../../data/connection/execute';
import {
  executeTransaction,
  type SqlStatement,
} from '../../../data/connection/transaction';
import { now, type Row } from '../../../data/repositories/shared';
import { asSourcePosition, asUtf16Offset } from '../continuationSourceRepository';
import {
  emptyCapabilities,
  emptyCoverage,
  type AnalysisBatch,
  type AnalysisWorkItemType,
  type AnalysisWorkItem,
  type AnalysisProfile,
  type AnalysisRun,
  type AnalysisRunState,
  type AnalysisStage,
  type CanonCapabilities,
  type CanonCoverage,
  type CanonSnapshot,
  type CanonSnapshotStatus,
  type CharacterExperience,
  type CharacterKnowledge,
  type CharacterProfile,
  type CharacterRelationship,
  type CharacterStateSnapshot,
  type CanonTimelineEvent,
  type PlotThread,
  type WorldRule,
  type CanonEvidence,
  type CanonReviewStatus,
  type CharacterImportance,
  type CanonConstraintLevel,
  type RelationshipPublicStatus,
  type PlotThreadLevel,
  type PlotThreadStatus,
  type CharacterKnowledgeState,
} from './types';

function parseJsonSafe<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function mapGovernance(row: Row) {
  return {
    id: row.id as number,
    projectId: row.project_id as number,
    sourceId: row.source_id as number,
    snapshotId: row.snapshot_id as string,
    analysisRunId: row.analysis_run_id as string,
    validFromPosition: asSourcePosition(row.valid_from_position),
    validToPosition:
      row.valid_to_position == null
        ? null
        : asSourcePosition(row.valid_to_position),
    firstObservedPosition: asSourcePosition(row.first_observed_position),
    lastObservedPosition: asSourcePosition(row.last_observed_position),
    confidence: row.confidence as number,
    reviewStatus: row.review_status as CanonReviewStatus,
    origin: row.origin as 'ai' | 'user',
    extractionVersion: row.extraction_version as string,
    revision: row.revision as number,
    supersedesId: (row.supersedes_id as number | null) ?? null,
    userReviewedAt: (row.user_reviewed_at as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function mapSnapshot(row: Row): CanonSnapshot {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceId: row.source_id,
    sourceVersion: row.source_version,
    sourceSha256: row.source_sha256,
    parserVersion: row.parser_version,
    normalizationVersion: row.normalization_version,
    boundaryPosition: asSourcePosition(row.boundary_position),
    boundaryCharOffsetExclusive: asUtf16Offset(
      row.boundary_char_offset_exclusive,
    ),
    boundaryChapterId: row.boundary_chapter_id,
    extractionVersion: row.extraction_version,
    profile: row.profile as AnalysisProfile,
    revision: row.revision,
    capabilities: parseJsonSafe(
      row.capabilities_json,
      emptyCapabilities(row.profile),
    ),
    coverage: parseJsonSafe(row.coverage_json, emptyCoverage()),
    status: row.status as CanonSnapshotStatus,
    analysisRunId: row.analysis_run_id ?? null,
    activatedAt: row.activated_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapRun(row: Row): AnalysisRun {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceId: row.source_id,
    sourceVersion: row.source_version,
    sourceSha256: row.source_sha256,
    parserVersion: row.parser_version,
    normalizationVersion: row.normalization_version,
    boundaryChapterId: row.boundary_chapter_id,
    boundaryPosition: asSourcePosition(row.boundary_position),
    boundaryCharOffsetExclusive: asUtf16Offset(
      row.boundary_char_offset_exclusive,
    ),
    canonSnapshotId: row.canon_snapshot_id,
    profile: row.profile as AnalysisProfile,
    modelConfigId: row.model_config_id ?? null,
    state: row.state as AnalysisRunState,
    stage: row.stage as AnalysisStage,
    progressCurrent: row.progress_current,
    progressTotal: row.progress_total,
    extractionVersion: row.extraction_version,
    checkpointJson: row.checkpoint_json ?? null,
    errorCode: row.error_code ?? null,
    errorMessage: row.error_message ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? null,
  };
}

export function mapBatch(row: Row): AnalysisBatch {
  return {
    runId: row.run_id,
    canonSnapshotId: row.canon_snapshot_id,
    batchIndex: row.batch_index,
    startPosition: asSourcePosition(row.start_position),
    endPosition: asSourcePosition(row.end_position),
    inputHash: row.input_hash,
    idempotencyKey: row.idempotency_key,
    state: row.state,
    attemptCount: row.attempt_count,
    resultJson: row.result_json ?? null,
    errorCode: row.error_code ?? null,
    errorMessage: row.error_message ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? null,
  };
}

function mapWorkItem(row: Row): AnalysisWorkItem {
  return {
    runId: row.run_id,
    batchIndex: row.batch_index,
    materialType: row.material_type as AnalysisWorkItemType,
    state: row.state,
    attemptCount: row.attempt_count,
    resultJson: row.result_json ?? null,
    errorCode: row.error_code ?? null,
    errorMessage: row.error_message ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? null,
  };
}

export function mapWorldRule(row: Row): WorldRule {
  return {
    ...mapGovernance(row),
    category: row.category,
    title: row.title,
    description: row.description,
    constraintLevel: row.constraint_level as CanonConstraintLevel,
  };
}

export function mapCharacter(row: Row): CharacterProfile {
  return {
    ...mapGovernance(row),
    canonicalName: row.canonical_name,
    description: row.description,
    background: row.background,
    appearanceJson: row.appearance_json,
    personalityJson: row.personality_json,
    valuesJson: row.values_json,
    behaviorPatternsJson: row.behavior_patterns_json,
    speechStyleJson: row.speech_style_json,
    abilitiesJson: row.abilities_json,
    weaknessesJson: row.weaknesses_json,
    goalsJson: row.goals_json,
    fearsJson: row.fears_json,
    secretsJson: row.secrets_json,
    firstAppearancePosition: asSourcePosition(row.first_appearance_position),
    importance: row.importance as CharacterImportance,
  };
}

export function mapState(row: Row): CharacterStateSnapshot {
  return {
    ...mapGovernance(row),
    characterId: row.character_id,
    chapterPosition: asSourcePosition(row.chapter_position),
    location: row.location ?? null,
    physicalState: row.physical_state ?? null,
    emotionalState: row.emotional_state ?? null,
    identityState: row.identity_state ?? null,
    organizationState: row.organization_state ?? null,
    currentGoal: row.current_goal ?? null,
    possessionsJson: row.possessions_json,
    abilitiesStateJson: row.abilities_state_json,
    aliveState: row.alive_state,
    summary: row.summary,
  };
}

export function mapRelationship(row: Row): CharacterRelationship {
  return {
    ...mapGovernance(row),
    sourceCharacterId: row.source_character_id,
    targetCharacterId: row.target_character_id,
    relationType: row.relation_type,
    attitude: row.attitude,
    publicStatus: row.public_status as RelationshipPublicStatus,
    description: row.description,
    causesJson: row.causes_json,
  };
}

export function mapPlotThread(row: Row): PlotThread {
  return {
    ...mapGovernance(row),
    title: row.title,
    description: row.description,
    level: row.level as PlotThreadLevel,
    status: row.status as PlotThreadStatus,
    importance: row.importance,
    startPosition: asSourcePosition(row.start_position),
    lastAdvancedPosition: asSourcePosition(row.last_advanced_position),
    resolvedPosition:
      row.resolved_position == null
        ? null
        : asSourcePosition(row.resolved_position),
    establishedFactsJson: row.established_facts_json,
    unresolvedQuestionsJson: row.unresolved_questions_json,
    expectedDirectionsJson: row.expected_directions_json,
  };
}

export function mapExperience(row: Row): CharacterExperience {
  return {
    ...mapGovernance(row),
    characterId: row.character_id,
    chapterPosition: asSourcePosition(row.chapter_position),
    eventType: row.event_type,
    title: row.title,
    description: row.description,
    involvedCharacterIdsJson: row.involved_character_ids_json,
    impactOnPersonality: row.impact_on_personality ?? null,
    impactOnGoal: row.impact_on_goal ?? null,
    impactOnRelationship: row.impact_on_relationship ?? null,
    knowledgeGainedJson: row.knowledge_gained_json,
    secretsLearnedJson: row.secrets_learned_json,
    importance: row.importance,
  };
}

export function mapKnowledge(row: Row): CharacterKnowledge {
  return {
    ...mapGovernance(row),
    characterId: row.character_id,
    factKey: row.fact_key,
    factSummary: row.fact_summary,
    knowledgeState: row.knowledge_state as CharacterKnowledgeState,
    learnedPosition:
      row.learned_position == null
        ? null
        : asSourcePosition(row.learned_position),
    learnedFromCharacterId: row.learned_from_character_id ?? null,
    misunderstandingSummary: row.misunderstanding_summary ?? null,
  };
}

export function mapTimeline(row: Row): CanonTimelineEvent {
  return {
    ...mapGovernance(row),
    eventKey: row.event_key,
    title: row.title,
    summary: row.summary,
    eventType: row.event_type,
    chapterPosition: asSourcePosition(row.chapter_position),
    charStart: row.char_start ?? null,
    charEnd: row.char_end ?? null,
    participantCharacterIdsJson: row.participant_character_ids_json,
    locationBefore: row.location_before ?? null,
    locationAfter: row.location_after ?? null,
    relativeTimeJson: row.relative_time_json,
    causesEventIdsJson: row.causes_event_ids_json,
    consequencesEventIdsJson: row.consequences_event_ids_json,
    importance: row.importance,
  };
}

export function mapEvidence(row: Row): CanonEvidence {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceId: row.source_id,
    snapshotId: row.snapshot_id,
    chapterId: row.chapter_id,
    chapterPosition: asSourcePosition(row.chapter_position),
    paragraphStart: row.paragraph_start ?? null,
    paragraphEnd: row.paragraph_end ?? null,
    charStart: row.char_start,
    charEnd: row.char_end,
    quotePreview: row.quote_preview,
    quoteSha256: row.quote_sha256,
    analysisRunId: row.analysis_run_id,
    createdAt: row.created_at,
  };
}

export async function getDb(): Promise<SQLite.SQLiteDatabase> {
  return openDatabase();
}

export async function insertSnapshot(
  db: SQLite.SQLiteDatabase,
  snap: {
    id: string;
    projectId: number;
    sourceId: number;
    analysisRunId: string | null;
    sourceVersion: number;
    sourceSha256: string;
    parserVersion: string;
    normalizationVersion: string;
    boundaryChapterId: number;
    boundaryPosition: number;
    boundaryCharOffsetExclusive: number;
    extractionVersion: string;
    profile: AnalysisProfile;
    status: CanonSnapshotStatus;
    capabilities: CanonCapabilities;
    coverage: CanonCoverage;
  },
): Promise<void> {
  const ts = now();
  await execute(
    db,
    `INSERT INTO continuation_canon_snapshots (
      id, project_id, source_id, analysis_run_id, source_version, source_sha256,
      parser_version, normalization_version, boundary_chapter_id, boundary_position,
      boundary_char_offset_exclusive, extraction_version, profile, revision, status,
      capabilities_json, coverage_json, created_at, updated_at, activated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, NULL)`,
    [
      snap.id,
      snap.projectId,
      snap.sourceId,
      snap.analysisRunId,
      snap.sourceVersion,
      snap.sourceSha256,
      snap.parserVersion,
      snap.normalizationVersion,
      snap.boundaryChapterId,
      snap.boundaryPosition,
      snap.boundaryCharOffsetExclusive,
      snap.extractionVersion,
      snap.profile,
      snap.status,
      JSON.stringify(snap.capabilities),
      JSON.stringify(snap.coverage),
      ts,
      ts,
    ],
  );
}

export async function insertRun(
  db: SQLite.SQLiteDatabase,
  run: {
    id: string;
    projectId: number;
    sourceId: number;
    sourceVersion: number;
    sourceSha256: string;
    parserVersion: string;
    normalizationVersion: string;
    boundaryChapterId: number;
    boundaryPosition: number;
    boundaryCharOffsetExclusive: number;
    canonSnapshotId: string;
    profile: AnalysisProfile;
    modelConfigId: number | null;
    state: AnalysisRunState;
    stage: AnalysisStage;
    progressCurrent: number;
    progressTotal: number;
    extractionVersion: string;
  },
): Promise<void> {
  const ts = now();
  await execute(
    db,
    `INSERT INTO continuation_analysis_runs (
      id, project_id, source_id, source_version, source_sha256, parser_version,
      normalization_version, boundary_chapter_id, boundary_position,
      boundary_char_offset_exclusive, canon_snapshot_id, profile, model_config_id,
      state, stage, progress_current, progress_total, extraction_version,
      checkpoint_json, error_code, error_message, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, NULL)`,
    [
      run.id,
      run.projectId,
      run.sourceId,
      run.sourceVersion,
      run.sourceSha256,
      run.parserVersion,
      run.normalizationVersion,
      run.boundaryChapterId,
      run.boundaryPosition,
      run.boundaryCharOffsetExclusive,
      run.canonSnapshotId,
      run.profile,
      run.modelConfigId,
      run.state,
      run.stage,
      run.progressCurrent,
      run.progressTotal,
      run.extractionVersion,
      ts,
      ts,
    ],
  );
}

export async function insertBatches(
  db: SQLite.SQLiteDatabase,
  batches: Array<{
    runId: string;
    canonSnapshotId: string;
    batchIndex: number;
    startPosition: number;
    endPosition: number;
    inputHash: string;
    idempotencyKey: string;
  }>,
): Promise<void> {
  const ts = now();
  const statements: SqlStatement[] = batches.map(b => ({
    sql: `INSERT INTO continuation_analysis_batches (
      run_id, canon_snapshot_id, batch_index, start_position, end_position,
      input_hash, idempotency_key, state, attempt_count, result_json,
      error_code, error_message, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, NULL, NULL, NULL, ?, ?, NULL)`,
    params: [
      b.runId,
      b.canonSnapshotId,
      b.batchIndex,
      b.startPosition,
      b.endPosition,
      b.inputHash,
      b.idempotencyKey,
      ts,
      ts,
    ],
  }));
  await executeTransaction(db, statements);
}

export async function insertWorkItems(
  db: SQLite.SQLiteDatabase,
  items: Array<{
    runId: string;
    batchIndex: number;
    materialType: AnalysisWorkItemType;
  }>,
): Promise<void> {
  const ts = now();
  await executeTransaction(
    db,
    items.map(item => ({
      sql: `INSERT INTO continuation_analysis_work_items (
        run_id, batch_index, material_type, state, attempt_count, result_json,
        error_code, error_message, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, 'queued', 0, NULL, NULL, NULL, ?, ?, NULL)`,
      params: [item.runId, item.batchIndex, item.materialType, ts, ts],
    })),
  );
}

export async function getSnapshotById(
  snapshotId: string,
): Promise<CanonSnapshot | null> {
  const row = await one<Row>(
    'SELECT * FROM continuation_canon_snapshots WHERE id = ?',
    [snapshotId],
  );
  return row ? mapSnapshot(row) : null;
}

export async function getSnapshotByIdInTx(
  db: SQLite.SQLiteDatabase,
  snapshotId: string,
): Promise<CanonSnapshot | null> {
  const [result] = await db.executeSql(
    'SELECT * FROM continuation_canon_snapshots WHERE id = ?',
    [snapshotId],
  );
  if (result.rows.length === 0) return null;
  return mapSnapshot(result.rows.item(0));
}

export async function getActiveSnapshot(
  projectId: number,
): Promise<CanonSnapshot | null> {
  const settings = await one<Row>(
    'SELECT active_canon_snapshot_id FROM continuation_settings WHERE project_id = ?',
    [projectId],
  );
  if (!settings?.active_canon_snapshot_id) return null;
  const snap = await getSnapshotById(settings.active_canon_snapshot_id);
  if (!snap || snap.status !== 'ready') return null;
  return snap;
}

export async function getRunById(runId: string): Promise<AnalysisRun | null> {
  const row = await one<Row>(
    'SELECT * FROM continuation_analysis_runs WHERE id = ?',
    [runId],
  );
  return row ? mapRun(row) : null;
}

export async function getRunForSnapshot(
  snapshotId: string,
): Promise<AnalysisRun | null> {
  const row = await one<Row>(
    `SELECT * FROM continuation_analysis_runs
      WHERE canon_snapshot_id = ?
      ORDER BY created_at DESC
      LIMIT 1`,
    [snapshotId],
  );
  return row ? mapRun(row) : null;
}

export async function listRunsForProject(
  projectId: number,
): Promise<AnalysisRun[]> {
  const rows = await all<Row>(
    `SELECT * FROM continuation_analysis_runs
      WHERE project_id = ? ORDER BY created_at DESC LIMIT 50`,
    [projectId],
  );
  return rows.map(mapRun);
}

export async function listBatches(runId: string): Promise<AnalysisBatch[]> {
  const rows = await all<Row>(
    `SELECT * FROM continuation_analysis_batches
      WHERE run_id = ? ORDER BY batch_index ASC`,
    [runId],
  );
  return rows.map(mapBatch);
}

export async function listWorkItems(runId: string): Promise<AnalysisWorkItem[]> {
  const rows = await all<Row>(
    `SELECT * FROM continuation_analysis_work_items
      WHERE run_id = ? ORDER BY batch_index ASC, material_type ASC`,
    [runId],
  );
  return rows.map(mapWorkItem);
}

export async function updateWorkItem(
  db: SQLite.SQLiteDatabase,
  input: {
    runId: string;
    batchIndex: number;
    materialType: AnalysisWorkItemType;
    state?: AnalysisWorkItem['state'];
    incrementAttempt?: boolean;
    resultJson?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    completedAt?: string | null;
  },
): Promise<void> {
  const fields: string[] = ['updated_at = ?'];
  const params: unknown[] = [now()];
  if (input.state !== undefined) { fields.push('state = ?'); params.push(input.state); }
  if (input.incrementAttempt) fields.push('attempt_count = attempt_count + 1');
  if (input.resultJson !== undefined) { fields.push('result_json = ?'); params.push(input.resultJson); }
  if (input.errorCode !== undefined) { fields.push('error_code = ?'); params.push(input.errorCode); }
  if (input.errorMessage !== undefined) { fields.push('error_message = ?'); params.push(input.errorMessage); }
  if (input.completedAt !== undefined) { fields.push('completed_at = ?'); params.push(input.completedAt); }
  params.push(input.runId, input.batchIndex, input.materialType);
  await execute(
    db,
    `UPDATE continuation_analysis_work_items SET ${fields.join(', ')}
      WHERE run_id = ? AND batch_index = ? AND material_type = ?`,
    params,
  );
}

export async function updateRunState(
  db: SQLite.SQLiteDatabase,
  runId: string,
  patch: {
    state?: AnalysisRunState;
    stage?: AnalysisStage;
    progressCurrent?: number;
    progressTotal?: number;
    errorCode?: string | null;
    errorMessage?: string | null;
    completedAt?: string | null;
    checkpointJson?: string | null;
  },
): Promise<void> {
  const fields: string[] = ['updated_at = ?'];
  const params: unknown[] = [now()];
  if (patch.state !== undefined) {
    fields.push('state = ?');
    params.push(patch.state);
  }
  if (patch.stage !== undefined) {
    fields.push('stage = ?');
    params.push(patch.stage);
  }
  if (patch.progressCurrent !== undefined) {
    fields.push('progress_current = ?');
    params.push(patch.progressCurrent);
  }
  if (patch.progressTotal !== undefined) {
    fields.push('progress_total = ?');
    params.push(patch.progressTotal);
  }
  if (patch.errorCode !== undefined) {
    fields.push('error_code = ?');
    params.push(patch.errorCode);
  }
  if (patch.errorMessage !== undefined) {
    fields.push('error_message = ?');
    params.push(patch.errorMessage);
  }
  if (patch.completedAt !== undefined) {
    fields.push('completed_at = ?');
    params.push(patch.completedAt);
  }
  if (patch.checkpointJson !== undefined) {
    fields.push('checkpoint_json = ?');
    params.push(patch.checkpointJson);
  }
  params.push(runId);
  await execute(
    db,
    `UPDATE continuation_analysis_runs SET ${fields.join(', ')} WHERE id = ?`,
    params,
  );
}

export async function updateSnapshotMeta(
  db: SQLite.SQLiteDatabase,
  snapshotId: string,
  patch: {
    status?: CanonSnapshotStatus;
    capabilities?: CanonCapabilities;
    coverage?: CanonCoverage;
    analysisRunId?: string | null;
    revisionBump?: boolean;
    activatedAt?: string | null;
  },
): Promise<void> {
  const fields: string[] = ['updated_at = ?'];
  const params: unknown[] = [now()];
  if (patch.status !== undefined) {
    fields.push('status = ?');
    params.push(patch.status);
  }
  if (patch.capabilities !== undefined) {
    fields.push('capabilities_json = ?');
    params.push(JSON.stringify(patch.capabilities));
  }
  if (patch.coverage !== undefined) {
    fields.push('coverage_json = ?');
    params.push(JSON.stringify(patch.coverage));
  }
  if (patch.analysisRunId !== undefined) {
    fields.push('analysis_run_id = ?');
    params.push(patch.analysisRunId);
  }
  if (patch.revisionBump) {
    fields.push('revision = revision + 1');
  }
  if (patch.activatedAt !== undefined) {
    fields.push('activated_at = ?');
    params.push(patch.activatedAt);
  }
  params.push(snapshotId);
  await execute(
    db,
    `UPDATE continuation_canon_snapshots SET ${fields.join(', ')} WHERE id = ?`,
    params,
  );
}

export async function countOrphanEvidence(
  snapshotId: string,
): Promise<number> {
  const row = await one<{ c: number }>(
    `SELECT COUNT(*) AS c FROM canon_evidence e
      WHERE e.snapshot_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM canon_evidence_links l WHERE l.evidence_id = e.id
        )`,
    [snapshotId],
  );
  return row?.c ?? 0;
}

export async function countFutureEvidence(
  snapshotId: string,
  boundaryExclusive: number,
): Promise<number> {
  const row = await one<{ c: number }>(
    `SELECT COUNT(*) AS c FROM canon_evidence
      WHERE snapshot_id = ? AND char_end > ?`,
    [snapshotId, boundaryExclusive],
  );
  return row?.c ?? 0;
}

/** Temporal validity: [from, to) contains position. */
export function sqlValidAt(positionParamIndex: number): string {
  // positionParamIndex is 1-based for documentation; actual SQL uses `?`.
  void positionParamIndex;
  return `(valid_from_position <= ? AND (valid_to_position IS NULL OR valid_to_position > ?))`;
}

export async function listWorldRulesForQuery(
  db: SQLite.SQLiteDatabase,
  snapshotId: string,
  at: SourceChapterPosition,
  reviewStatuses: CanonReviewStatus[],
  limit: number,
): Promise<WorldRule[]> {
  const placeholders = reviewStatuses.map(() => '?').join(',');
  const [result] = await db.executeSql(
    `SELECT * FROM canon_world_rules
      WHERE snapshot_id = ?
        AND review_status IN (${placeholders})
        AND valid_from_position <= ?
        AND (valid_to_position IS NULL OR valid_to_position > ?)
      ORDER BY constraint_level ASC, confidence DESC, id ASC
      LIMIT ?`,
    [snapshotId, ...reviewStatuses, at, at, limit],
  );
  const out: WorldRule[] = [];
  for (let i = 0; i < result.rows.length; i++) {
    out.push(mapWorldRule(result.rows.item(i)));
  }
  return out;
}

export {
  asSourcePosition,
  asUtf16Offset,
  type SourceChapterPosition,
  type Utf16Offset,
};
