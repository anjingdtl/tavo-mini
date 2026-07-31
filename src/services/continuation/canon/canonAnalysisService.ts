/**
 * Canon analysis pipeline (Spec §8).
 *
 * Creates staging snapshot + run + batches, extracts via LLM, validates
 * evidence, and publishes successful analysis as the active original-work
 * memory by default.
 * Failed/cancelled/outdated runs never become Phase 3 active Canon.
 */
import type SQLite from 'react-native-sqlite-storage';
import { openDatabase } from '../../../data/connection/openDatabase';
import { execute } from '../../../data/connection/execute';
import { executeTransaction } from '../../../services/database/transaction';
import { now } from '../../../data/repositories/shared';
import { v4 } from '../../uuidBridge';
import { sha256Hex } from '../hashUtils';
import { continuationSourceReader } from '../continuationSourceReader';
import {
  buildUniqueCharacterNameIndex,
  normalizeAlias,
} from './canonEntityResolver';
import {
  ContinuationSnapshotOutdatedError,
  type BoundedSourceChapter,
  type ContinuationSourceSnapshot,
} from '../types';
import {
  emptyCapabilities,
  emptyCoverage,
  ANALYSIS_REQUEST_GROUPS,
  EXTRACTION_VERSION,
  type AnalysisWorkItemType,
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
  stripModelJson,
  validateExtractionResultWithStats,
  type ChapterExtractionResult,
  type ExtractionEvidenceCandidate,
  type ExtractionStats,
} from './canonJsonValidators';
import {
  EXTRACTION_FIELD_SPEC,
  EVIDENCE_FIELD_SPEC,
  EXTRACTION_JSON_SKELETON,
  buildExtractionRetryInstruction,
} from './extractionPromptSpec';
import { insertEvidenceAndLink } from './canonEvidenceService';
import type { SqlStatement } from '../../../data/connection/transaction';
import { runStyleAnalysis } from '../styleProfile/styleAnalysisService';
import { activateSnapshotAndStyleProfile } from './activateSnapshotAndStyleProfile';
import {
  callLLM,
  callLLMResult,
  resolveLLMRequestConfig,
  resolveLLMRequestConfigById,
} from '../../llm';
import type { LLMRequestMetrics } from '../../llm/types';
import {
  estimateMessagesTokens,
  estimateTokens,
} from '../../../utils/tokenEstimator';

export const ANALYSIS_MATERIAL_LABELS: Record<AnalysisWorkItemType, string> = {
  world_rules: '世界观',
  characters: '人物画像',
  relationships: '人物关系',
  plot_threads: '主线剧情',
  experiences: '人物经历',
  character_state: '人物与状态',
  world_plot: '世界观与剧情',
  full_extraction: '原著全维度分析',
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

export function isTransientCanonAnalysisError(error: unknown): boolean {
  const candidate = error as {
    code?: unknown;
    status?: unknown;
    cause?: { status?: unknown };
  };
  const status = Number(candidate?.cause?.status ?? candidate?.status ?? 0);
  const code = String(candidate?.code ?? '');
  // total_timeout is intentionally NOT retried: for large-source Canon
  // analysis a timeout usually means the input is too large or the output
  // budget too high, so an identical retry just burns another 180s at 0%.
  return (
    ['idle_timeout', 'network_error'].includes(code) ||
    status === 429 ||
    status >= 500
  );
}

function isRecoverableCanonOutputError(error: unknown): boolean {
  return (error as { name?: unknown })?.name === 'CanonAnalysisOutputError';
}

type ExtractionDiagnosticCategory = {
  received: number;
  accepted: number;
  dropped: number;
  firstDropReason?: string;
  sampleKeySets: string[][];
};

const CANON_AUTO_ADOPT_TABLES = [
  'canon_world_rules',
  'canon_characters',
  'canon_character_aliases',
  'canon_character_state_snapshots',
  'canon_relationships',
  'canon_plot_threads',
  'canon_character_experiences',
  'canon_character_knowledge',
  'canon_timeline_events',
] as const;

/**
 * Canon is useful only when its extracted facts participate in continuation
 * context. Activation therefore adopts every still-pending AI record by
 * default; users can still ignore, revise, lock, or delete individual rows.
 * `user_reviewed_at` intentionally remains untouched: this is a system default,
 * not a claim that the user manually reviewed every record.
 */
export function buildDefaultCanonAdoptionStatements(
  snapshotId: string,
  timestamp: string,
): SqlStatement[] {
  return CANON_AUTO_ADOPT_TABLES.map(table => ({
    sql: `UPDATE ${table}
      SET review_status = 'confirmed', updated_at = ?
      WHERE snapshot_id = ? AND review_status = 'pending'`,
    params: [timestamp, snapshotId],
  }));
}

type CanonExtractionFailureDiagnostic = {
  diagnosticVersion: 1;
  kind: 'canon_extraction_validation_failure';
  attempts: Array<{
    finishReason: string | null;
    responseLength: number;
    categories: Partial<
      Record<keyof ExtractionStats, ExtractionDiagnosticCategory>
    >;
  }>;
};

class CanonAnalysisOutputError extends Error {
  readonly diagnostic?: CanonExtractionFailureDiagnostic;

  constructor(message: string, diagnostic?: CanonExtractionFailureDiagnostic) {
    super(message);
    this.name = 'CanonAnalysisOutputError';
    this.diagnostic = diagnostic;
  }
}

function canonOutputError(message: string): CanonAnalysisOutputError {
  return new CanonAnalysisOutputError(message);
}

function extractionAttemptDiagnostic(
  raw: unknown,
  stats: ExtractionStats | null,
  responseLength: number,
  finishReason: string | null | undefined,
): CanonExtractionFailureDiagnostic['attempts'][number] {
  const categories: CanonExtractionFailureDiagnostic['attempts'][number]['categories'] =
    {};
  const source =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const categoryNames: Array<keyof ExtractionStats> = [
    'worldRules',
    'characters',
    'relationships',
    'plotThreads',
    'experiences',
    'knowledge',
    'states',
    'timelineEvents',
  ];
  for (const category of categoryNames) {
    const sourceItems = Array.isArray(source[category]) ? source[category] : [];
    const categoryStats = stats?.[category];
    if (!categoryStats && sourceItems.length === 0) continue;
    const sampleKeySets = sourceItems
      .filter(
        (item): item is Record<string, unknown> =>
          !!item && typeof item === 'object' && !Array.isArray(item),
      )
      .slice(0, 3)
      .map(item => Object.keys(item).sort().slice(0, 20));
    categories[category] = {
      received: categoryStats?.received ?? sourceItems.length,
      accepted: categoryStats?.accepted ?? 0,
      dropped: categoryStats?.dropped ?? 0,
      ...(categoryStats?.firstDropReason
        ? { firstDropReason: categoryStats.firstDropReason }
        : {}),
      sampleKeySets,
    };
  }
  return {
    finishReason: finishReason ?? null,
    responseLength,
    categories,
  };
}

function failureDiagnosticJson(error: unknown): string | undefined {
  const diagnostic = (error as { diagnostic?: unknown })?.diagnostic;
  if (!diagnostic) return undefined;
  return JSON.stringify(diagnostic);
}

export function waitForCanonRetry(
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
  materialType?: AnalysisWorkItemType;
  batchIndex?: number;
  state?: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  /**
   * Heartbeat / first-token signal: the LLM call for this work item is still
   * in flight. The UI uses this to append a "正在生成…" suffix so the user
   * can tell the app is alive during a long non-streaming request.
   */
  llmActive?: boolean;
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

/**
 * Minimum context window a local model needs to even attempt Canon analysis.
 * Used in error messages so the user understands the floor (Spec §1 / S1).
 * Matches the llama.cpp n_ctx clamp floor; anything smaller cannot reserve the
 * standard output baseline plus any input.
 */
export const CANON_LOCAL_MODEL_MIN_CONTEXT_WINDOW = 4096;

/**
 * Per-batch prompt overhead (instructions, JSON skeleton, field spec) in
 * tokens. Pre-computed once from the shared prompt spec so the budget planner
 * does not have to build a full prompt just to estimate.
 */
const CANON_PROMPT_OVERHEAD_TOKENS = 600;
const CANON_ONLINE_OUTPUT_RESERVE_CAP_TOKENS = 32_768;

/**
 * A context window is a capacity limit, not a desired prompt size. Full-book
 * analysis intentionally revisits the source in many focused passes so each
 * request can extract secondary characters, short-lived relationships and
 * local foreshadowing instead of returning only a coarse book summary.
 */
export const FULL_CANON_QUALITY_CHAPTERS_PER_BATCH = 20;

/**
 * Output baseline per profile. v3.1 reverts to the two-call split
 * (`character_state` 5 categories / `world_plot` 3 categories), so the deep
 * baseline is lowered from 65536 to 32768 — enough for 5 categories per call
 * while halving the single-call generation time and timeout risk for
 * large-source analysis. The planner refuses when the window cannot reserve
 * this much output.
 */
const CANON_OUTPUT_BASELINE_TOKENS: Record<AnalysisProfile, number> = {
  quick: 4096,
  standard: 32768,
  deep: 32768,
};

/**
 * Online models may expose a much larger context than local llama.cpp. Use the
 * configured window to group consecutive chapters aggressively while reserving
 * enough completion space for thinking plus the final JSON. If the provider
 * does not declare a window, retain the conservative legacy three-chapter
 * grouping instead of guessing.
 */
export function resolveContextDrivenChaptersPerBatch(input: {
  providerType?: string | null;
  contextWindow: number | null | undefined;
  maxOutputTokens: number | null | undefined;
  chapterCount: number;
  largestChapterInputTokens: number;
}): number {
  if (
    input.providerType === 'llama_cpp' ||
    !Number.isFinite(input.contextWindow) ||
    (input.contextWindow ?? 0) <= 0
  ) {
    return 3;
  }
  const outputReserve = Math.min(
    Math.max(16_384, input.maxOutputTokens ?? 16_384),
    CANON_ONLINE_OUTPUT_RESERVE_CAP_TOKENS,
  );
  const inputBudget = Math.max(
    1,
    (input.contextWindow as number) -
      outputReserve -
      CANON_PROMPT_OVERHEAD_TOKENS,
  );
  const each = Math.max(1, input.largestChapterInputTokens);
  return Math.max(
    1,
    Math.min(input.chapterCount, Math.floor(inputBudget / each)),
  );
}

export function resolveQualityFirstChaptersPerBatch(input: {
  mode: ContinuationAnalysisMode;
  contextCapacity: number;
}): number {
  if (input.mode !== 'full_canon') return input.contextCapacity;
  return Math.min(input.contextCapacity, FULL_CANON_QUALITY_CHAPTERS_PER_BATCH);
}

/**
 * Per-chapter text budget. Online providers that explicitly declare a context
 * window get a generous 24,000-character cap (≈ 12K tokens) — 4x the local
 * excerpt — so normal-sized chapters pass through untouched while a single
 * pathological 100KB+ chapter can no longer monopolise the prompt and stall
 * generation. Local and unbounded providers retain the conservative 6,000
 * excerpt for predictable memory use.
 */
const CANON_ONLINE_CHAPTER_TEXT_LIMIT = 24_000;

export function resolveCanonChapterTextLimit(input: {
  providerType?: string | null;
  contextWindow?: number | null;
}): number {
  return input.providerType !== 'llama_cpp' &&
    Number.isFinite(input.contextWindow) &&
    (input.contextWindow ?? 0) > 0
    ? CANON_ONLINE_CHAPTER_TEXT_LIMIT
    : 6000;
}

export interface AnalysisTokenBudgetPlan {
  ok: boolean;
  downgraded: boolean;
  perBatch: number;
  /** Max characters of chapter body to include per chapter in a batch. */
  sliceCharBudget: number;
  inputEstimate: number;
  effectiveWindow: number;
  reason?: string;
}

/**
 * Estimate whether a local model's context window can absorb a Canon analysis
 * batch, downgrading chaptersPerBatch and the per-chapter slice before
 * refusing (Spec §1, change 3).
 *
 * Only local (llama_cpp) models are checked — the llama.cpp provider clamps
 * n_ctx to min(4096, context_window), so a Canon batch can silently overflow.
 * Online models skip the check entirely: their windows are effectively
 * unbounded from the client's perspective, and the user-facing context_window
 * field is just an advisory value that must not trigger a refusal.
 */
export function planAnalysisTokenBudget(input: {
  chapters: BoundedSourceChapter[];
  profile: AnalysisProfile;
  perBatch: number;
  providerType?: string | null;
  contextWindow: number | null | undefined;
  contextWindowCeiling?: number;
}): AnalysisTokenBudgetPlan {
  // Online model (or unknown provider): no client-side budget enforcement.
  if (input.providerType !== 'llama_cpp') {
    // deep 档需要约 65536 Token 输出预算；若在线模型未配置 context_window，
    // 运行时可能被 provider 自动 clamp 并触发 finish_reason=length 截断。
    // 此处仅给出诊断提示，不拒绝（在线模型窗口由 provider 兜底）。
    if (input.profile === 'deep' && input.contextWindow == null) {
      console.warn(
        '[canon] deep 档需约 65536 Token 输出预算，当前在线模型未配置 context_window，' +
          '若模型 max_output 不足将在运行时被截断（finish_reason=length）。',
      );
    }
    return {
      ok: true,
      downgraded: false,
      perBatch: Math.max(1, input.perBatch),
      sliceCharBudget: 6000,
      inputEstimate: 0,
      effectiveWindow: 0,
    };
  }
  // Local model without a reported window: treat as the clamp floor.
  if (input.contextWindow == null) {
    return {
      ok: true,
      downgraded: false,
      perBatch: Math.max(1, input.perBatch),
      sliceCharBudget: 6000,
      inputEstimate: 0,
      effectiveWindow: 0,
    };
  }
  const ceiling =
    input.contextWindowCeiling ?? CANON_LOCAL_MODEL_MIN_CONTEXT_WINDOW;
  const effectiveWindow = Math.min(input.contextWindow, ceiling);
  const outputBaseline = CANON_OUTPUT_BASELINE_TOKENS[input.profile] ?? 8192;
  const overhead = CANON_PROMPT_OVERHEAD_TOKENS + 256; // prompt + misc safety

  const fitsWindow = (
    perBatch: number,
    sliceCharBudget: number,
  ): { ok: boolean; inputEstimate: number } => {
    const sampleChapters = input.chapters.slice(0, perBatch);
    const messages = [
      {
        role: 'user' as const,
        content:
          '指令骨架'.repeat(20) +
          sampleChapters
            .map(c => `### ${c.title}\n${c.content.slice(0, sliceCharBudget)}`)
            .join('\n'),
      },
    ];
    const inputEstimate =
      estimateMessagesTokens(messages) - estimateTokens('指令骨架'.repeat(20));
    const total = inputEstimate + outputBaseline + overhead;
    return { ok: total <= effectiveWindow, inputEstimate };
  };

  // Try the requested batch size first.
  let perBatch = Math.max(1, input.perBatch);
  let sliceCharBudget = 6000;
  let probe = fitsWindow(perBatch, sliceCharBudget);

  // Downgrade path 1: shrink chapters per batch to 1.
  if (!probe.ok && perBatch > 1) {
    perBatch = 1;
    probe = fitsWindow(perBatch, sliceCharBudget);
  }

  // Downgrade path 2: shrink the per-chapter slice until it fits (or hits a floor).
  if (!probe.ok) {
    // Binary-shrink the slice char budget. Floor at 512 chars — anything smaller
    // is not worth analysing and the run should refuse instead.
    let lo = 512;
    let hi = sliceCharBudget;
    let bestFit: { ok: boolean; inputEstimate: number; budget: number } | null =
      null;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const trial = fitsWindow(perBatch, mid);
      if (trial.ok) {
        bestFit = { ...trial, budget: mid };
        lo = mid + 1; // try to keep as much text as possible
      } else {
        hi = mid - 1;
      }
    }
    if (bestFit) {
      sliceCharBudget = bestFit.budget;
      probe = { ok: true, inputEstimate: bestFit.inputEstimate };
    }
  }

  if (probe.ok) {
    return {
      ok: true,
      downgraded: perBatch < input.perBatch || sliceCharBudget < 6000,
      perBatch,
      sliceCharBudget,
      inputEstimate: probe.inputEstimate,
      effectiveWindow,
    };
  }

  return {
    ok: false,
    downgraded: true,
    perBatch,
    sliceCharBudget,
    inputEstimate: probe.inputEstimate,
    effectiveWindow,
    reason: `本地模型上下文不足以执行 Canon 分析（估算输入 ${probe.inputEstimate} tokens / 有效窗口 ${effectiveWindow}，需预留输出 ${outputBaseline} tokens），请改用在线模型或扩大本地模型上下文窗口。`,
  };
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
  return normalizeAlias(name);
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

  // 清理该 batch 的旧 canon 数据，防止 resume 重跑时重复 INSERT。
  // characters 跨 batch 共享（ensureCharacter 通过 nameToId 去重），不删；
  // evidence CASCADE 删 links；其余子表按 valid_from_position = fromPos 清理。
  // 原逻辑无此清理，中途失败后 resume 重跑会重复插入 alias/evidence/
  // relationship/plot_thread/experience/knowledge/state/timeline，导致孤儿
  // 证据，countOrphanEvidence > 0，activateSnapshotAndStyleProfile 永久拒绝激活。
  await executeTransaction(db, [
    { sql: 'DELETE FROM canon_evidence WHERE snapshot_id = ? AND analysis_run_id = ? AND valid_from_position = ?', params: [ctx.snapshotId, ctx.runId, fromPos] },
    { sql: 'DELETE FROM canon_timeline_events WHERE snapshot_id = ? AND analysis_run_id = ? AND valid_from_position = ?', params: [ctx.snapshotId, ctx.runId, fromPos] },
    { sql: 'DELETE FROM canon_plot_threads WHERE snapshot_id = ? AND analysis_run_id = ? AND valid_from_position = ?', params: [ctx.snapshotId, ctx.runId, fromPos] },
    { sql: 'DELETE FROM canon_relationships WHERE snapshot_id = ? AND analysis_run_id = ? AND valid_from_position = ?', params: [ctx.snapshotId, ctx.runId, fromPos] },
    { sql: 'DELETE FROM canon_character_state_snapshots WHERE snapshot_id = ? AND analysis_run_id = ? AND valid_from_position = ?', params: [ctx.snapshotId, ctx.runId, fromPos] },
    { sql: 'DELETE FROM canon_character_experiences WHERE snapshot_id = ? AND analysis_run_id = ? AND valid_from_position = ?', params: [ctx.snapshotId, ctx.runId, fromPos] },
    { sql: 'DELETE FROM canon_character_knowledge WHERE snapshot_id = ? AND analysis_run_id = ? AND valid_from_position = ?', params: [ctx.snapshotId, ctx.runId, fromPos] },
    { sql: 'DELETE FROM canon_character_aliases WHERE snapshot_id = ? AND analysis_run_id = ? AND valid_from_position = ?', params: [ctx.snapshotId, ctx.runId, fromPos] },
  ]);

  // Load existing characters for this snapshot.
  const [charRows] = await db.executeSql(
    `SELECT id, canonical_name FROM canon_characters
      WHERE snapshot_id = ? AND review_status != 'superseded'`,
    [ctx.snapshotId],
  );
  const characterNameEntries: Array<{ characterId: number; name: string }> = [];
  for (let i = 0; i < charRows.rows.length; i++) {
    const row = charRows.rows.item(i);
    characterNameEntries.push({
      characterId: row.id,
      name: row.canonical_name,
    });
  }
  const [aliasRows] = await db.executeSql(
    `SELECT character_id, alias FROM canon_character_aliases
      WHERE snapshot_id = ? AND review_status != 'superseded' AND is_ambiguous = 0`,
    [ctx.snapshotId],
  );
  for (let i = 0; i < aliasRows.rows.length; i++) {
    const row = aliasRows.rows.item(i);
    characterNameEntries.push({
      characterId: row.character_id,
      name: row.alias,
    });
  }
  let nameToId = buildUniqueCharacterNameIndex(characterNameEntries);
  const registerCharacterName = (characterId: number, name: string) => {
    characterNameEntries.push({ characterId, name });
    nameToId = buildUniqueCharacterNameIndex(characterNameEntries);
  };

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
    registerCharacterName(id, name);
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
      registerCharacterName(id, alias);
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
    // 串行 ensureCharacter 避免 Promise.all 并行竞态（同姓名并发 INSERT
    // 创建重复角色行，角色库越跑越脏）。
    const participantIds: number[] = [];
    for (const name of plot.characterNames) {
      participantIds.push(
        await ensureCharacter(name, 'supporting', '', plot.confidence),
      );
    }
    const establishedFacts = JSON.stringify([
      {
        time: plot.timeDescription,
        location: plot.location,
        participantCharacterIds: [...new Set(participantIds)],
        event: plot.description || plot.title,
      },
    ]);
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
        ?, ?, ?, ?, 0, ?, ?, NULL, ?, '[]', '[]')`,
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
        establishedFacts,
      ],
    );
    const plotId = await lastInsertId(db);
    for (const cid of [...new Set(participantIds)]) {
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
      const knowledgeId = await lastInsertId(db);
      for (const evidence of k.evidence) {
        await insertEvidenceAndLink(
          db,
          {
            projectId: ctx.projectId,
            sourceId: ctx.sourceId,
            snapshotId: ctx.snapshotId,
            analysisRunId: ctx.runId,
            boundaryExclusive: ctx.boundaryExclusive,
            candidate: evidence,
          },
          'knowledge',
          knowledgeId,
        );
      }
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
      const stateId = await lastInsertId(db);
      for (const evidence of st.evidence) {
        await insertEvidenceAndLink(
          db,
          {
            projectId: ctx.projectId,
            sourceId: ctx.sourceId,
            snapshotId: ctx.snapshotId,
            analysisRunId: ctx.runId,
            boundaryExclusive: ctx.boundaryExclusive,
            candidate: evidence,
          },
          'character_state',
          stateId,
        );
      }
    }

    for (const ev of result.timelineEvents) {
      // 串行 ensureCharacter 避免 Promise.all 并行竞态。
      const participantIds: number[] = [];
      for (const name of ev.characterNames) {
        participantIds.push(
          await ensureCharacter(name, 'supporting', '', ev.confidence),
        );
      }
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
          ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?, '[]', '[]', ?)`,
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
          JSON.stringify([...new Set(participantIds)]),
          ev.location || null,
          ev.timeDescription
            ? JSON.stringify({ description: ev.timeDescription })
            : '{}',
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
  const chapterTextLimit = resolveCanonChapterTextLimit({
    providerType: requestConfig.provider_type,
    contextWindow: requestConfig.context_window,
  });
  // H4 修复：原 Math.max(...spread) 在 2000+ 章长篇网文上有爆栈风险
  //（参数上限 + 栈深度），且对每章做 24000 字 token 估算会同步处理
  // 4800 万字符。改 for 循环累加，栈深度 O(1)。
  let largestChapterInputTokens = 0;
  for (const chapter of plan.nearChapters) {
    const tokens =
      estimateTokens(chapter.title) +
      estimateTokens(chapter.content.slice(0, chapterTextLimit)) +
      64;
    if (tokens > largestChapterInputTokens) largestChapterInputTokens = tokens;
  }
  const contextDrivenPerBatch = resolveContextDrivenChaptersPerBatch({
    providerType: requestConfig.provider_type,
    contextWindow: requestConfig.context_window,
    maxOutputTokens: requestConfig.max_output_tokens,
    chapterCount: plan.nearChapters.length,
    largestChapterInputTokens,
  });
  const requestedPerBatch = Math.max(
    1,
    resolveQualityFirstChaptersPerBatch({
      mode: input.mode,
      contextCapacity: input.chaptersPerBatch ?? contextDrivenPerBatch,
    }),
  );
  // S1 preflight: estimate whether the local model's context window can absorb
  // a Canon batch. Online models skip the check; local models that cannot
  // reserve the output baseline are refused up front instead of burning three
  // identical retries. When the input is the bottleneck we downgrade
  // chaptersPerBatch (and remember the slice budget for extraction).
  const tokenBudget = planAnalysisTokenBudget({
    chapters: plan.nearChapters,
    profile,
    perBatch: requestedPerBatch,
    providerType: requestConfig.provider_type,
    contextWindow: requestConfig.context_window,
  });
  if (!tokenBudget.ok) {
    throw new Error(
      tokenBudget.reason ?? '本地模型上下文不足以执行 Canon 分析',
    );
  }
  const perBatch = tokenBudget.perBatch;
  const sliceCharBudget = tokenBudget.sliceCharBudget;
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
    progressTotal: batches.length * ANALYSIS_REQUEST_GROUPS.length,
    extractionVersion: EXTRACTION_VERSION,
  });
  await insertBatches(db, batches);
  await insertWorkItems(
    db,
    batches.flatMap(batch =>
      ANALYSIS_REQUEST_GROUPS.map(materialType => ({
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
      schemaVersion: 3,
      mode: input.mode,
      extractorMode: 'llm',
      workItemProtocol: 'request_groups_v3_1_split',
      scope: plan.effectiveScope,
      plannedChapterIds: plan.nearChapters.map(chapter => chapter.id),
      plannedRanges: plan.analyzedRanges,
      // S1: remember the budget planner's verdict so extraction/resume reuse
      // the same downgraded chaptersPerBatch and slice budget instead of
      // recomputing (and possibly widening) on resume.
      tokenBudget: {
        perBatch,
        sliceCharBudget,
        downgraded: tokenBudget.downgraded,
        effectiveWindow: tokenBudget.effectiveWindow,
      },
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
    workItemProtocol?: string;
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
    materialType: AnalysisWorkItemType,
    batchIndex: number,
    state: AnalysisProgressUpdate['state'],
  ): Promise<{ current: number; total: number }> => {
    const items = await listWorkItems(runId);
    const completed = items.filter(item => item.state === 'completed').length;
    await updateRunState(db, runId, {
      stage: 'chapter_extraction',
      progressCurrent: completed,
      progressTotal: items.length,
    });
    options.onProgress?.({
      runId,
      stage: 'chapter_extraction',
      progressCurrent: completed,
      progressTotal: items.length,
      materialType,
      batchIndex,
      state,
    });
    return { current: completed, total: items.length };
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
      const runMaterial = async (materialType: AnalysisWorkItemType) => {
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
        let lastProgress = await reportWorkItem(
          materialType,
          batch.batchIndex,
          'running',
        );
        // Heartbeat: non-streaming Canon requests can pend for minutes with no
        // signal. A 5s interval proves the JS thread is alive and lets the UI
        // show "正在生成…" instead of a frozen 0%.
        let firstTokenReported = false;
        const heartbeat = setInterval(() => {
          if (signal.aborted) return;
          options.onProgress?.({
            runId,
            stage: 'chapter_extraction',
            progressCurrent: lastProgress.current,
            progressTotal: lastProgress.total,
            materialType,
            batchIndex: batch.batchIndex,
            state: 'running',
            llmActive: true,
          });
        }, 5_000);
        try {
          const outcome = await extractMaterialWithLlm(
            slice,
            run.profile,
            run.modelConfigId,
            materialType,
            runId,
            signal,
            metrics => {
              // For providers that report first-token/progress (e.g. future
              // streaming), surface it once so the UI can switch from
              // "queued" to "generating" immediately.
              if (!firstTokenReported && metrics.firstTokenAt !== undefined) {
                firstTokenReported = true;
                options.onProgress?.({
                  runId,
                  stage: 'chapter_extraction',
                  progressCurrent: lastProgress.current,
                  progressTotal: lastProgress.total,
                  materialType,
                  batchIndex: batch.batchIndex,
                  state: 'running',
                  llmActive: true,
                });
              }
            },
          );
          if (signal.aborted) throw new Error('分析已暂停或取消');
          // Warnings (partial drops) are surfaced via the error_message column
          // while the work item itself stays completed — the run can still
          // proceed, but the user/operator sees what the model got wrong.
          if (outcome.warning) {
            // eslint-disable-next-line no-console
            console.warn(
              `[canon] ${materialType} batch ${batch.batchIndex} warning: ${outcome.warning}`,
            );
          }
          await updateWorkItem(db, {
            runId,
            batchIndex: batch.batchIndex,
            materialType,
            state: 'completed',
            resultJson: JSON.stringify(outcome.result),
            errorCode: outcome.warning ? 'partial_drop' : null,
            errorMessage: outcome.warning,
            completedAt: now(),
          });
          await reportWorkItem(materialType, batch.batchIndex, 'completed');
          return outcome.result;
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
            ...(signal.aborted
              ? {}
              : { resultJson: failureDiagnosticJson(error) }),
          });
          await reportWorkItem(
            materialType,
            batch.batchIndex,
            signal.aborted ? 'cancelled' : 'failed',
          );
          throw error;
        } finally {
          clearInterval(heartbeat);
        }
      };
      const settled = await Promise.allSettled(
        batchItems.map(item => item.materialType).map(runMaterial),
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

  // Keep the Canon snapshot available as a reviewable candidate while the
  // required style analysis is still in flight. The analysis run itself must
  // remain running until atomic Canon + style activation completes; marking it
  // awaiting_review here would stop polling and make an interrupted run
  // impossible to resume before style analysis.
  await updateSnapshotMeta(db, run.canonSnapshotId, {
    status: 'awaiting_review',
    capabilities,
    coverage,
  });
  const finalWorkItems = await listWorkItems(runId);
  await updateRunState(db, runId, {
    state: 'running',
    stage: 'finalizing',
    progressCurrent: finalWorkItems.filter(item => item.state === 'completed')
      .length,
    progressTotal: finalWorkItems.length,
    // Only activateSnapshotAndStyleProfile may mark the run completed.
    completedAt: null,
  });
  await execute(
    db,
    `UPDATE continuation_settings SET analysis_status = 'running', updated_at = ?
      WHERE project_id = ?`,
    [now(), run.projectId],
  );

  // ---- style_analysis stage (Spec §5.1) ----
  // Must run BEFORE the Canon snapshot is activated: otherwise the first
  // continuation could see a ready Canon but no style profile. On failure the
  // snapshot stays awaiting_review (NOT activated) and the run becomes failed;
  // the user can retry style analysis alone.
  await updateRunState(db, runId, {
    state: 'running',
    stage: 'style_analysis',
  });
  const styleOutcome = await runStyleAnalysis({
    projectId: run.projectId,
    runId,
    canonSnapshotId: run.canonSnapshotId,
    sourceSnapshot,
    modelConfigId: run.modelConfigId,
    signal,
  });

  if (!styleOutcome.success) {
    // Canon remains awaiting_review; do NOT activate. Surface a retryable
    // failure so the user can retry style analysis.
    await updateRunState(db, runId, {
      state: 'failed',
      stage: 'style_analysis',
      errorCode: 'style_analysis_failed',
      errorMessage: '原著风格分析失败，可单独重试',
      completedAt: now(),
    });
    await execute(
      db,
      `UPDATE continuation_settings SET analysis_status = 'failed', updated_at = ?
        WHERE project_id = ?`,
      [now(), run.projectId],
    );
    return (await getRunById(runId))!;
  }

  // ---- style_validation + atomic activation (Spec §5.1, §6.3) ----
  await updateRunState(db, runId, {
    state: 'running',
    stage: 'style_validation',
  });
  await activateSnapshotAndStyleProfile({
    projectId: run.projectId,
    analysisRunId: runId,
    canonSnapshotId: run.canonSnapshotId,
    styleProfileId: styleOutcome.profileId,
    allowStyleSkip: false,
  });

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
  materialType: AnalysisWorkItemType,
): ChapterExtractionResult {
  return {
    schemaVersion: 1,
    ...pickMaterialFields(result, materialType),
  };
}

export interface ExtractionEvidenceResolutionStats {
  received: number;
  resolved: number;
  rejected: number;
}

function normalizedEvidenceText(value: string): string {
  return value.replace(/[\s\p{P}\p{S}_]+/gu, '');
}

function lcsLength(left: string, right: string): number {
  let previous = new Array<number>(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i += 1) {
    const current = new Array<number>(right.length + 1).fill(0);
    for (let j = 1; j <= right.length; j += 1) {
      current[j] =
        left[i - 1] === right[j - 1]
          ? previous[j - 1] + 1
          : Math.max(previous[j], current[j - 1]);
    }
    previous = current;
  }
  return previous[right.length];
}

function sourceSentenceExcerpt(
  content: string,
  anchor: number,
): {
  start: number;
  preview: string;
} {
  const boundaries = /[。！？!?\n]/g;
  let start = 0;
  let end = content.length;
  for (const match of content.matchAll(boundaries)) {
    const index = match.index ?? 0;
    if (index < anchor) start = index + match[0].length;
    else {
      end = index + match[0].length;
      break;
    }
  }
  if (end - start > 160) {
    start = Math.max(0, anchor - 64);
    end = Math.min(content.length, start + 160);
  }
  return { start, preview: content.slice(start, end) };
}

function findCloseParaphraseMatch(
  chapter: BoundedSourceChapter,
  quote: string,
): { start: number; preview: string } | null {
  const normalizedQuote = normalizedEvidenceText(quote);
  // Short fragments such as a name or "说道" are too ambiguous for a
  // semantic fallback; exact matching still handles them above.
  if (normalizedQuote.length < 6) return null;
  const anchors = new Set<string>();
  for (let size = Math.min(6, normalizedQuote.length); size >= 3; size -= 1) {
    for (let index = 0; index <= normalizedQuote.length - size; index += 1) {
      anchors.add(normalizedQuote.slice(index, index + size));
    }
  }
  let best: { start: number; preview: string; score: number } | null = null;
  for (const anchor of anchors) {
    let index = chapter.content.indexOf(anchor);
    while (index >= 0) {
      const excerpt = sourceSentenceExcerpt(chapter.content, index);
      const score =
        lcsLength(normalizedQuote, normalizedEvidenceText(excerpt.preview)) /
        normalizedQuote.length;
      if (!best || score > best.score) {
        best = { ...excerpt, score };
      }
      index = chapter.content.indexOf(
        anchor,
        index + Math.max(1, anchor.length),
      );
    }
  }
  // The model's paraphrase must retain most of its meaningful characters;
  // otherwise a shared name/location alone could fabricate a connection.
  return best && best.score >= 0.75 ? best : null;
}

/**
 * A model may understand an event but still estimate the UTF-16 offsets
 * imprecisely. Locate every quoted excerpt in the actual batch source before
 * anything is persisted, and discard a fact when none of its evidence quotes
 * is a verbatim source match. This deliberately sits after the public JSON
 * validator: JSON shape remains permissive while evidence truth is enforced
 * against the user's original text.
 */
export function resolveExtractionEvidenceAgainstChapters(
  result: ChapterExtractionResult,
  chapters: BoundedSourceChapter[],
): {
  result: ChapterExtractionResult;
  stats: ExtractionEvidenceResolutionStats;
} {
  const stats: ExtractionEvidenceResolutionStats = {
    received: 0,
    resolved: 0,
    rejected: 0,
  };
  const resolveEvidence = (
    evidence: ExtractionEvidenceCandidate,
  ): ExtractionEvidenceCandidate | null => {
    stats.received += 1;
    const quote = evidence.quotePreview;
    if (!quote) {
      stats.rejected += 1;
      return null;
    }
    const matches: Array<{ chapter: BoundedSourceChapter; index: number }> = [];
    for (const chapter of chapters) {
      let index = chapter.content.indexOf(quote);
      while (index >= 0) {
        matches.push({ chapter, index });
        index = chapter.content.indexOf(
          quote,
          index + Math.max(1, quote.length),
        );
      }
    }
    if (!matches.length) {
      const statedChapters = chapters.filter(
        chapter =>
          chapter.id === evidence.chapterId ||
          chapter.position === evidence.chapterPosition,
      );
      const paraphrase = statedChapters
        .map(chapter => ({
          chapter,
          match: findCloseParaphraseMatch(chapter, quote),
        }))
        .find(
          (
            value,
          ): value is {
            chapter: BoundedSourceChapter;
            match: { start: number; preview: string };
          } => value.match !== null,
        );
      if (paraphrase) {
        const charStart =
          Number(paraphrase.chapter.range.start) + paraphrase.match.start;
        stats.resolved += 1;
        return {
          chapterId: paraphrase.chapter.id,
          chapterPosition: Number(paraphrase.chapter.position),
          charStart,
          charEnd: charStart + paraphrase.match.preview.length,
          quotePreview: paraphrase.match.preview,
        };
      }
      stats.rejected += 1;
      return null;
    }
    const sameChapter = matches.filter(
      match =>
        match.chapter.id === evidence.chapterId ||
        match.chapter.position === evidence.chapterPosition,
    );
    const candidates = sameChapter.length ? sameChapter : matches;
    candidates.sort(
      (a, b) =>
        Math.abs(Number(a.chapter.range.start) + a.index - evidence.charStart) -
        Math.abs(Number(b.chapter.range.start) + b.index - evidence.charStart),
    );
    const selected = candidates[0];
    const charStart = Number(selected.chapter.range.start) + selected.index;
    stats.resolved += 1;
    return {
      chapterId: selected.chapter.id,
      chapterPosition: Number(selected.chapter.position),
      charStart,
      charEnd: charStart + quote.length,
      quotePreview: quote,
    };
  };

  const resolveEntries = <
    T extends { evidence: ExtractionEvidenceCandidate[] },
  >(
    entries: T[],
  ): T[] =>
    entries
      .map(entry => ({
        ...entry,
        evidence: entry.evidence
          .map(resolveEvidence)
          .filter(
            (evidence): evidence is ExtractionEvidenceCandidate =>
              evidence !== null,
          ),
      }))
      .filter(entry => entry.evidence.length > 0) as T[];

  return {
    result: {
      schemaVersion: result.schemaVersion,
      worldRules: resolveEntries(result.worldRules),
      characters: resolveEntries(result.characters),
      relationships: resolveEntries(result.relationships),
      plotThreads: resolveEntries(result.plotThreads),
      experiences: resolveEntries(result.experiences),
      knowledge: resolveEntries(result.knowledge),
      states: resolveEntries(result.states),
      timelineEvents: resolveEntries(result.timelineEvents),
    },
    stats,
  };
}

/**
 * The canonical categories each work item type is responsible for producing.
 * Used both to filter the merged result and to decide which categories must be
 * non-empty (S3: `received>0 && accepted===0` triggers a stats-aware retry).
 */
const MATERIAL_CATEGORY_OWNERSHIP: Record<
  AnalysisWorkItemType,
  Array<keyof ExtractionStats>
> = {
  world_rules: ['worldRules'],
  characters: ['characters', 'knowledge', 'states'],
  relationships: ['relationships'],
  plot_threads: ['plotThreads', 'timelineEvents'],
  experiences: ['experiences'],
  character_state: [
    'characters',
    'relationships',
    'experiences',
    'knowledge',
    'states',
  ],
  world_plot: ['worldRules', 'plotThreads', 'timelineEvents'],
  full_extraction: [
    'worldRules',
    'characters',
    'relationships',
    'plotThreads',
    'experiences',
    'knowledge',
    'states',
    'timelineEvents',
  ],
};

function pickMaterialFields(
  result: ChapterExtractionResult,
  materialType: AnalysisWorkItemType,
): Omit<ChapterExtractionResult, 'schemaVersion'> {
  const filtered = emptyExtractionResult();
  const owned = new Set(MATERIAL_CATEGORY_OWNERSHIP[materialType]);
  if (owned.has('worldRules')) filtered.worldRules = result.worldRules;
  if (owned.has('characters')) filtered.characters = result.characters;
  if (owned.has('relationships')) filtered.relationships = result.relationships;
  if (owned.has('plotThreads')) filtered.plotThreads = result.plotThreads;
  if (owned.has('experiences')) filtered.experiences = result.experiences;
  if (owned.has('knowledge')) filtered.knowledge = result.knowledge;
  if (owned.has('states')) filtered.states = result.states;
  if (owned.has('timelineEvents'))
    filtered.timelineEvents = result.timelineEvents;
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

const MATERIAL_PROMPTS: Record<AnalysisWorkItemType, string> = {
  world_rules: '只填写 worldRules；其他数组必须为空。',
  characters: '只填写 characters、knowledge、states；其他数组必须为空。',
  relationships: '只填写 relationships；其他数组必须为空。',
  plot_threads: '只填写 plotThreads、timelineEvents；其他数组必须为空。',
  experiences: '只填写 experiences；其他数组必须为空。',
  character_state:
    '只填写 characters、relationships、experiences、knowledge、states；其他数组必须为空。人物之间的关系、当前状态和知识边界不得省略。',
  world_plot:
    '只填写 worldRules、plotThreads、timelineEvents；其他数组必须为空。剧情必须区分已发生事实、当前状态与未收束线索。',
  full_extraction:
    '填写所有八个数组。characters、relationships、experiences、knowledge、states 记录人物维度的全部事实；worldRules、plotThreads、timelineEvents 记录世界观与剧情维度的全部事实。',
};

export interface ExtractMaterialOutcome {
  result: ChapterExtractionResult;
  /**
   * Non-fatal dropped-item summary written to the work item as a warning
   * (state stays `completed`). `null` when nothing was dropped.
   */
  warning: string | null;
}

export async function extractMaterialWithLlm(
  chapters: BoundedSourceChapter[],
  profile: AnalysisProfile,
  modelConfigId: number | null,
  materialType: AnalysisWorkItemType,
  runId: string,
  signal: AbortSignal,
  onProgress?: (metrics: LLMRequestMetrics) => void,
): Promise<ExtractMaterialOutcome> {
  if (!modelConfigId) {
    throw new Error(
      '分析任务缺少 LLM 配置；请重新发起 Standard 或 Deep 分析。',
    );
  }
  const requestConfig = await resolveLLMRequestConfigById(modelConfigId);
  const chapterTextLimit = resolveCanonChapterTextLimit({
    providerType: requestConfig.provider_type,
    contextWindow: requestConfig.context_window,
  });
  const prompt = [
    '你是严谨的原著 Canon 分析器。只允许根据下面给出的章节正文提取事实，禁止利用外部知识或补写。',
    '必须只返回一个完整、可 JSON.parse 的 JSON 对象，不要 Markdown、思考过程、解释或任何前后缀。schemaVersion 必须为 1，八个数组字段都必须出现，不能返回 null 或空白。',
    `分析档位：${profile}。${MATERIAL_PROMPTS[materialType]}`,
    '每一个数组条目都必须至少有一条 evidence。evidence 必须引用本批章节中连续、逐字一致的原文片段作为 quotePreview（不超过 160 字）。',
    '每章 metadata 给出 bodyStart 和 bodyEnd：charStart/charEnd 是全书 UTF-16 绝对偏移；请使用 quotePreview 在该章正文中定位后填写，不能猜测。',
    EXTRACTION_FIELD_SPEC,
    EVIDENCE_FIELD_SPEC,
    EXTRACTION_JSON_SKELETON,
    '章节正文：',
    ...chapters.map(
      c =>
        `### ${c.title} (chapterId=${c.id}, position=${c.position}, bodyStart=${
          c.range.start
        }, bodyEnd=${c.range.end})\n${c.content.slice(0, chapterTextLimit)}`,
    ),
  ].join('\n');
  // Preserve thinking for models that support it, but reserve a meaningful
  // completion budget for both reasoning and the final eight-array JSON.
  const profileBaseline =
    CANON_OUTPUT_BASELINE_TOKENS[profile] ??
    CANON_OUTPUT_BASELINE_TOKENS.standard;
  const configuredOutputTokens =
    requestConfig.max_output_tokens ?? profileBaseline;
  const baselineMaxTokens = Math.min(
    Math.max(profileBaseline, configuredOutputTokens),
    CANON_ONLINE_OUTPUT_RESERVE_CAP_TOKENS,
  );
  let currentMaxTokens = baselineMaxTokens;
  const maxTokenCeiling = Math.max(
    baselineMaxTokens,
    Math.min(Math.max(configuredOutputTokens, baselineMaxTokens * 4), 131_072),
  );
  let lastOutputError: Error | null = null;
  let lastDroppedStats: ExtractionStats | null = null;
  const attemptDiagnostics: CanonExtractionFailureDiagnostic['attempts'] = [];
  let lastDiagnostic: { finishReason?: string | null } | null = null;
  for (
    let attempt = 1;
    attempt <= CANON_ANALYSIS_RETRY_POLICY.maxAttempts;
    attempt += 1
  ) {
    try {
      const retryInstruction =
        attempt > 1
          ? buildExtractionRetryInstruction(lastDroppedStats ?? undefined)
          : '';
      const response = await callLLMResult(
        [{ role: 'user', content: `${prompt}${retryInstruction}` }],
        currentMaxTokens,
        {
          responseFormat: 'json_object',
          temperature: 0.1,
          queueClass: 'canon_analysis',
          queuePriority: 'background',
          scenario: 'continuation_canon_analysis',
          taskId: runId,
          requestConfig,
          onProgress,
        },
        signal,
      );
      if (!response?.text?.trim()) {
        // S1: classify the empty response so the retry / error path can act on
        // the real cause instead of a generic "no output".
        const emptyReason = (response as { emptyReason?: string })?.emptyReason;
        const finishReason = (response as { finishReason?: string | null })
          ?.finishReason;
        lastDiagnostic = {
          finishReason: finishReason ?? null,
        };
        // Adaptive retry: when the budget was the bottleneck (length or
        // reasoning_only), doubling max_tokens is a genuinely different
        // request and may succeed where an identical retry cannot.
        if (emptyReason === 'length' || emptyReason === 'reasoning_only') {
          currentMaxTokens = Math.min(currentMaxTokens * 2, maxTokenCeiling);
        }
        throw canonOutputError(emptyResponseMessage(emptyReason));
      }
      let parsed: ChapterExtractionResult;
      let stats: ExtractionStats;
      let rawExtraction: unknown;
      try {
        rawExtraction = parseRecoveredExtractionObject(response.text);
        ({ result: parsed, stats } = validateExtractionResultWithStats(
          // Recover the JSON object from prose/fences but DO NOT pre-validate:
          // validateExtractionResultWithStats must see the raw shape so the
          // received/accepted/dropped counts reflect the model's actual output.
          rawExtraction,
        ));
      } catch (error) {
        attemptDiagnostics.push(
          extractionAttemptDiagnostic(
            rawExtraction,
            null,
            response.text.length,
            (response as { finishReason?: string | null })?.finishReason,
          ),
        );
        lastDiagnostic = {
          finishReason: (response as { finishReason?: string | null })
            ?.finishReason,
        };
        throw canonOutputError(
          error instanceof Error ? error.message : '提取结果不是合法 JSON',
        );
      }
      const evidenceResolution = resolveExtractionEvidenceAgainstChapters(
        parsed,
        chapters,
      );
      parsed = evidenceResolution.result;
      const filtered = onlyMaterial(parsed, materialType);
      // S3: if a category this work item owns had input but every entry was
      // dropped, the model produced a structurally unusable payload for that
      // category. Surface it as a recoverable output error so the loop retries
      // with the dropped statistics attached.
      const ownedCategories = MATERIAL_CATEGORY_OWNERSHIP[materialType];
      const wiped = ownedCategories.filter(
        cat =>
          stats[cat].received > 0 &&
          (stats[cat].accepted === 0 || parsed[cat].length === 0),
      );
      if (wiped.length > 0) {
        lastDroppedStats = stats;
        attemptDiagnostics.push(
          extractionAttemptDiagnostic(
            rawExtraction,
            stats,
            response.text.length,
            (response as { finishReason?: string | null })?.finishReason,
          ),
        );
        throw canonOutputError(
          `本组负责的分类全部被丢弃：${wiped
            .map(cat => `${cat}(received=${stats[cat].received})`)
            .join('、')}`,
        );
      }
      const validatorWarning = buildDropWarning(
        materialType,
        stats,
        ownedCategories,
      );
      const evidenceWarning = evidenceResolution.stats.rejected
        ? `${ANALYSIS_MATERIAL_LABELS[materialType]} 有 ${evidenceResolution.stats.rejected} 条无法在原文逐字定位的引用，相关资料未采纳`
        : null;
      const warning =
        [validatorWarning, evidenceWarning]
          .filter((value): value is string => !!value)
          .join('；') || null;
      return { result: filtered, warning };
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
    throw new CanonAnalysisOutputError(
      buildFinalFailureMessage(
        ANALYSIS_MATERIAL_LABELS[materialType],
        CANON_ANALYSIS_RETRY_POLICY.maxAttempts,
        lastOutputError,
        lastDiagnostic,
        baselineMaxTokens,
        currentMaxTokens,
      ),
      attemptDiagnostics.length
        ? {
            diagnosticVersion: 1,
            kind: 'canon_extraction_validation_failure',
            attempts: attemptDiagnostics,
          }
        : undefined,
    );
  }
  throw new Error('LLM 未返回分析结果。');
}

/**
 * Map an empty-response classification onto a specific, actionable Chinese
 * message (Spec §1 / S1). `no_choices` is normally already raised as a real
 * provider error by `openAICompatibleProvider`; we keep a defensive branch
 * here for providers that return a 200 with empty choices and no error body.
 */
function emptyResponseMessage(emptyReason?: string): string {
  switch (emptyReason) {
    case 'length':
      return '模型输出被 max_tokens 截断（finish_reason=length），未产生完整正文';
    case 'reasoning_only':
      return '推理模型的 reasoning 占满输出预算，未产生正文';
    case 'content_filter':
      return '模型输出被内容过滤拦截';
    case 'no_choices':
      return '网关返回了空响应（无 choices），请检查模型服务状态';
    default:
      return 'LLM 返回了空响应';
  }
}

/**
 * Build the final failure message with non-sensitive diagnostics (Spec §1).
 * Provider reasoning can echo the request, so neither it nor response fragments
 * may be shown to the user or persisted in an error. The finish reason and the
 * doubled-budget trail remain sufficient to identify a budget problem.
 */
function buildFinalFailureMessage(
  label: string,
  maxAttempts: number,
  lastError: Error,
  diagnostic: { finishReason?: string | null } | null,
  baselineMaxTokens: number,
  finalMaxTokens: number,
): string {
  const head = `${label}的模型输出连续 ${maxAttempts} 次无效：${lastError.message}`;
  const footerParts: string[] = [];
  if (diagnostic?.finishReason) {
    footerParts.push(`finishReason=${diagnostic.finishReason}`);
  }
  if (finalMaxTokens > baselineMaxTokens) {
    footerParts.push(
      `max_tokens ${baselineMaxTokens}→${finalMaxTokens} 仍不足`,
    );
  }
  const footer = footerParts.length ? `[${footerParts.join('，')}]` : '';
  const tail =
    '请检查模型是否支持 JSON 输出、上下文窗口与输出预算是否充足后重试。';
  return footer ? `${head} ${footer}。${tail}` : `${head}。${tail}`;
}

/**
 * Recover the JSON object from provider prose / code fences / double-encoded
 * wrappers WITHOUT running schema validation. The caller runs the stats-bearing
 * validator next, so the raw parsed shape (with whatever field names the model
 * used) must be preserved.
 */
function parseRecoveredExtractionObject(text: string): unknown {
  const stripped = stripModelJson(text);
  try {
    return JSON.parse(stripped);
  } catch {
    // Some gateways double-encode content as a JSON string.
    try {
      return JSON.parse(JSON.parse(stripped));
    } catch {
      throw new Error('提取结果不是合法 JSON 或不符合 Canon schema');
    }
  }
}

function buildDropWarning(
  materialType: AnalysisWorkItemType,
  stats: ExtractionStats,
  ownedCategories: Array<keyof ExtractionStats>,
): string | null {
  const dropped = ownedCategories
    .map(cat => ({ cat, s: stats[cat] }))
    .filter(({ s }) => s.dropped > 0);
  if (dropped.length === 0) return null;
  const label = ANALYSIS_MATERIAL_LABELS[materialType];
  const parts = dropped.map(
    ({ cat, s }) =>
      `${cat}: received=${s.received}, accepted=${s.accepted}, dropped=${s.dropped}`,
  );
  return `${label} 部分条目被丢弃：${parts.join('；')}`;
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
  const chapterTextLimit = resolveCanonChapterTextLimit({
    providerType: requestConfig.provider_type,
    contextWindow: requestConfig.context_window,
  });
  const prompt = [
    '你是严谨的原著 Canon 分析器。只允许根据下面给出的章节正文提取事实，禁止利用外部知识或补写。',
    '必须只返回一个合法 JSON 对象，不要 Markdown，不要解释。schemaVersion 必须为 1。',
    `分析档位：${profile}。请同时填写 worldRules、characters、relationships、plotThreads、experiences、knowledge、states、timelineEvents 八个数组；没有被原文支持的事实才使用空数组。`,
    '每一个数组条目都必须至少有一条 evidence。evidence 必须引用本批章节中连续、逐字一致的原文片段作为 quotePreview（不超过 160 字）。',
    '每章 metadata 给出 bodyStart 和 bodyEnd：charStart/charEnd 是全书 UTF-16 绝对偏移；请使用 quotePreview 在该章正文中定位后填写，不能猜测。',
    '人物的 canonicalName 使用原文最常用姓名；关系要写双方、关系性质和态度；剧情要写已发生事实与当前状态；经历必须归属到人物。',
    EXTRACTION_FIELD_SPEC,
    EVIDENCE_FIELD_SPEC,
    EXTRACTION_JSON_SKELETON,
    '章节正文：',
    ...chapters.map(
      c =>
        `### ${c.title} (chapterId=${c.id}, position=${c.position}, bodyStart=${
          c.range.start
        }, bodyEnd=${c.range.end})\n${c.content.slice(0, chapterTextLimit)}`,
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
 * Atomically activate a snapshot as the project's active Canon (Spec §6.1, §4.7,
 * §6.3).
 *
 * This legacy signature cannot safely activate a Canon snapshot: it lacks the
 * required, validated original-style profile. New callers must use
 * {@link activateSnapshotAndStyleProfile}, which activates Canon and style in
 * one transaction.
 */
export async function activateSnapshot(
  projectId: number,
  snapshotId: string,
): Promise<CanonSnapshot> {
  void projectId;
  void snapshotId;
  throw new Error(
    '激活原著资料必须同时提供已完成的原著风格画像，请使用 activateSnapshotAndStyleProfile。',
  );
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
