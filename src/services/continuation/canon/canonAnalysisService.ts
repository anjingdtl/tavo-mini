/**
 * Canon analysis pipeline (Spec §8).
 *
 * Creates staging snapshot + run + batches, extracts via deterministic or LLM
 * path, validates evidence, and only publishes via explicit activateSnapshot.
 * Failed/cancelled/outdated runs never become Phase 3 active Canon.
 */
import type SQLite from 'react-native-sqlite-storage';
import { openDatabase } from '../../../data/connection/openDatabase';
import { execute } from '../../../data/connection/execute';
import { now } from '../../../data/repositories/shared';
import { v4 } from '../../uuidBridge';
import { sha256Hex } from '../hashUtils';
import { continuationSourceReader } from '../continuationSourceReader';
import {
  ContinuationSnapshotOutdatedError,
  type BoundedSourceChapter,
  type ContinuationSourceSnapshot,
} from '../types';
import {
  emptyCapabilities,
  emptyCoverage,
  ANALYSIS_MATERIAL_TYPES,
  EXTRACTION_VERSION,
  type AnalysisMaterialType,
  type AnalysisScope,
  type AnalysisProfile,
  type AnalysisRun,
  type AnalysisStage,
  type CanonCapabilities,
  type CanonCoverage,
  type CanonSnapshot,
  type ContinuationAnalysisMode,
} from './types';
import {
  getActiveSnapshot,
  getDb,
  getRunById,
  getSnapshotById,
  insertBatches,
  insertWorkItems,
  insertRun,
  insertSnapshot,
  listBatches,
  listWorkItems,
  listRunsForProject,
  updateRunState,
  updateWorkItem,
  updateSnapshotMeta,
  countFutureEvidence,
  countOrphanEvidence,
  asSourcePosition,
} from './canonRepository';
import {
  FAST_CONTINUATION_SCOPE,
  FULL_ANALYSIS_SCOPE,
  normalizeAnalysisScope,
  planAnalysisScope,
} from './analysisScopePlanner';
import {
  parseExtractionResultJson,
  type ChapterExtractionResult,
} from './canonJsonValidators';
import { insertEvidenceAndLink } from './canonEvidenceService';
import { executeTransaction } from '../../../data/connection/transaction';
import {
  callLLM,
  callLLMResult,
  resolveLLMRequestConfig,
  resolveLLMRequestConfigById,
} from '../../llm';

export const ANALYSIS_MATERIAL_LABELS: Record<AnalysisMaterialType, string> = {
  world_rules: '世界观',
  characters: '人物画像',
  relationships: '人物关系',
  plot_threads: '主线剧情',
  experiences: '人物经历',
};

/**
 * Retry only failures where another identical request is safe and useful.
 * The delays are deliberately modest: the scheduler already caps Canon work
 * at two concurrent requests, while exponential backoff prevents a failing
 * provider from being hit again in the same burst.
 */
export const CANON_ANALYSIS_RETRY_POLICY = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
} as const;

/** States whose persisted partial work can be safely resumed. */
export function isResumableAnalysisState(state: AnalysisRun['state']): boolean {
  return state === 'paused' || state === 'failed' || state === 'cancelled';
}

function isTransientCanonAnalysisError(error: unknown): boolean {
  const candidate = error as {
    code?: unknown;
    status?: unknown;
    cause?: { status?: unknown };
  };
  const status = Number(candidate?.cause?.status ?? candidate?.status ?? 0);
  const code = String(candidate?.code ?? '');
  return (
    ['total_timeout', 'idle_timeout', 'network_error'].includes(code) ||
    status === 429 ||
    status >= 500
  );
}

function isRecoverableCanonOutputError(error: unknown): boolean {
  return (error as { name?: unknown })?.name === 'CanonAnalysisOutputError';
}

function canonOutputError(message: string): Error {
  const error = new Error(message);
  error.name = 'CanonAnalysisOutputError';
  return error;
}

function waitForCanonRetry(
  signal: AbortSignal,
  delayMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('分析已暂停或取消'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new Error('分析已暂停或取消'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export interface AnalysisProgressUpdate {
  runId: string;
  stage: AnalysisStage;
  progressCurrent: number;
  progressTotal: number;
  materialType?: AnalysisMaterialType;
  batchIndex?: number;
  state?: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
}

export interface ProcessAnalysisOptions {
  onProgress?: (update: AnalysisProgressUpdate) => void;
}

const analysisControllers = new Map<string, AbortController>();
const analysisProcesses = new Map<string, Promise<AnalysisRun>>();

export const ANALYSIS_MODE_PRESETS: Record<
  ContinuationAnalysisMode,
  {
    profile: Extract<AnalysisProfile, 'standard' | 'deep'>;
    scope: AnalysisScope;
  }
> = {
  fast_continuation: { profile: 'standard', scope: FAST_CONTINUATION_SCOPE },
  full_canon: { profile: 'deep', scope: FULL_ANALYSIS_SCOPE },
};

export interface StartAnalysisInput {
  projectId: number;
  mode: ContinuationAnalysisMode;
  modelConfigId?: number | null;
  chaptersPerBatch?: number;
}

export interface ModelCapabilityProbe {
  modelKey: string;
  jsonValid: boolean;
  schemaValid: boolean;
  contextSufficient: boolean;
  probedAt: string;
  extractionVersion: string;
}

// In-memory probe cache (Spec §9.1) — not persisted, re-probe on process restart.
const probeCache = new Map<string, ModelCapabilityProbe>();

export function getCachedProbe(modelKey: string): ModelCapabilityProbe | null {
  return probeCache.get(modelKey) ?? null;
}

export function setCachedProbe(probe: ModelCapabilityProbe): void {
  probeCache.set(probe.modelKey, probe);
}

/** Small capability probe without saving probe body (Spec §9.1). */
export async function probeModelCapability(input: {
  modelKey: string;
  sampleJson: string;
  contextWindow: number;
}): Promise<ModelCapabilityProbe> {
  let jsonValid = false;
  let schemaValid = false;
  try {
    parseExtractionResultJson(input.sampleJson);
    jsonValid = true;
    schemaValid = true;
  } catch {
    try {
      JSON.parse(input.sampleJson);
      jsonValid = true;
    } catch {
      jsonValid = false;
    }
  }
  const probe: ModelCapabilityProbe = {
    modelKey: input.modelKey,
    jsonValid,
    schemaValid,
    contextSufficient: input.contextWindow >= 4096,
    probedAt: now(),
    extractionVersion: EXTRACTION_VERSION,
  };
  setCachedProbe(probe);
  return probe;
}

function nameKey(name: string): string {
  return name.trim().replace(/\s+/g, '').toLowerCase();
}

async function lastInsertId(db: SQLite.SQLiteDatabase): Promise<number> {
  const [r] = await db.executeSql('SELECT last_insert_rowid() AS id');
  return r.rows.item(0).id as number;
}

/**
 * Persist a validated batch extraction into Canon tables (Spec §8.3–8.4).
 * Character names are resolved within the snapshot; ambiguous names create
 * new character rows rather than silent merges.
 */
export async function materializeBatchResult(
  db: SQLite.SQLiteDatabase,
  ctx: {
    projectId: number;
    sourceId: number;
    snapshotId: string;
    runId: string;
    boundaryExclusive: number;
    profile: AnalysisProfile;
  },
  result: ChapterExtractionResult,
  chapters: BoundedSourceChapter[],
): Promise<void> {
  const pos =
    chapters.length > 0
      ? chapters[chapters.length - 1].position
      : (0 as ReturnType<typeof asSourcePosition>);
  const fromPos =
    chapters.length > 0
      ? chapters[0].position
      : (0 as ReturnType<typeof asSourcePosition>);
  const ts = now();

  // Load existing characters for this snapshot.
  const [charRows] = await db.executeSql(
    `SELECT id, canonical_name FROM canon_characters
      WHERE snapshot_id = ? AND review_status != 'superseded'`,
    [ctx.snapshotId],
  );
  const nameToId = new Map<string, number>();
  for (let i = 0; i < charRows.rows.length; i++) {
    const row = charRows.rows.item(i);
    nameToId.set(nameKey(row.canonical_name), row.id);
  }

  const ensureCharacter = async (
    name: string,
    importance: string,
    description: string,
    confidence: number,
  ): Promise<number> => {
    const key = nameKey(name);
    const existing = nameToId.get(key);
    if (existing) return existing;
    await execute(
      db,
      `INSERT INTO canon_characters (
        project_id, source_id, snapshot_id, analysis_run_id,
        valid_from_position, valid_to_position, first_observed_position, last_observed_position,
        confidence, review_status, origin, extraction_version, revision, supersedes_id,
        user_reviewed_at, created_at, updated_at,
        canonical_name, description, background, appearance_json, personality_json,
        values_json, behavior_patterns_json, speech_style_json, abilities_json,
        weaknesses_json, goals_json, fears_json, secrets_json,
        first_appearance_position, importance
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 'pending', 'ai', ?, 1, NULL, NULL, ?, ?,
        ?, ?, '', '{}', '{}', '[]', '[]', '{}', '[]', '[]', '[]', '[]', '[]', ?, ?)`,
      [
        ctx.projectId,
        ctx.sourceId,
        ctx.snapshotId,
        ctx.runId,
        fromPos,
        fromPos,
        pos,
        confidence,
        EXTRACTION_VERSION,
        ts,
        ts,
        name,
        description,
        fromPos,
        importance,
      ],
    );
    const id = await lastInsertId(db);
    nameToId.set(key, id);
    return id;
  };

  for (const ch of result.characters) {
    const id = await ensureCharacter(
      ch.canonicalName,
      ch.importance,
      ch.description,
      ch.confidence,
    );
    for (const ev of ch.evidence) {
      await insertEvidenceAndLink(
        db,
        {
          projectId: ctx.projectId,
          sourceId: ctx.sourceId,
          snapshotId: ctx.snapshotId,
          analysisRunId: ctx.runId,
          boundaryExclusive: ctx.boundaryExclusive,
          candidate: ev,
        },
        'character',
        id,
      );
    }
    for (const alias of ch.aliases) {
      await execute(
        db,
        `INSERT INTO canon_character_aliases (
          project_id, source_id, snapshot_id, analysis_run_id,
          valid_from_position, valid_to_position, first_observed_position, last_observed_position,
          confidence, review_status, origin, extraction_version, revision, supersedes_id,
          user_reviewed_at, created_at, updated_at,
          character_id, alias, alias_normalized, alias_type, is_ambiguous
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 'pending', 'ai', ?, 1, NULL, NULL, ?, ?,
          ?, ?, ?, 'title', 0)`,
        [
          ctx.projectId,
          ctx.sourceId,
          ctx.snapshotId,
          ctx.runId,
          fromPos,
          fromPos,
          pos,
          ch.confidence,
          EXTRACTION_VERSION,
          ts,
          ts,
          id,
          alias,
          nameKey(alias),
        ],
      );
    }
  }

  for (const rule of result.worldRules) {
    await execute(
      db,
      `INSERT INTO canon_world_rules (
        project_id, source_id, snapshot_id, analysis_run_id,
        valid_from_position, valid_to_position, first_observed_position, last_observed_position,
        confidence, review_status, origin, extraction_version, revision, supersedes_id,
        user_reviewed_at, created_at, updated_at,
        category, title, description, constraint_level
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 'pending', 'ai', ?, 1, NULL, NULL, ?, ?,
        ?, ?, ?, ?)`,
      [
        ctx.projectId,
        ctx.sourceId,
        ctx.snapshotId,
        ctx.runId,
        fromPos,
        fromPos,
        pos,
        rule.confidence,
        EXTRACTION_VERSION,
        ts,
        ts,
        rule.category,
        rule.title,
        rule.description,
        rule.constraintLevel,
      ],
    );
    const ruleId = await lastInsertId(db);
    for (const ev of rule.evidence) {
      await insertEvidenceAndLink(
        db,
        {
          projectId: ctx.projectId,
          sourceId: ctx.sourceId,
          snapshotId: ctx.snapshotId,
          analysisRunId: ctx.runId,
          boundaryExclusive: ctx.boundaryExclusive,
          candidate: ev,
        },
        'world_rule',
        ruleId,
      );
    }
  }

  if (ctx.profile !== 'quick') {
    for (const rel of result.relationships) {
      const srcId = await ensureCharacter(
        rel.sourceName,
        'supporting',
        '',
        rel.confidence,
      );
      const tgtId = await ensureCharacter(
        rel.targetName,
        'supporting',
        '',
        rel.confidence,
      );
      await execute(
        db,
        `INSERT INTO canon_relationships (
          project_id, source_id, snapshot_id, analysis_run_id,
          valid_from_position, valid_to_position, first_observed_position, last_observed_position,
          confidence, review_status, origin, extraction_version, revision, supersedes_id,
          user_reviewed_at, created_at, updated_at,
          source_character_id, target_character_id, relation_type, attitude,
          public_status, description, causes_json
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 'pending', 'ai', ?, 1, NULL, NULL, ?, ?,
          ?, ?, ?, ?, ?, ?, '[]')`,
        [
          ctx.projectId,
          ctx.sourceId,
          ctx.snapshotId,
          ctx.runId,
          fromPos,
          fromPos,
          pos,
          rel.confidence,
          EXTRACTION_VERSION,
          ts,
          ts,
          srcId,
          tgtId,
          rel.relationType,
          rel.attitude,
          rel.publicStatus,
          rel.description,
        ],
      );
      const relId = await lastInsertId(db);
      for (const ev of rel.evidence) {
        await insertEvidenceAndLink(
          db,
          {
            projectId: ctx.projectId,
            sourceId: ctx.sourceId,
            snapshotId: ctx.snapshotId,
            analysisRunId: ctx.runId,
            boundaryExclusive: ctx.boundaryExclusive,
            candidate: ev,
          },
          'relationship',
          relId,
        );
      }
    }
  }

  for (const plot of result.plotThreads) {
    await execute(
      db,
      `INSERT INTO canon_plot_threads (
        project_id, source_id, snapshot_id, analysis_run_id,
        valid_from_position, valid_to_position, first_observed_position, last_observed_position,
        confidence, review_status, origin, extraction_version, revision, supersedes_id,
        user_reviewed_at, created_at, updated_at,
        title, description, level, status, importance, start_position,
        last_advanced_position, resolved_position, established_facts_json,
        unresolved_questions_json, expected_directions_json
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 'pending', 'ai', ?, 1, NULL, NULL, ?, ?,
        ?, ?, ?, ?, 0, ?, ?, NULL, '[]', '[]', '[]')`,
      [
        ctx.projectId,
        ctx.sourceId,
        ctx.snapshotId,
        ctx.runId,
        fromPos,
        fromPos,
        pos,
        plot.confidence,
        EXTRACTION_VERSION,
        ts,
        ts,
        plot.title,
        plot.description,
        plot.level,
        plot.status,
        fromPos,
        pos,
      ],
    );
    const plotId = await lastInsertId(db);
    for (const name of plot.characterNames) {
      const cid = await ensureCharacter(
        name,
        'supporting',
        '',
        plot.confidence,
      );
      await execute(
        db,
        `INSERT OR IGNORE INTO canon_plot_thread_characters
          (snapshot_id, plot_thread_id, character_id, role, created_at)
          VALUES (?, ?, ?, '', ?)`,
        [ctx.snapshotId, plotId, cid, ts],
      );
    }
    for (const ev of plot.evidence) {
      await insertEvidenceAndLink(
        db,
        {
          projectId: ctx.projectId,
          sourceId: ctx.sourceId,
          snapshotId: ctx.snapshotId,
          analysisRunId: ctx.runId,
          boundaryExclusive: ctx.boundaryExclusive,
          candidate: ev,
        },
        'plot_thread',
        plotId,
      );
    }
  }

  for (const exp of result.experiences) {
    const cid = await ensureCharacter(
      exp.characterName,
      'supporting',
      '',
      exp.confidence,
    );
    await execute(
      db,
      `INSERT INTO canon_character_experiences (
        project_id, source_id, snapshot_id, analysis_run_id,
        valid_from_position, valid_to_position, first_observed_position, last_observed_position,
        confidence, review_status, origin, extraction_version, revision, supersedes_id,
        user_reviewed_at, created_at, updated_at,
        character_id, chapter_position, event_type, title, description,
        involved_character_ids_json, impact_on_personality, impact_on_goal,
        impact_on_relationship, knowledge_gained_json, secrets_learned_json, importance
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 'pending', 'ai', ?, 1, NULL, NULL, ?, ?,
        ?, ?, ?, ?, ?, '[]', NULL, NULL, NULL, '[]', '[]', ?)`,
      [
        ctx.projectId,
        ctx.sourceId,
        ctx.snapshotId,
        ctx.runId,
        pos,
        pos,
        pos,
        exp.confidence,
        EXTRACTION_VERSION,
        ts,
        ts,
        cid,
        pos,
        exp.eventType,
        exp.title,
        exp.description,
        exp.importance,
      ],
    );
    const expId = await lastInsertId(db);
    for (const ev of exp.evidence) {
      await insertEvidenceAndLink(
        db,
        {
          projectId: ctx.projectId,
          sourceId: ctx.sourceId,
          snapshotId: ctx.snapshotId,
          analysisRunId: ctx.runId,
          boundaryExclusive: ctx.boundaryExclusive,
          candidate: ev,
        },
        'experience',
        expId,
      );
    }
  }

  if (ctx.profile !== 'quick') {
    for (const k of result.knowledge) {
      const cid = await ensureCharacter(
        k.characterName,
        'supporting',
        '',
        k.confidence,
      );
      await execute(
        db,
        `INSERT INTO canon_character_knowledge (
          project_id, source_id, snapshot_id, analysis_run_id,
          valid_from_position, valid_to_position, first_observed_position, last_observed_position,
          confidence, review_status, origin, extraction_version, revision, supersedes_id,
          user_reviewed_at, created_at, updated_at,
          character_id, fact_key, fact_summary, knowledge_state, learned_position,
          learned_from_character_id, misunderstanding_summary
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 'pending', 'ai', ?, 1, NULL, NULL, ?, ?,
          ?, ?, ?, ?, ?, NULL, NULL)`,
        [
          ctx.projectId,
          ctx.sourceId,
          ctx.snapshotId,
          ctx.runId,
          pos,
          pos,
          pos,
          k.confidence,
          EXTRACTION_VERSION,
          ts,
          ts,
          cid,
          k.factKey,
          k.factSummary,
          k.knowledgeState,
          pos,
        ],
      );
    }

    for (const st of result.states) {
      const cid = await ensureCharacter(
        st.characterName,
        'supporting',
        '',
        st.confidence,
      );
      await execute(
        db,
        `INSERT INTO canon_character_state_snapshots (
          project_id, source_id, snapshot_id, analysis_run_id,
          valid_from_position, valid_to_position, first_observed_position, last_observed_position,
          confidence, review_status, origin, extraction_version, revision, supersedes_id,
          user_reviewed_at, created_at, updated_at,
          character_id, chapter_position, location, physical_state, emotional_state,
          identity_state, organization_state, current_goal, possessions_json,
          abilities_state_json, alive_state, summary
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 'pending', 'ai', ?, 1, NULL, NULL, ?, ?,
          ?, ?, ?, ?, ?, NULL, NULL, NULL, '[]', '{}', ?, ?)`,
        [
          ctx.projectId,
          ctx.sourceId,
          ctx.snapshotId,
          ctx.runId,
          pos,
          pos,
          pos,
          st.confidence,
          EXTRACTION_VERSION,
          ts,
          ts,
          cid,
          pos,
          st.location,
          st.physicalState,
          st.emotionalState,
          st.aliveState,
          st.summary,
        ],
      );
    }

    for (const ev of result.timelineEvents) {
      await execute(
        db,
        `INSERT INTO canon_timeline_events (
          project_id, source_id, snapshot_id, analysis_run_id,
          valid_from_position, valid_to_position, first_observed_position, last_observed_position,
          confidence, review_status, origin, extraction_version, revision, supersedes_id,
          user_reviewed_at, created_at, updated_at,
          event_key, title, summary, event_type, chapter_position, char_start, char_end,
          participant_character_ids_json, location_before, location_after,
          relative_time_json, causes_event_ids_json, consequences_event_ids_json, importance
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 'pending', 'ai', ?, 1, NULL, NULL, ?, ?,
          ?, ?, ?, ?, ?, NULL, NULL, '[]', NULL, NULL, '{}', '[]', '[]', ?)`,
        [
          ctx.projectId,
          ctx.sourceId,
          ctx.snapshotId,
          ctx.runId,
          pos,
          pos,
          pos,
          ev.confidence,
          EXTRACTION_VERSION,
          ts,
          ts,
          ev.eventKey,
          ev.title,
          ev.summary,
          ev.eventType,
          pos,
          ev.importance,
        ],
      );
      const tid = await lastInsertId(db);
      for (const e of ev.evidence) {
        await insertEvidenceAndLink(
          db,
          {
            projectId: ctx.projectId,
            sourceId: ctx.sourceId,
            snapshotId: ctx.snapshotId,
            analysisRunId: ctx.runId,
            boundaryExclusive: ctx.boundaryExclusive,
            candidate: e,
          },
          'timeline_event',
          tid,
        );
      }
    }
  }
}

async function buildCoverage(
  db: SQLite.SQLiteDatabase,
  snapshotId: string,
  profile: AnalysisProfile,
  analyzedChapters: number,
  totalChapters: number,
  throughPos: number,
  scope: AnalysisScope,
  analyzedRanges: CanonCoverage['analyzedRanges'],
): Promise<{ capabilities: CanonCapabilities; coverage: CanonCoverage }> {
  const count = async (table: string) => {
    const [r] = await db.executeSql(
      `SELECT COUNT(*) AS c FROM ${table}
        WHERE snapshot_id = ? AND review_status NOT IN ('superseded', 'ignored')`,
      [snapshotId],
    );
    return r.rows.item(0).c as number;
  };
  const worldRules = await count('canon_world_rules');
  const characters = await count('canon_characters');
  const states = await count('canon_character_state_snapshots');
  const relationships = await count('canon_relationships');
  const plotThreads = await count('canon_plot_threads');
  const experiences = await count('canon_character_experiences');
  const knowledge = await count('canon_character_knowledge');
  const timeline = await count('canon_timeline_events');
  const orphans = await countOrphanEvidence(snapshotId);
  const future = await countFutureEvidence(
    snapshotId,
    // boundary checked separately; use large default here only for count of bad rows
    Number.MAX_SAFE_INTEGER,
  );
  void future;

  const caps = emptyCapabilities(profile);
  caps.worldRules = worldRules > 0;
  caps.characterProfiles = characters > 0;
  caps.characterStates = states > 0;
  caps.relationships = relationships > 0;
  caps.plotThreads = plotThreads > 0;
  caps.experiences = experiences > 0;
  caps.knowledgeBoundaries = knowledge > 0;
  caps.timelineEvents = timeline > 0;
  caps.evidenceValidated = orphans === 0;

  const incomplete: string[] = [];
  if (!caps.evidenceValidated) incomplete.push('orphan_evidence');
  if (analyzedChapters < totalChapters)
    incomplete.push('partial_chapter_coverage');

  const coverage: CanonCoverage = {
    schemaVersion: 2,
    sourceChapterCount: totalChapters,
    analyzedChapterCount: analyzedChapters,
    analyzedThroughPosition: asSourcePosition(throughPos),
    scope,
    analyzedRanges,
    categoryCounts: {
      worldRules,
      characterProfiles: characters,
      characterStates: states,
      relationships,
      plotThreads,
      experiences,
      knowledgeBoundaries: knowledge,
      timelineEvents: timeline,
      evidenceValidated: orphans === 0 ? 1 : 0,
    },
    incompleteReasons: incomplete,
  };
  return { capabilities: caps, coverage };
}

/** Start a new analysis run bound to a Phase 1 source snapshot (Spec §8.1). */
export async function startAnalysis(
  input: StartAnalysisInput,
): Promise<{ runId: string; snapshotId: string }> {
  const preset = ANALYSIS_MODE_PRESETS[input.mode];
  if (!preset) throw new Error('不支持的原著分析模式');
  const sourceSnapshot = await continuationSourceReader.getSnapshot(
    input.projectId,
  );
  const allChapters = await continuationSourceReader.listBoundedSourceChapters(
    sourceSnapshot,
  );
  if (allChapters.length === 0) {
    throw new Error('边界内没有可分析章节。');
  }
  const plan = planAnalysisScope(allChapters, preset.scope);
  if (plan.nearChapters.length === 0) {
    throw new Error('当前分析范围内没有可分析章节。');
  }
  const { profile } = preset;
  let modelConfigId = input.modelConfigId ?? null;
  // Both supported analysis modes require an LLM. Capturing the selected
  // configuration keeps an interrupted run bound to one provider/model.
  const requestConfig = modelConfigId
    ? await resolveLLMRequestConfigById(modelConfigId)
    : await resolveLLMRequestConfig();
  if (!requestConfig.id) {
    throw new Error('当前 LLM 配置无效，请在设置中重新保存并启用。');
  }
  modelConfigId = requestConfig.id;

  const snapshotId = v4();
  const runId = v4();
  const perBatch = Math.max(1, input.chaptersPerBatch ?? 3);
  const batches: Array<{
    runId: string;
    canonSnapshotId: string;
    batchIndex: number;
    startPosition: number;
    endPosition: number;
    inputHash: string;
    idempotencyKey: string;
  }> = [];

  for (let i = 0; i < plan.nearChapters.length; i += perBatch) {
    const slice = plan.nearChapters.slice(i, i + perBatch);
    const start = slice[0].position;
    const end = slice[slice.length - 1].position + 1; // half-open
    const inputHash = sha256Hex(
      slice
        .map(c => `${c.id}:${c.content.length}:${c.range.start}-${c.range.end}`)
        .join('|'),
    );
    batches.push({
      runId,
      canonSnapshotId: snapshotId,
      batchIndex: batches.length,
      startPosition: start,
      endPosition: end,
      inputHash,
      idempotencyKey: `${runId}:${batches.length}:${inputHash}`,
    });
  }

  const db = await openDatabase();
  await insertSnapshot(db, {
    id: snapshotId,
    projectId: input.projectId,
    sourceId: sourceSnapshot.sourceId,
    analysisRunId: runId,
    sourceVersion: sourceSnapshot.sourceVersion,
    sourceSha256: sourceSnapshot.normalizedSha256,
    parserVersion: sourceSnapshot.parserVersion,
    normalizationVersion: sourceSnapshot.normalizationVersion,
    boundaryChapterId: sourceSnapshot.boundary.chapterId,
    boundaryPosition: sourceSnapshot.boundary.chapterPosition,
    boundaryCharOffsetExclusive: sourceSnapshot.boundary.charOffsetExclusive,
    extractionVersion: EXTRACTION_VERSION,
    profile,
    status: 'staging',
    capabilities: emptyCapabilities(profile),
    coverage: emptyCoverage(sourceSnapshot.boundary.chapterPosition),
  });
  await insertRun(db, {
    id: runId,
    projectId: input.projectId,
    sourceId: sourceSnapshot.sourceId,
    sourceVersion: sourceSnapshot.sourceVersion,
    sourceSha256: sourceSnapshot.normalizedSha256,
    parserVersion: sourceSnapshot.parserVersion,
    normalizationVersion: sourceSnapshot.normalizationVersion,
    boundaryChapterId: sourceSnapshot.boundary.chapterId,
    boundaryPosition: sourceSnapshot.boundary.chapterPosition,
    boundaryCharOffsetExclusive: sourceSnapshot.boundary.charOffsetExclusive,
    canonSnapshotId: snapshotId,
    profile,
    modelConfigId,
    state: 'queued',
    stage: 'snapshot',
    progressCurrent: 0,
    progressTotal: batches.length * ANALYSIS_MATERIAL_TYPES.length,
    extractionVersion: EXTRACTION_VERSION,
  });
  await insertBatches(db, batches);
  await insertWorkItems(
    db,
    batches.flatMap(batch =>
      ANALYSIS_MATERIAL_TYPES.map(materialType => ({
        runId,
        batchIndex: batch.batchIndex,
        materialType,
      })),
    ),
  );
  await execute(
    db,
    `UPDATE continuation_settings SET analysis_status = 'running', updated_at = ?
      WHERE project_id = ?`,
    [now(), input.projectId],
  );

  // The complete plan is persisted so resume cannot silently widen a tail run.
  await updateRunState(db, runId, {
    checkpointJson: JSON.stringify({
      schemaVersion: 2,
      mode: input.mode,
      extractorMode: 'llm',
      scope: plan.effectiveScope,
      plannedChapterIds: plan.nearChapters.map(chapter => chapter.id),
      plannedRanges: plan.analyzedRanges,
    }),
  });

  return { runId, snapshotId };
}

async function assertSourceStillValid(
  run: AnalysisRun,
): Promise<ContinuationSourceSnapshot> {
  try {
    const live = await continuationSourceReader.getSnapshot(run.projectId);
    if (
      live.sourceId !== run.sourceId ||
      live.sourceVersion !== run.sourceVersion ||
      live.normalizedSha256 !== run.sourceSha256 ||
      live.parserVersion !== run.parserVersion ||
      live.normalizationVersion !== run.normalizationVersion ||
      live.boundary.chapterId !== run.boundaryChapterId ||
      live.boundary.charOffsetExclusive !== run.boundaryCharOffsetExclusive
    ) {
      throw new ContinuationSnapshotOutdatedError();
    }
    return live;
  } catch (e) {
    if (e instanceof ContinuationSnapshotOutdatedError) throw e;
    throw new ContinuationSnapshotOutdatedError(
      e instanceof Error ? e.message : '源快照校验失败',
    );
  }
}

/** Process all queued batches for a run (Spec §8.2–8.7). */
async function processAnalysisRunInner(
  runId: string,
  options: ProcessAnalysisOptions,
  signal: AbortSignal,
): Promise<AnalysisRun> {
  const db = await openDatabase();
  let run = await getRunById(runId);
  if (!run) throw new Error('分析任务不存在');
  if (run.profile === 'quick') {
    throw new Error('旧版 Quick 离线预览已退役，请重新发起 LLM 原著分析。');
  }
  if (
    run.state === 'completed' ||
    run.state === 'cancelled' ||
    run.state === 'outdated'
  ) {
    return run;
  }

  let sourceSnapshot: ContinuationSourceSnapshot;
  try {
    sourceSnapshot = await assertSourceStillValid(run);
  } catch (e) {
    await updateRunState(db, runId, {
      state: 'outdated',
      errorCode: 'source_snapshot_changed',
      errorMessage: e instanceof Error ? e.message : '源已变化',
    });
    await updateSnapshotMeta(db, run.canonSnapshotId, { status: 'outdated' });
    await execute(
      db,
      `UPDATE continuation_settings SET analysis_status = 'outdated', updated_at = ?
        WHERE project_id = ?`,
      [now(), run.projectId],
    );
    throw e;
  }

  let checkpoint: {
    extractorMode?: 'llm' | 'deterministic';
    scope?: AnalysisScope;
  } = {};
  try {
    checkpoint = run.checkpointJson ? JSON.parse(run.checkpointJson) : {};
  } catch {
    // Old/corrupt checkpoint metadata must not make an already persisted batch
    // range expand. Batches remain the source of truth; use full only for the
    // coverage label of legacy online runs.
  }
  if (checkpoint.extractorMode && checkpoint.extractorMode !== 'llm') {
    throw new Error('旧版 Quick 离线预览已退役，请重新发起 LLM 原著分析。');
  }
  const scope = normalizeAnalysisScope(checkpoint.scope);

  await updateRunState(db, runId, {
    state: 'running',
    stage: 'chapter_extraction',
  });

  const batches = await listBatches(runId);
  const allChapters = await continuationSourceReader.listBoundedSourceChapters(
    sourceSnapshot,
  );
  const reportWorkItem = async (
    materialType: AnalysisMaterialType,
    batchIndex: number,
    state: AnalysisProgressUpdate['state'],
  ) => {
    const items = await listWorkItems(runId);
    const completed = items.filter(item => item.state === 'completed').length;
    await updateRunState(db, runId, {
      stage: 'chapter_extraction',
      progressCurrent: completed,
      progressTotal: batches.length * ANALYSIS_MATERIAL_TYPES.length,
    });
    options.onProgress?.({
      runId,
      stage: 'chapter_extraction',
      progressCurrent: completed,
      progressTotal: batches.length * ANALYSIS_MATERIAL_TYPES.length,
      materialType,
      batchIndex,
      state,
    });
  };

  for (const batch of batches) {
    if (batch.state === 'completed') continue;
    const ts = now();
    await execute(
      db,
      `UPDATE continuation_analysis_batches SET state = 'running', attempt_count = attempt_count + 1, updated_at = ?
        WHERE run_id = ? AND batch_index = ?`,
      [ts, runId, batch.batchIndex],
    );

    try {
      const slice = allChapters.filter(
        c =>
          c.position >= batch.startPosition && c.position < batch.endPosition,
      );
      // Future leakage guard: only chapters already bounded by SourceReader.
      for (const ch of slice) {
        if (ch.range.end > sourceSnapshot.boundary.charOffsetExclusive) {
          throw new Error('批次章节越过边界');
        }
      }

      const batchItems = (await listWorkItems(runId)).filter(
        item => item.batchIndex === batch.batchIndex,
      );
      const runMaterial = async (materialType: AnalysisMaterialType) => {
        if (signal.aborted) throw new Error('分析已暂停或取消');
        const item = batchItems.find(
          candidate => candidate.materialType === materialType,
        );
        if (item?.state === 'completed' && item.resultJson) {
          return parseExtractionResultJson(item.resultJson);
        }
        await updateWorkItem(db, {
          runId,
          batchIndex: batch.batchIndex,
          materialType,
          state: 'running',
          incrementAttempt: true,
          errorCode: null,
          errorMessage: null,
        });
        await reportWorkItem(materialType, batch.batchIndex, 'running');
        try {
          const result = await extractMaterialWithLlm(
            slice,
            run.profile,
            run.modelConfigId,
            materialType,
            runId,
            signal,
          );
          if (signal.aborted) throw new Error('分析已暂停或取消');
          await updateWorkItem(db, {
            runId,
            batchIndex: batch.batchIndex,
            materialType,
            state: 'completed',
            resultJson: JSON.stringify(result),
            errorCode: null,
            errorMessage: null,
            completedAt: now(),
          });
          await reportWorkItem(materialType, batch.batchIndex, 'completed');
          return result;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          await updateWorkItem(db, {
            runId,
            batchIndex: batch.batchIndex,
            materialType,
            state: signal.aborted ? 'cancelled' : 'failed',
            errorCode: signal.aborted ? 'cancelled' : 'material_failed',
            errorMessage: message,
          });
          await reportWorkItem(
            materialType,
            batch.batchIndex,
            signal.aborted ? 'cancelled' : 'failed',
          );
          throw error;
        }
      };
      const settled = await Promise.allSettled(
        ANALYSIS_MATERIAL_TYPES.map(runMaterial),
      );
      const rejected = settled.find(
        (entry): entry is PromiseRejectedResult => entry.status === 'rejected',
      );
      if (rejected) throw rejected.reason;
      const latest = await getRunById(runId);
      if (!latest || latest.state !== 'running' || signal.aborted) {
        return latest ?? run;
      }
      const extraction = mergeMaterialResults(
        settled.map(
          entry =>
            (entry as PromiseFulfilledResult<ChapterExtractionResult>).value,
        ),
      );

      await materializeBatchResult(
        db,
        {
          projectId: run.projectId,
          sourceId: run.sourceId,
          snapshotId: run.canonSnapshotId,
          runId,
          boundaryExclusive: run.boundaryCharOffsetExclusive,
          profile: run.profile,
        },
        extraction,
        slice,
      );

      await execute(
        db,
        `UPDATE continuation_analysis_batches SET
          state = 'completed', result_json = ?, error_code = NULL, error_message = NULL,
          updated_at = ?, completed_at = ?
          WHERE run_id = ? AND batch_index = ?`,
        [JSON.stringify(extraction), now(), now(), runId, batch.batchIndex],
      );
    } catch (err) {
      if (signal.aborted) {
        await execute(
          db,
          `UPDATE continuation_analysis_batches SET state = 'cancelled', updated_at = ?
            WHERE run_id = ? AND batch_index = ?`,
          [now(), runId, batch.batchIndex],
        );
        return (await getRunById(runId)) ?? run;
      }
      const message = err instanceof Error ? err.message : String(err);
      await execute(
        db,
        `UPDATE continuation_analysis_batches SET
          state = 'failed', error_code = 'batch_failed', error_message = ?, updated_at = ?
          WHERE run_id = ? AND batch_index = ?`,
        [message, now(), runId, batch.batchIndex],
      );
      // Continue other batches; finalizing will decide overall state.
    }
  }

  // Evidence validation + finalize
  await updateRunState(db, runId, { stage: 'evidence_validation' });
  const futureCount = await countFutureEvidence(
    run.canonSnapshotId,
    run.boundaryCharOffsetExclusive,
  );
  if (futureCount > 0) {
    await updateRunState(db, runId, {
      state: 'failed',
      stage: 'evidence_validation',
      errorCode: 'future_leakage',
      errorMessage: `检测到 ${futureCount} 条越过边界的证据`,
      completedAt: now(),
    });
    await updateSnapshotMeta(db, run.canonSnapshotId, { status: 'failed' });
    await execute(
      db,
      `UPDATE continuation_settings SET analysis_status = 'failed', updated_at = ?
        WHERE project_id = ?`,
      [now(), run.projectId],
    );
    return (await getRunById(runId))!;
  }

  const failedBatches = (await listBatches(runId)).filter(
    b => b.state === 'failed',
  );
  const completedBatches = (await listBatches(runId)).filter(
    b => b.state === 'completed',
  );

  await updateRunState(db, runId, { stage: 'finalizing' });
  const analyzedRanges = completedBatches.map(batch => ({
    startPosition: asSourcePosition(batch.startPosition),
    endPosition: asSourcePosition(batch.endPosition),
  }));
  const analyzedChapters = allChapters.filter(chapter =>
    completedBatches.some(
      batch =>
        chapter.position >= batch.startPosition &&
        chapter.position < batch.endPosition,
    ),
  ).length;
  const analyzedThroughPosition = completedBatches.reduce(
    (max, batch) => Math.max(max, batch.endPosition - 1),
    0,
  );
  const { capabilities, coverage } = await buildCoverage(
    db,
    run.canonSnapshotId,
    run.profile,
    analyzedChapters,
    allChapters.length,
    analyzedThroughPosition,
    scope,
    analyzedRanges,
  );

  if (failedBatches.length > 0) {
    await updateRunState(db, runId, {
      state: 'failed',
      stage: 'chapter_extraction',
      errorCode: 'batch_failed',
      errorMessage: `有 ${failedBatches.length}/${
        batches.length
      } 个分析批次失败：${
        failedBatches[0]?.errorMessage ?? '请检查模型配置和网络后重试'
      }`,
      completedAt: now(),
    });
    await updateSnapshotMeta(db, run.canonSnapshotId, {
      status: 'failed',
      capabilities,
      coverage,
    });
    await execute(
      db,
      `UPDATE continuation_settings SET analysis_status = 'failed', updated_at = ?
        WHERE project_id = ?`,
      [now(), run.projectId],
    );
    return (await getRunById(runId))!;
  }

  // Do NOT auto-activate. Enter awaiting_review (Spec §8.7).
  await updateSnapshotMeta(db, run.canonSnapshotId, {
    status: 'awaiting_review',
    capabilities,
    coverage,
  });
  await updateRunState(db, runId, {
    state: 'awaiting_review',
    stage: 'finalizing',
    progressCurrent: completedBatches.length * ANALYSIS_MATERIAL_TYPES.length,
    progressTotal: batches.length * ANALYSIS_MATERIAL_TYPES.length,
    completedAt: now(),
  });
  await execute(
    db,
    `UPDATE continuation_settings SET analysis_status = 'running', updated_at = ?
      WHERE project_id = ?`,
    [now(), run.projectId],
  );

  return (await getRunById(runId))!;
}

function emptyExtractionResult(): ChapterExtractionResult {
  return {
    schemaVersion: 1,
    worldRules: [],
    characters: [],
    relationships: [],
    plotThreads: [],
    experiences: [],
    knowledge: [],
    states: [],
    timelineEvents: [],
  };
}

function onlyMaterial(
  result: ChapterExtractionResult,
  materialType: AnalysisMaterialType,
): ChapterExtractionResult {
  const filtered = emptyExtractionResult();
  if (materialType === 'world_rules') filtered.worldRules = result.worldRules;
  if (materialType === 'characters') {
    filtered.characters = result.characters;
    filtered.knowledge = result.knowledge;
    filtered.states = result.states;
  }
  if (materialType === 'relationships')
    filtered.relationships = result.relationships;
  if (materialType === 'plot_threads') {
    filtered.plotThreads = result.plotThreads;
    filtered.timelineEvents = result.timelineEvents;
  }
  if (materialType === 'experiences') filtered.experiences = result.experiences;
  return filtered;
}

function mergeMaterialResults(
  results: ChapterExtractionResult[],
): ChapterExtractionResult {
  return results.reduce<ChapterExtractionResult>(
    (merged, result) => ({
      schemaVersion: 1,
      worldRules: [...merged.worldRules, ...result.worldRules],
      characters: [...merged.characters, ...result.characters],
      relationships: [...merged.relationships, ...result.relationships],
      plotThreads: [...merged.plotThreads, ...result.plotThreads],
      experiences: [...merged.experiences, ...result.experiences],
      knowledge: [...merged.knowledge, ...result.knowledge],
      states: [...merged.states, ...result.states],
      timelineEvents: [...merged.timelineEvents, ...result.timelineEvents],
    }),
    emptyExtractionResult(),
  );
}

const MATERIAL_PROMPTS: Record<AnalysisMaterialType, string> = {
  world_rules: '只填写 worldRules；其他数组必须为空。',
  characters: '只填写 characters、knowledge、states；其他数组必须为空。',
  relationships: '只填写 relationships；其他数组必须为空。',
  plot_threads: '只填写 plotThreads、timelineEvents；其他数组必须为空。',
  experiences: '只填写 experiences；其他数组必须为空。',
};

export async function extractMaterialWithLlm(
  chapters: BoundedSourceChapter[],
  profile: AnalysisProfile,
  modelConfigId: number | null,
  materialType: AnalysisMaterialType,
  runId: string,
  signal: AbortSignal,
): Promise<ChapterExtractionResult> {
  if (!modelConfigId) {
    throw new Error(
      '分析任务缺少 LLM 配置；请重新发起 Standard 或 Deep 分析。',
    );
  }
  const requestConfig = await resolveLLMRequestConfigById(modelConfigId);
  const prompt = [
    '你是严谨的原著 Canon 分析器。只允许根据下面给出的章节正文提取事实，禁止利用外部知识或补写。',
    '必须只返回一个完整、可 JSON.parse 的 JSON 对象，不要 Markdown、思考过程、解释或任何前后缀。schemaVersion 必须为 1，八个数组字段都必须出现，不能返回 null 或空白。',
    `分析档位：${profile}。${MATERIAL_PROMPTS[materialType]}`,
    '每一个数组条目都必须至少有一条 evidence。evidence 必须引用本批章节中连续、逐字一致的原文片段作为 quotePreview（不超过 160 字）。',
    '每章 metadata 给出 bodyStart 和 bodyEnd：charStart/charEnd 是全书 UTF-16 绝对偏移；请使用 quotePreview 在该章正文中定位后填写，不能猜测。',
    'JSON 结构：{"schemaVersion":1,"worldRules":[],"characters":[],"relationships":[],"plotThreads":[],"experiences":[],"knowledge":[],"states":[],"timelineEvents":[]}。',
    '章节正文：',
    ...chapters.map(
      c =>
        `### ${c.title} (chapterId=${c.id}, position=${c.position}, bodyStart=${
          c.range.start
        }, bodyEnd=${c.range.end})\n${c.content.slice(0, 6000)}`,
    ),
  ].join('\n');
  let lastOutputError: Error | null = null;
  for (
    let attempt = 1;
    attempt <= CANON_ANALYSIS_RETRY_POLICY.maxAttempts;
    attempt += 1
  ) {
    try {
      const retryInstruction =
        attempt > 1
          ? '\n上一轮输出无法解析或不符合 schema。请重新生成完整 JSON；不要复用上轮文本，也不要输出任何解释、Markdown 或思考过程。'
          : '';
      const response = await callLLMResult(
        [{ role: 'user', content: `${prompt}${retryInstruction}` }],
        profile === 'deep' ? 8000 : 5000,
        {
          responseFormat: 'json_object',
          temperature: 0.1,
          queueClass: 'canon_analysis',
          queuePriority: 'background',
          scenario: 'continuation_canon_analysis',
          taskId: runId,
          requestConfig,
        },
        signal,
      );
      if (!response?.text?.trim()) {
        throw canonOutputError('LLM 未返回分析结果');
      }
      try {
        return onlyMaterial(
          parseExtractionResultJson(response.text),
          materialType,
        );
      } catch (error) {
        throw canonOutputError(
          error instanceof Error ? error.message : '提取结果不是合法 JSON',
        );
      }
    } catch (error) {
      const canRetry =
        attempt < CANON_ANALYSIS_RETRY_POLICY.maxAttempts &&
        !signal.aborted &&
        (isTransientCanonAnalysisError(error) ||
          isRecoverableCanonOutputError(error));
      if (!canRetry) {
        if (isRecoverableCanonOutputError(error)) {
          lastOutputError = error as Error;
          break;
        }
        throw error;
      }
      await waitForCanonRetry(
        signal,
        CANON_ANALYSIS_RETRY_POLICY.baseDelayMs * 2 ** (attempt - 1),
      );
    }
  }
  if (lastOutputError) {
    throw new Error(
      `${ANALYSIS_MATERIAL_LABELS[materialType]}的模型输出连续 ${CANON_ANALYSIS_RETRY_POLICY.maxAttempts} 次无效：${lastOutputError.message}。请检查模型是否支持 JSON 输出后重试。`,
    );
  }
  throw new Error('LLM 未返回分析结果。');
}

/** One in-process owner per run prevents two screens from processing it twice. */
export function processAnalysisRun(
  runId: string,
  options: ProcessAnalysisOptions = {},
): Promise<AnalysisRun> {
  const active = analysisProcesses.get(runId);
  if (active) return active;
  const controller = new AbortController();
  analysisControllers.set(runId, controller);
  const process = processAnalysisRunInner(
    runId,
    options,
    controller.signal,
  ).finally(() => {
    analysisControllers.delete(runId);
    analysisProcesses.delete(runId);
  });
  analysisProcesses.set(runId, process);
  return process;
}

export async function extractWithLlm(
  chapters: BoundedSourceChapter[],
  profile: AnalysisProfile,
  modelConfigId: number | null,
): Promise<ChapterExtractionResult> {
  if (!modelConfigId) {
    throw new Error(
      '分析任务缺少 LLM 配置；请重新发起 Standard 或 Deep 分析。',
    );
  }
  const requestConfig = await resolveLLMRequestConfigById(modelConfigId);
  const prompt = [
    '你是严谨的原著 Canon 分析器。只允许根据下面给出的章节正文提取事实，禁止利用外部知识或补写。',
    '必须只返回一个合法 JSON 对象，不要 Markdown，不要解释。schemaVersion 必须为 1。',
    `分析档位：${profile}。请同时填写 worldRules、characters、relationships、plotThreads、experiences、knowledge、states、timelineEvents 八个数组；没有被原文支持的事实才使用空数组。`,
    '每一个数组条目都必须至少有一条 evidence。evidence 必须引用本批章节中连续、逐字一致的原文片段作为 quotePreview（不超过 160 字）。',
    '每章 metadata 给出 bodyStart 和 bodyEnd：charStart/charEnd 是全书 UTF-16 绝对偏移；请使用 quotePreview 在该章正文中定位后填写，不能猜测。',
    '人物的 canonicalName 使用原文最常用姓名；关系要写双方、关系性质和态度；剧情要写已发生事实与当前状态；经历必须归属到人物。',
    'JSON 结构：{"schemaVersion":1,"worldRules":[],"characters":[],"relationships":[],"plotThreads":[],"experiences":[],"knowledge":[],"states":[],"timelineEvents":[]}。数组元素字段必须严格使用对应名称：worldRules(category,title,description,constraintLevel,confidence,evidence)；characters(canonicalName,aliases,description,importance,confidence,evidence)；relationships(sourceName,targetName,relationType,attitude,publicStatus,description,confidence,evidence)；plotThreads(title,description,level,status,characterNames,confidence,evidence)；experiences(characterName,eventType,title,description,importance,confidence,evidence)；knowledge(characterName,factKey,factSummary,knowledgeState,confidence,evidence)；states(characterName,location,physicalState,emotionalState,aliveState,summary,confidence,evidence)；timelineEvents(eventKey,title,summary,eventType,characterNames,importance,confidence,evidence)。',
    'evidence 元素字段：chapterId、chapterPosition、charStart、charEnd、quotePreview。',
    '章节正文：',
    ...chapters.map(
      c =>
        `### ${c.title} (chapterId=${c.id}, position=${c.position}, bodyStart=${
          c.range.start
        }, bodyEnd=${c.range.end})\n${c.content.slice(0, 6000)}`,
    ),
  ].join('\n');
  const text = await callLLM(
    [{ role: 'user', content: prompt }],
    profile === 'deep' ? 8000 : 5000,
    {
      responseFormat: 'json_object',
      queueClass: 'background',
      scenario: 'continuation_canon_analysis',
      requestConfig,
    },
  );
  if (!text?.trim()) {
    throw new Error('LLM 未返回分析结果。');
  }
  return parseExtractionResultJson(text);
}

/**
 * Atomically activate a snapshot as the project's active Canon (Spec §6.1, §4.7).
 */
export async function activateSnapshot(
  projectId: number,
  snapshotId: string,
): Promise<CanonSnapshot> {
  const db = await openDatabase();
  const snap = await getSnapshotById(snapshotId);
  if (!snap || snap.projectId !== projectId) {
    throw new Error('快照不存在');
  }
  if (snap.profile === 'quick') {
    throw new Error('旧版 Quick 离线预览不能激活，请重新发起 LLM 原著分析。');
  }
  if (snap.status !== 'awaiting_review' && snap.status !== 'ready') {
    throw new Error(`快照状态 ${snap.status} 不可激活`);
  }

  // Re-verify Phase 1 source binding.
  const live = await continuationSourceReader.getSnapshot(projectId);
  if (
    live.sourceId !== snap.sourceId ||
    live.sourceVersion !== snap.sourceVersion ||
    live.normalizedSha256 !== snap.sourceSha256 ||
    live.parserVersion !== snap.parserVersion ||
    live.normalizationVersion !== snap.normalizationVersion ||
    live.boundary.chapterId !== snap.boundaryChapterId ||
    live.boundary.charOffsetExclusive !== snap.boundaryCharOffsetExclusive
  ) {
    await updateSnapshotMeta(db, snapshotId, { status: 'outdated' });
    throw new ContinuationSnapshotOutdatedError('源或边界已变化，无法激活。');
  }

  const future = await countFutureEvidence(
    snapshotId,
    snap.boundaryCharOffsetExclusive,
  );
  if (future > 0) {
    throw new Error(`存在 ${future} 条未来证据，禁止激活`);
  }
  const orphans = await countOrphanEvidence(snapshotId);
  if (orphans > 0) {
    throw new Error(`存在 ${orphans} 条孤儿证据，禁止激活`);
  }

  const ts = now();
  await executeTransaction(db, [
    {
      sql: `UPDATE continuation_canon_snapshots
        SET status = 'outdated', updated_at = ?
        WHERE project_id = ? AND status = 'ready' AND id != ?`,
      params: [ts, projectId, snapshotId],
    },
    {
      sql: `UPDATE continuation_canon_snapshots
        SET status = 'ready', activated_at = ?, updated_at = ?
        WHERE id = ?`,
      params: [ts, ts, snapshotId],
    },
    {
      sql: `UPDATE continuation_settings SET
        active_canon_snapshot_id = ?,
        analysis_status = 'ready',
        updated_at = ?
        WHERE project_id = ?`,
      params: [snapshotId, ts, projectId],
    },
    {
      sql: `UPDATE continuation_analysis_runs SET state = 'completed', updated_at = ?
        WHERE canon_snapshot_id = ? AND state = 'awaiting_review'`,
      params: [ts, snapshotId],
    },
    {
      // Any existing generation was compiled against another Canon revision.
      // Stop it at the activation boundary instead of merely rejecting it at
      // final adoption, which can otherwise consume unnecessary model calls.
      sql: `UPDATE continuation_generation_runs
        SET state = 'outdated', error_code = 'outdated',
            error_message = ?, updated_at = ?
        WHERE project_id = ? AND state IN ('queued', 'running', 'awaiting_user', 'interrupted')`,
      params: ['active_canon_changed', ts, projectId],
    },
  ]);

  const activated = await getSnapshotById(snapshotId);
  if (!activated || activated.status !== 'ready') {
    throw new Error('激活失败');
  }
  return activated;
}

export async function pauseAnalysis(runId: string): Promise<void> {
  const db = await openDatabase();
  analysisControllers.get(runId)?.abort();
  await updateRunState(db, runId, { state: 'paused' });
  await execute(
    db,
    `UPDATE continuation_analysis_work_items SET state = 'queued', updated_at = ?
      WHERE run_id = ? AND state IN ('running', 'cancelled')`,
    [now(), runId],
  );
}

export async function cancelAnalysis(runId: string): Promise<void> {
  const db = await openDatabase();
  const run = await getRunById(runId);
  if (!run) return;
  analysisControllers.get(runId)?.abort();
  await updateRunState(db, runId, {
    state: 'cancelled',
    // Cancelled analysis is intentionally resumable. `completed_at` is kept
    // clear so task history and resume UI do not present it as a final result.
    completedAt: null,
  });
  await updateSnapshotMeta(db, run.canonSnapshotId, { status: 'failed' });
  await execute(
    db,
    `UPDATE continuation_analysis_work_items SET state = 'cancelled', updated_at = ?
      WHERE run_id = ? AND state IN ('queued', 'running', 'failed')`,
    [now(), runId],
  );
}

async function resetInterruptedAnalysisWork(
  db: SQLite.SQLiteDatabase,
  runId: string,
): Promise<void> {
  const ts = now();
  // Completed work is immutable and reused. Every other item is safe to run
  // again; this covers an explicit cancel, a paused in-flight request, and a
  // process that was killed before it could write its terminal state.
  await execute(
    db,
    `UPDATE continuation_analysis_work_items
      SET state = 'queued', error_code = NULL, error_message = NULL, updated_at = ?
      WHERE run_id = ? AND state IN ('running', 'failed', 'cancelled')`,
    [ts, runId],
  );
  await execute(
    db,
    `UPDATE continuation_analysis_batches
      SET state = 'queued', error_code = NULL, error_message = NULL, updated_at = ?
      WHERE run_id = ? AND state IN ('running', 'failed', 'cancelled')`,
    [ts, runId],
  );
}

export async function resumeAnalysis(
  runId: string,
  options: ProcessAnalysisOptions = {},
): Promise<AnalysisRun> {
  const db = await openDatabase();
  const run = await getRunById(runId);
  if (!run) throw new Error('分析任务不存在');
  if (run.profile === 'quick') {
    throw new Error('旧版 Quick 离线预览已退役，请重新发起 LLM 原著分析。');
  }
  if (!isResumableAnalysisState(run.state)) {
    throw new Error('仅暂停、失败或已取消的任务可继续');
  }
  await resetInterruptedAnalysisWork(db, runId);
  await updateRunState(db, runId, {
    state: 'queued',
    errorCode: null,
    errorMessage: null,
    completedAt: null,
  });
  return processAnalysisRun(runId, options);
}

/** Cold start: mark leftover running runs as paused (Spec §15). */
export async function pauseInterruptedRuns(
  projectId?: number,
): Promise<number> {
  const db = await openDatabase();
  const ts = now();
  let affected = 0;
  if (projectId != null) {
    const [result] = await db.executeSql(
      `SELECT COUNT(*) AS count FROM continuation_analysis_runs
        WHERE project_id = ? AND state = 'running'`,
      [projectId],
    );
    affected = result.rows.item(0).count as number;
    await execute(
      db,
      `UPDATE continuation_analysis_runs SET state = 'paused', updated_at = ?
        WHERE project_id = ? AND state = 'running'`,
      [ts, projectId],
    );
    await execute(
      db,
      `UPDATE continuation_analysis_work_items SET state = 'queued', updated_at = ?
        WHERE state = 'running' AND run_id IN (
          SELECT id FROM continuation_analysis_runs WHERE project_id = ?
        )`,
      [ts, projectId],
    );
    await execute(
      db,
      `UPDATE continuation_analysis_batches SET state = 'queued', updated_at = ?
        WHERE state = 'running' AND run_id IN (
          SELECT id FROM continuation_analysis_runs WHERE project_id = ?
        )`,
      [ts, projectId],
    );
  } else {
    const [result] = await db.executeSql(
      `SELECT COUNT(*) AS count FROM continuation_analysis_runs WHERE state = 'running'`,
    );
    affected = result.rows.item(0).count as number;
    await execute(
      db,
      `UPDATE continuation_analysis_runs SET state = 'paused', updated_at = ?
        WHERE state = 'running'`,
      [ts],
    );
    await execute(
      db,
      `UPDATE continuation_analysis_work_items SET state = 'queued', updated_at = ?
        WHERE state = 'running'`,
      [ts],
    );
    await execute(
      db,
      `UPDATE continuation_analysis_batches SET state = 'queued', updated_at = ?
        WHERE state = 'running'`,
      [ts],
    );
  }
  return affected;
}

export async function getAnalysisOverview(projectId: number): Promise<{
  activeSnapshot: CanonSnapshot | null;
  latestRun: AnalysisRun | null;
  runs: AnalysisRun[];
}> {
  const activeSnapshot = await getActiveSnapshot(projectId);
  const runs = await listRunsForProject(projectId);
  return {
    activeSnapshot,
    latestRun: runs[0] ?? null,
    runs,
  };
}

export async function getAnalysisWorkItems(runId: string) {
  return listWorkItems(runId);
}

export {
  getActiveSnapshot,
  listRunsForProject,
  getRunById,
  getSnapshotById,
  getDb,
};
