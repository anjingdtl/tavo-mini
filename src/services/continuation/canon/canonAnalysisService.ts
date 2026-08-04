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
import { asUtf16Offset } from '../continuationSourceRepository';
import { normalizeAlias } from './canonEntityResolver';
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
  type EvidenceOwnerType,
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
  asSourcePosition,
  findNextQueuedBatch,
  insertSubBatchIfAbsent,
  allocateNextBatchIndex,
} from './canonRepository';
import {
  planSourceSlice,
  segmentsToBoundedChapters,
  remainingTailFromAnalyzedEnds,
  applyRetryTailWindow,
} from './canonSourceSlicePlanner';
import {
  upsertWorldRule,
  upsertCharacter,
  upsertRelationship,
  upsertPlotThread,
  upsertExperience,
} from './canonFactUpsert';
import {
  resolveCanonBudget,
  RETRY_CHUNK_RATIOS,
  SOURCE_CHUNK_RATIO_NORMAL,
  SOURCE_CHUNK_RATIO_RESCAN,
} from './canonBudgetPolicy';
import {
  computeCanonOverallProgress,
  computeCanonProgressTotal,
} from './canonProgress';
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
import {
  insertEvidenceAndLink,
  buildEvidenceInsertInput,
} from './canonEvidenceService';
import type { SqlStatement } from '../../../data/connection/transaction';
import { runStyleAnalysis } from '../styleProfile/styleAnalysisService';
import { deleteStyleProfileByFingerprint } from '../styleProfile/styleProfileRepository';
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
import {
  planAdaptiveBatching,
  precheckCanonAnalysis,
  resolveExtractionMaxTokens,
  resolveChapterTextLimitFromBudget,
  estimatePromptOverhead,
  MIN_INPUT_BUDGET_TOKENS,
  type AdaptiveBatch,
  type AdaptiveBatchPlan,
  type CanonAnalysisPrecheck,
} from './adaptiveBatchPlanner';
import {
  countValidCanonRowsForGate,
  evaluateFiveDimensionGate,
  describeGateResult,
  DIMENSION_TO_REQUEST_GROUP,
  REQUIRED_MIN_COUNT,
  MAX_TARGETED_RESCAN_ROUNDS,
  type FiveDimensionGateResult,
  type RequiredCanonDimension,
} from './canonFiveDimensionGate';

/**
 * react-native-sqlite-storage and some native bridges reject with plain
 * objects `{ message, code }` rather than Error. String(err) becomes
 * "[object Object]" and hides the real failure (CAN-101 emulator).
 */
export function formatUnknownError(err: unknown): string {
  if (err instanceof Error) {
    return err.message || err.name || 'Unknown Error';
  }
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const o = err as {
      message?: unknown;
      code?: unknown;
      sqlMessage?: unknown;
    };
    const msg =
      (typeof o.message === 'string' && o.message) ||
      (typeof o.sqlMessage === 'string' && o.sqlMessage) ||
      null;
    if (msg) {
      return o.code != null && o.code !== ''
        ? `${msg} (code=${String(o.code)})`
        : msg;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return Object.prototype.toString.call(err);
    }
  }
  return String(err);
}

export type { AdaptiveBatch, AdaptiveBatchPlan, CanonAnalysisPrecheck };
export {
  planAdaptiveBatching,
  precheckCanonAnalysis,
  resolveExtractionMaxTokens,
  resolveChapterTextLimitFromBudget,
  MIN_INPUT_BUDGET_TOKENS,
};

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

const canonMaterializationRepairs = new Map<
  string,
  Promise<boolean>
>();

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

/**
 * Rebuild a Canon snapshot whose extraction batches and evidence survived a
 * historical table-rebuild migration but whose fact rows did not. This is a
 * local, deterministic repair: it never calls an LLM and it only consumes the
 * completed batch JSON already frozen to the same source/run.
 *
 * The repair is intentionally exposed by the Canon analysis module and called
 * lazily by CanonQueryService. Phase 3 still has no direct access to analysis
 * tables or Canon tables; it only asks the bounded Canon read boundary to
 * heal a known, verifiable historical invariant before reading.
 */
export async function repairMissingCanonMaterialization(input: {
  projectId: number;
  snapshotId: string;
}): Promise<boolean> {
  const key = `${input.projectId}:${input.snapshotId}`;
  const existing = canonMaterializationRepairs.get(key);
  if (existing) return existing;
  const repair = repairMissingCanonMaterializationInner(input).finally(() => {
    canonMaterializationRepairs.delete(key);
  });
  canonMaterializationRepairs.set(key, repair);
  return repair;
}

async function repairMissingCanonMaterializationInner(input: {
  projectId: number;
  snapshotId: string;
}): Promise<boolean> {
  const db = await openDatabase();
  const counts: number[] = [];
  for (const table of CANON_AUTO_ADOPT_TABLES) {
    const [result] = await db.executeSql(
      `SELECT COUNT(*) AS c FROM ${table} WHERE snapshot_id = ?`,
      [input.snapshotId],
    );
    counts.push(Number(result.rows.item(0).c ?? 0));
  }
  if (counts.some(count => count > 0)) return false;

  const snapshot = await getSnapshotById(input.snapshotId);
  if (!snapshot || snapshot.projectId !== input.projectId) return false;
  if (!snapshot.analysisRunId) return false;
  const run = await getRunById(snapshot.analysisRunId);
  if (!run || run.projectId !== input.projectId) return false;

  const batches = (await listBatches(run.id)).filter(
    batch => batch.state === 'completed' && Boolean(batch.resultJson),
  );
  if (batches.length === 0) return false;
  const sourceSnapshot = await continuationSourceReader.getSnapshot(
    input.projectId,
  );

  let restored = false;
  for (const batch of batches) {
    const batchResultJson = batch.resultJson;
    if (!batchResultJson) continue;
    const chapters =
      await continuationSourceReader.listBoundedSourceChaptersForRange(
        sourceSnapshot,
        batch.startPosition,
        batch.endPosition,
      );
    const result = parseExtractionResultJson(batchResultJson);
    await materializeBatchResult(
      db,
      {
        projectId: run.projectId,
        sourceId: run.sourceId,
        snapshotId: run.canonSnapshotId,
        runId: run.id,
        boundaryExclusive: run.boundaryCharOffsetExclusive,
        profile: run.profile,
      },
      result,
      chapters,
    );
    restored = true;
  }
  return restored;
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

/**
 * Online models may expose a much larger context than local llama.cpp. Use the
 * configured window to group consecutive chapters aggressively while reserving
 * the FULL configured output budget (never compressed). If the provider does
 * not declare a window, retain the conservative legacy three-chapter grouping
 * instead of guessing.
 *
 * NOTE: the canonical batch planner is now `planAdaptiveBatching` in
 * adaptiveBatchPlanner.ts (30% source-chunk target). This function is retained
 * only for legacy tests / callers and now honours the same "no output ceiling"
 * rule: it subtracts the full configured `max_output_tokens`, never a 65K cap.
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
  // Full configured max output, never compressed by an internal cap.
  const outputReserve = Math.max(16_384, input.maxOutputTokens ?? 16_384);
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
  // Kept for compatibility with old callers. New adaptive batching is always
  // text-token driven, including full_canon; chapter count only supplies
  // provenance boundaries and must not create needless LLM calls.
  return input.contextCapacity;
}

/**
 * Per-chapter text budget used by the legacy `extractMaterialWithLlm` fallback
 * path (when an old interrupted run resumes without a persisted adaptive plan).
 * The canonical path uses `resolveChapterTextLimitFromBudget`. This online
 * fallback cap is generous so normal chapters pass untouched; it does NOT
 * affect max output or thinking.
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
 * Legacy per-batch window-fit estimator. The canonical path is now
 * `planAdaptiveBatching`. This legacy function is retained for any caller that
 * still references it; it honours the full configured output baseline (no
 * 65K/32K internal cap) when downgrading.
 */
export function planAnalysisTokenBudget(input: {
  chapters: BoundedSourceChapter[];
  profile: AnalysisProfile;
  perBatch: number;
  providerType?: string | null;
  contextWindow: number | null | undefined;
  /** Full configured max_output_tokens, used as the output reserve. */
  maxOutputTokens?: number | null;
  contextWindowCeiling?: number;
}): AnalysisTokenBudgetPlan {
  const isLocal = input.providerType === 'llama_cpp';
  // 在线模型未配置 context_window 时用 32K 保守默认
  const fallbackOnlineWindow = 32_768;
  const declaredWindow =
    input.contextWindow ?? (isLocal ? null : fallbackOnlineWindow);
  if (declaredWindow == null) {
    // 本地模型未声明窗口：按 clamp floor 4096 处理（旧行为）
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
  const effectiveWindow = Math.min(declaredWindow, ceiling);
  // Full configured output (or a per-profile baseline when unconfigured). Never
  // a Canon-specific 32K/65K ceiling.
  const profileOutputBaseline: Record<AnalysisProfile, number> = {
    quick: 4096,
    standard: 8192,
    deep: 8192,
  };
  const outputBaseline =
    (input.maxOutputTokens && input.maxOutputTokens > 0
      ? input.maxOutputTokens
      : profileOutputBaseline[input.profile]) ?? 8192;
  const overhead = CANON_PROMPT_OVERHEAD_TOKENS + 256; // prompt + misc safety
  // 在线模型用 24000 字符 slice（与 extractMaterialWithLlm 一致），本地模型用 6000
  const initialSliceCharBudget = isLocal
    ? 6000
    : CANON_ONLINE_CHAPTER_TEXT_LIMIT;

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
  let sliceCharBudget = initialSliceCharBudget;
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
      downgraded:
        perBatch < input.perBatch || sliceCharBudget < initialSliceCharBudget,
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
    reason: `模型上下文不足以执行 Canon 分析（估算输入 ${probe.inputEstimate} tokens / 有效窗口 ${effectiveWindow}，需预留输出 ${outputBaseline} tokens），请改用更大上下文窗口的模型或减少单批章节。`,
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
    /**
     * 2026-08-04 修复（问题1）：落库前回读校验闭包。当提供时，每条 evidence
     * 在 INSERT 前会按 [charStart, charEnd) 回读原文并与 quotePreview 比对，
     * 不一致则拒绝落库。由调用方（processAnalysisRunInner）从 Phase 1
     * SourceReader 构造；为 undefined 时退化为仅边界检查（兼容旧调用方）。
     */
    readBackVerifier?: (charStart: number, charEnd: number) => Promise<string>;
    /** Schema 33 evidence provenance — defaults to 'batch'. */
    sourceOrigin?: 'batch' | 'rescan';
    rescanOperationId?: string;
    /**
     * 2026-08-04 修复（问题2）：当为 true 时跳过开头的"清空该 batch 范围全部
     * 证据/事实"逻辑。定向补扫（materializeRescanResult）会先做自己的分类级
     * 删除，然后以 skipStandardDelete=true 调用本函数复用 INSERT 逻辑，避免
     * 误删其他 request group 的证据。
     */
    skipStandardDelete?: boolean;
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
  // 统一 evidence 入口：所有 owner type 都必须走 buildEvidenceInsertInput，
  // 禁止业务循环手工拼装（会漏 readBackVerifier / sourceOrigin / rescanOperationId）。
  const evCtx = {
    projectId: ctx.projectId,
    sourceId: ctx.sourceId,
    snapshotId: ctx.snapshotId,
    analysisRunId: ctx.runId,
    boundaryExclusive: ctx.boundaryExclusive,
    readBackVerifier: ctx.readBackVerifier,
    sourceOrigin: ctx.sourceOrigin,
    rescanOperationId: ctx.rescanOperationId,
  };
  const evInput = (candidate: ExtractionEvidenceCandidate) =>
    buildEvidenceInsertInput(evCtx, candidate);

  // Atomic materialization: BEGIN … COMMIT/ROLLBACK so any failure leaves no
  // half-written facts/evidence/links for this batch.
  await execute(db, 'BEGIN IMMEDIATE');
  try {
    await materializeBatchResultBody(db, ctx, result, chapters, {
      fromPos,
      pos,
      ts,
      evInput,
    });
    await execute(db, 'COMMIT');
  } catch (error) {
    try {
      await execute(db, 'ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    throw error;
  }
}

async function materializeBatchResultBody(
  db: SQLite.SQLiteDatabase,
  ctx: {
    projectId: number;
    sourceId: number;
    snapshotId: string;
    runId: string;
    boundaryExclusive: number;
    profile: AnalysisProfile;
    readBackVerifier?: (charStart: number, charEnd: number) => Promise<string>;
    sourceOrigin?: 'batch' | 'rescan';
    rescanOperationId?: string;
    skipStandardDelete?: boolean;
    signal?: AbortSignal;
  },
  result: ChapterExtractionResult,
  chapters: BoundedSourceChapter[],
  meta: {
    fromPos: ReturnType<typeof asSourcePosition> | number;
    pos: ReturnType<typeof asSourcePosition> | number;
    ts: string;
    evInput: (
      candidate: ExtractionEvidenceCandidate,
    ) => Parameters<typeof insertEvidenceAndLink>[1];
  },
): Promise<void> {
  const { fromPos, pos, ts, evInput } = meta;
  // Re-bind local names used by the original body below.
  void chapters;

  // 清理该 batch 的旧 canon 数据，防止 resume 重跑时重复 INSERT。
  // characters 跨 batch 共享（ensureCharacter 通过 nameToId 去重），不删；
  // evidence 表没有 valid_from_position，按 chapter_position 区间清理（CAN-101）；
  // 其余子表按 valid_from_position = fromPos 清理。
  // 2026-08-04 修复（问题2）：canon_world_rules 原本没有删除语句，补扫/resume
  // 重跑会累积重复行——这里补上按 valid_from_position 的删除，与其他子表一致。
  // 定向补扫走 skipStandardDelete=true，由 materializeRescanResult 自行做分类级
  // 删除，避免误删其他 request group 的证据。
  if (!ctx.skipStandardDelete) {
    // Individual executes (already inside BEGIN IMMEDIATE from caller).
    // With business-key upserts we only clear batch evidence for this range;
    // fact rows are merged in place so position-scoped fact deletes are gone.
    await execute(
      db,
      `DELETE FROM canon_evidence
        WHERE snapshot_id = ? AND analysis_run_id = ?
          AND source_origin = 'batch'
          AND chapter_position >= ? AND chapter_position <= ?`,
      [ctx.snapshotId, ctx.runId, fromPos, pos],
    );
    await execute(
      db,
      `DELETE FROM canon_character_aliases
        WHERE snapshot_id = ? AND analysis_run_id = ? AND valid_from_position = ?`,
      [ctx.snapshotId, ctx.runId, fromPos],
    );
  }

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
  // H5 修复：原 registerCharacterName 每次 push 后调
  // buildUniqueCharacterNameIndex 全量重建 Map（O(N) 遍历 + normalizeAlias
  // 正则），batch 内 N 次注册 → O(N²)。改增量维护两个 Map：
  //   candidates: normalized -> Set<characterId>  候选集
  //   nameToId:   normalized -> characterId       仅当候选 size==1 时存在
  // 新增 entry 时更新候选集：size 由 0/1→1 时写入 nameToId，size 由 1→2 时
  // 移除原唯一项，保持与 buildUniqueCharacterNameIndex 完全相同语义。
  const candidates = new Map<string, Set<number>>();
  const nameToId = new Map<string, number>();
  for (const entry of characterNameEntries) {
    const normalized = normalizeAlias(entry.name);
    if (!normalized) continue;
    const ids = candidates.get(normalized) ?? new Set<number>();
    ids.add(entry.characterId);
    candidates.set(normalized, ids);
  }
  for (const [normalized, ids] of candidates) {
    if (ids.size === 1) nameToId.set(normalized, [...ids][0]);
  }
  const registerCharacterName = (characterId: number, name: string) => {
    const normalized = normalizeAlias(name);
    if (!normalized) return;
    const ids = candidates.get(normalized) ?? new Set<number>();
    const prevSize = ids.size;
    ids.add(characterId);
    candidates.set(normalized, ids);
    if (prevSize === 0) {
      nameToId.set(normalized, characterId);
    } else if (prevSize === 1) {
      // 原 1 个候选现在变 2 个 → 不再唯一，移除
      nameToId.delete(normalized);
    }
    // prevSize >= 2 时本就是歧义名，nameToId 里没有，无需操作
  };

  const factCtx = {
    projectId: ctx.projectId,
    sourceId: ctx.sourceId,
    snapshotId: ctx.snapshotId,
    runId: ctx.runId,
    fromPos: Number(fromPos),
    toPos: Number(pos),
    extractionVersion: EXTRACTION_VERSION,
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
    // Upsert by (snapshot_id, canonical_name) and return the REAL row id.
    // Never use last_insert_rowid() after ON CONFLICT updates.
    const id = await upsertCharacter(db, factCtx, {
      canonicalName: name,
      description,
      importance,
      confidence,
    });
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
        evInput(ev),
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
    const ruleId = await upsertWorldRule(db, factCtx, {
      category: rule.category,
      title: rule.title,
      description: rule.description,
      constraintLevel: rule.constraintLevel,
      confidence: rule.confidence,
    });
    for (const ev of rule.evidence) {
      await insertEvidenceAndLink(db, evInput(ev), 'world_rule', ruleId);
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
      const relId = await upsertRelationship(db, factCtx, {
        sourceCharacterId: srcId,
        targetCharacterId: tgtId,
        relationType: rel.relationType,
        attitude: rel.attitude,
        publicStatus: rel.publicStatus,
        description: rel.description,
        confidence: rel.confidence,
      });
      for (const ev of rel.evidence) {
        await insertEvidenceAndLink(
          db,
          evInput(ev),
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
    const plotId = await upsertPlotThread(db, factCtx, {
      title: plot.title,
      description: plot.description,
      level: plot.level,
      status: plot.status,
      confidence: plot.confidence,
      establishedFactsJson: establishedFacts,
    });
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
        evInput(ev),
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
    const expId = await upsertExperience(db, factCtx, {
      characterId: cid,
      eventType: exp.eventType,
      title: exp.title,
      description: exp.description,
      importance: exp.importance,
      confidence: exp.confidence,
      chapterPosition: Number(pos),
    });
    for (const ev of exp.evidence) {
      await insertEvidenceAndLink(db, evInput(ev), 'experience', expId);
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
          evInput(evidence),
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
          evInput(evidence),
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
        await insertEvidenceAndLink(db, evInput(e), 'timeline_event', tid);
      }
    }
  }
}

/**
 * 2026-08-04 修复（问题2）：定向补扫专用物化入口。
 *
 * 与普通 batch 的 {@link materializeBatchResult} 不同，定向补扫只补某个
 * request group（character_state 或 world_plot），但原实现复用了普通 batch 的
 * "清空该 batch 范围全部证据"删除块——这会误删其他 request group 已有证据，
 * 导致补 character_state 时 world_plot 的证据全没，反之亦然。
 *
 * 本函数的删除语义严格按 request group 拥有的 owner_type 限定，且只删
 * `source_origin='rescan'` 且 `rescan_operation_id` 匹配本轮的证据，绝不触碰
 * 其他批次（source_origin='batch'）或其他分类的证据和事实。事实表通过
 * Schema 33 的业务唯一索引（ON CONFLICT DO UPDATE）做增量 upsert，避免重复行。
 *
 * 实现策略：先做本轮分类级 + operation 级的精确定位删除，然后以
 * `skipStandardDelete=true` 调用 materializeBatchResult 复用全部 INSERT 逻辑，
 * 传入 sourceOrigin='rescan' + rescanOperationId 让新证据带上本轮来源标识。
 */
export async function materializeRescanResult(
  db: SQLite.SQLiteDatabase,
  ctx: {
    projectId: number;
    sourceId: number;
    snapshotId: string;
    runId: string;
    boundaryExclusive: number;
    profile: AnalysisProfile;
    /** The request group being rescanned — scopes deletes to its owner types. */
    requestGroup: AnalysisWorkItemType;
    /** Unique id for this rescan operation — scopes evidence deletes to this round. */
    rescanOperationId: string;
    readBackVerifier?: (charStart: number, charEnd: number) => Promise<string>;
  },
  result: ChapterExtractionResult,
  chapters: BoundedSourceChapter[],
): Promise<void> {
  const ownerTypes = REQUEST_GROUP_OWNER_TYPES[ctx.requestGroup] ?? [];
  // 1. 冻结本轮 rescan evidence IDs，再删 links，再删 evidence。
  //    旧实现先删 links 再 `EXISTS(link)` 找 evidence → links 已空，evidence 残留孤儿。
  const ownerPlaceholders = ownerTypes.map(() => '?').join(',');
  const [idRows] = await db.executeSql(
    `SELECT DISTINCT e.id AS id
      FROM canon_evidence e
      INNER JOIN canon_evidence_links l ON l.evidence_id = e.id
      WHERE e.snapshot_id = ?
        AND e.analysis_run_id = ?
        AND e.source_origin = 'rescan'
        AND e.rescan_operation_id = ?
        AND l.owner_type IN (${ownerPlaceholders})`,
    [ctx.snapshotId, ctx.runId, ctx.rescanOperationId, ...ownerTypes],
  );
  const evidenceIds: number[] = [];
  for (let i = 0; i < idRows.rows.length; i++) {
    evidenceIds.push(idRows.rows.item(i).id as number);
  }
  if (evidenceIds.length > 0) {
    const idPlaceholders = evidenceIds.map(() => '?').join(',');
    await executeTransaction(db, [
      {
        sql: `DELETE FROM canon_evidence_links
          WHERE snapshot_id = ?
            AND owner_type IN (${ownerPlaceholders})
            AND evidence_id IN (${idPlaceholders})`,
        params: [ctx.snapshotId, ...ownerTypes, ...evidenceIds],
      },
      {
        sql: `DELETE FROM canon_evidence
          WHERE id IN (${idPlaceholders})
            AND snapshot_id = ?
            AND analysis_run_id = ?
            AND source_origin = 'rescan'
            AND rescan_operation_id = ?`,
        params: [
          ...evidenceIds,
          ctx.snapshotId,
          ctx.runId,
          ctx.rescanOperationId,
        ],
      },
    ]);
    // Post-condition: no orphan evidence for this operation.
    const [orphanCheck] = await db.executeSql(
      `SELECT COUNT(*) AS c FROM canon_evidence e
        WHERE e.snapshot_id = ?
          AND e.analysis_run_id = ?
          AND e.source_origin = 'rescan'
          AND e.rescan_operation_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM canon_evidence_links l WHERE l.evidence_id = e.id
          )`,
      [ctx.snapshotId, ctx.runId, ctx.rescanOperationId],
    );
    if ((orphanCheck.rows.item(0).c as number) > 0) {
      // Sweep any residual orphans scoped to this operation only.
      await execute(
        db,
        `DELETE FROM canon_evidence
          WHERE snapshot_id = ?
            AND analysis_run_id = ?
            AND source_origin = 'rescan'
            AND rescan_operation_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM canon_evidence_links l WHERE l.evidence_id = canon_evidence.id
            )`,
        [ctx.snapshotId, ctx.runId, ctx.rescanOperationId],
      );
    }
  }
  // 2. 复用 materializeBatchResult 的 INSERT 逻辑，跳过它的范围级删除，
  //    带上 rescan 来源标识。事实表由 Schema 33 唯一索引保证 upsert 语义
  //    （新事实与已有业务键冲突时，由 ensureCharacter / 名称去重处理；
  //    world_rules/plot_threads 等通过唯一索引 + 后续 dedup 兜底）。
  await materializeBatchResult(
    db,
    {
      projectId: ctx.projectId,
      sourceId: ctx.sourceId,
      snapshotId: ctx.snapshotId,
      runId: ctx.runId,
      boundaryExclusive: ctx.boundaryExclusive,
      profile: ctx.profile,
      readBackVerifier: ctx.readBackVerifier,
      sourceOrigin: 'rescan',
      rescanOperationId: ctx.rescanOperationId,
      skipStandardDelete: true,
    },
    result,
    chapters,
  );
}

/**
 * Map a request group to the evidence owner_types it produces. Used by
 * {@link materializeRescanResult} to scope deletes to exactly the facts/evidence
 * the rescanned group owns, never touching other groups' data.
 */
const REQUEST_GROUP_OWNER_TYPES: Record<
  AnalysisWorkItemType,
  EvidenceOwnerType[]
> = {
  character_state: ['character', 'relationship', 'experience', 'character_state', 'knowledge', 'alias'],
  world_plot: ['world_rule', 'plot_thread', 'timeline_event'],
  // Legacy single-family groups (not used by v3.1 split, retained for safety).
  world_rules: ['world_rule'],
  characters: ['character', 'alias'],
  relationships: ['relationship'],
  plot_threads: ['plot_thread'],
  experiences: ['experience'],
  full_extraction: ['world_rule', 'character', 'relationship', 'plot_thread', 'experience', 'timeline_event', 'character_state', 'knowledge', 'alias'],
};

export async function buildCoverage(
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
  // 2026-08-04 修复（问题5）：五维 categoryCounts 必须与五维 Gate 一致——只计
  // 至少有一条有效 evidence link 的事实。否则补扫后 coverage 仍宣称"有效完成"
  // 而 Gate 却因孤儿事实不计数，造成两者不一致。辅助表（states/knowledge/
  // timeline）不参与五维硬验收，保留简单计数（capabilities 只需 >0）。
  const countWithEvidence = async (table: string, ownerType: string) => {
    const [r] = await db.executeSql(
      `SELECT COUNT(*) AS c FROM ${table} f
        WHERE f.snapshot_id = ?
          AND f.review_status NOT IN ('superseded', 'ignored')
          AND EXISTS (
            SELECT 1 FROM canon_evidence_links l
            JOIN canon_evidence e ON e.id = l.evidence_id
            WHERE l.snapshot_id = f.snapshot_id
              AND l.owner_type = ?
              AND l.owner_id = f.id
              AND e.snapshot_id = f.snapshot_id
          )`,
      [snapshotId, ownerType],
    );
    return r.rows.item(0).c as number;
  };
  const worldRules = await countWithEvidence('canon_world_rules', 'world_rule');
  const characters = await countWithEvidence('canon_characters', 'character');
  const states = await count('canon_character_state_snapshots');
  const relationships = await countWithEvidence('canon_relationships', 'relationship');
  const plotThreads = await countWithEvidence('canon_plot_threads', 'plot_thread');
  const experiences = await countWithEvidence('canon_character_experiences', 'experience');
  const knowledge = await count('canon_character_knowledge');
  const timeline = await count('canon_timeline_events');
  // 2026-08-04 修复（问题5）：orphan/future 计数用传入的 db 而非全局 openDatabase，
  // 让 buildCoverage 可在测试内存库上运行，且不依赖连接单例状态。
  const [orphansRow] = await db.executeSql(
    `SELECT COUNT(*) AS c FROM canon_evidence e
      WHERE e.snapshot_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM canon_evidence_links l WHERE l.evidence_id = e.id
        )`,
    [snapshotId],
  );
  const orphans = orphansRow.rows.item(0).c as number;
  const [futureRow] = await db.executeSql(
    `SELECT COUNT(*) AS c FROM canon_evidence
      WHERE snapshot_id = ? AND char_end > ?`,
    [snapshotId, Number.MAX_SAFE_INTEGER],
  );
  void futureRow; // future count tracked separately; not surfaced in coverage yet.

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
  // 2026-08-01 修复：替换原 planAnalysisTokenBudget（写死 32768 outputBaseline）
  // 为 planAdaptiveBatching。新 planner 完全从用户 LLM 配置派生 effectiveInputBudget，
  // 不再硬编码任何上下文窗口阈值；超大章节自动切成 chunk batches 而非拒绝。
  const adaptivePlan = planAdaptiveBatching({
    chapters: plan.nearChapters,
    profile,
    providerType: requestConfig.provider_type,
    contextWindow: requestConfig.context_window,
    maxOutputTokens: requestConfig.max_output_tokens,
    materialType: 'character_state',
  });
  if (!adaptivePlan.ok) {
    throw new Error(
      adaptivePlan.reason ??
        '当前 LLM 配置无法完成 Canon 分析，请调整 context_window 或 max_output_tokens。',
    );
  }
  // 将 AdaptiveBatch[] 转换为 batches 表行：normal batch 用章节区间，
  // chunk batch 用单章区间 + chunkIndex 编码到 idempotencyKey。
  const batches: Array<{
    runId: string;
    canonSnapshotId: string;
    batchIndex: number;
    startPosition: number;
    endPosition: number;
    inputHash: string;
    idempotencyKey: string;
  }> = [];
  // chunk 元数据按 batchIndex 存储，processAnalysisRunInner 读取后做字符切片。
  const batchChunkMeta: Record<
    number,
    {
      chapterId: number;
      chunkIndex: number;
      chunkCount: number;
      chunkStartChar: number;
      chunkEndChar: number;
    }
  > = {};
  for (let i = 0; i < adaptivePlan.batches.length; i++) {
    const batch = adaptivePlan.batches[i];
    let startPosition: number;
    let endPosition: number;
    let inputHashSource: string;
    if (batch.type === 'normal') {
      startPosition = batch.chapters[0].position;
      endPosition = batch.chapters[batch.chapters.length - 1].position + 1;
      inputHashSource = batch.chapters
        .map(c => `${c.id}:${c.content.length}:${c.range.start}-${c.range.end}`)
        .join('|');
    } else {
      startPosition = batch.chapter.position;
      endPosition = batch.chapter.position + 1;
      inputHashSource = `${batch.chapter.id}:chunk${batch.chunkIndex}/${batch.chunkCount}:${batch.chunkStartChar}-${batch.chunkEndChar}`;
      batchChunkMeta[i] = {
        chapterId: batch.chapter.id,
        chunkIndex: batch.chunkIndex,
        chunkCount: batch.chunkCount,
        chunkStartChar: batch.chunkStartChar,
        chunkEndChar: batch.chunkEndChar,
      };
    }
    const inputHash = sha256Hex(inputHashSource);
    batches.push({
      runId,
      canonSnapshotId: snapshotId,
      batchIndex: i,
      startPosition,
      endPosition,
      inputHash,
      idempotencyKey: `${runId}:${i}:${inputHash}`,
    });
  }

  const db = await openDatabase();
  // H8 修复：原 insertSnapshot/insertRun/insertBatches/insertWorkItems 各自独立
  // executeSql（自动提交），中间失败会留下孤儿 snapshot/run（state='queued'
  // 但 progressTotal=0，UI 卡在 0/0，resume 时 listBatches 返回空错误判定
  // "全部完成"并 activate 空 snapshot）。改 try/catch + 补偿事务：任一步失败
  // 时单事务 DELETE 全部已插入记录，保证最终一致性。
  try {
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
      // Overall bar = extraction work items + post-extraction stages
      // (evidence / finalizing / style analysis / style validation).
      progressTotal: computeCanonProgressTotal(
        batches.length * ANALYSIS_REQUEST_GROUPS.length,
      ),
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
  } catch (insertErr) {
    // 补偿事务：按依赖逆序删除已插入的记录，避免孤儿 snapshot/run。
    // staging 阶段尚未插入 canon_evidence 等子表，只需清 4 张主表。
    await executeTransaction(db, [
      {
        sql: 'DELETE FROM continuation_analysis_work_items WHERE run_id = ?',
        params: [runId],
      },
      {
        sql: 'DELETE FROM continuation_analysis_batches WHERE run_id = ?',
        params: [runId],
      },
      {
        sql: 'DELETE FROM continuation_analysis_runs WHERE id = ?',
        params: [runId],
      },
      {
        sql: 'DELETE FROM canon_snapshots WHERE id = ?',
        params: [snapshotId],
      },
    ]).catch(() => {
      // best-effort；补偿失败只能依赖后续 manual cleanup
    });
    throw insertErr;
  }
  await execute(
    db,
    `UPDATE continuation_settings SET analysis_status = 'running', updated_at = ?
      WHERE project_id = ?`,
    [now(), input.projectId],
  );

  // The complete plan is persisted so resume cannot silently widen a tail run.
  await updateRunState(db, runId, {
    checkpointJson: JSON.stringify({
      schemaVersion: 4,
      mode: input.mode,
      extractorMode: 'llm',
      workItemProtocol: 'request_groups_v3_1_split',
      scope: plan.effectiveScope,
      plannedChapterIds: plan.nearChapters.map(chapter => chapter.id),
      plannedRanges: plan.analyzedRanges,
      // 2026-08-01 修复：持久化 adaptiveBatchPlan + batchChunkMeta，让
      // processAnalysisRunInner / resume 知道每个 batch 是 normal 还是 chunk。
      adaptiveBatchPlan: {
        effectiveInputBudget: adaptivePlan.effectiveInputBudget,
        targetInputBudget: adaptivePlan.targetInputBudget,
        outputReserve: adaptivePlan.outputReserve,
        retryOutputCeiling: adaptivePlan.retryOutputCeiling,
        promptOverhead: adaptivePlan.promptOverhead,
        estimatedBatchCount: adaptivePlan.estimatedBatchCount,
      },
      batchChunkMeta,
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
      formatUnknownError(e) || '源快照校验失败',
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
      errorMessage: formatUnknownError(e) || '源已变化',
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
    adaptiveBatchPlan?: {
      effectiveInputBudget: number;
      targetInputBudget?: number;
      outputReserve: number;
      retryOutputCeiling?: number;
      promptOverhead: number;
      estimatedBatchCount: number;
    };
    batchChunkMeta?: Record<
      number,
      {
        chapterId: number;
        chunkIndex: number;
        chunkCount: number;
        chunkStartChar: number;
        chunkEndChar: number;
      }
    >;
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
  // 2026-08-01 修复：读取 adaptiveBatchPlan 与 batchChunkMeta，让 chunk batch
  // 在 extractMaterialWithLlm 调用时做字符切片并附带 chunk 说明。
  const adaptivePlanFromCheckpoint = checkpoint.adaptiveBatchPlan;
  const batchChunkMeta = checkpoint.batchChunkMeta ?? {};

  await updateRunState(db, runId, {
    state: 'running',
    stage: 'chapter_extraction',
  });

  // DB-driven scheduler: always pick the next queued batch from the database
  // so dynamically inserted tail / rescan sub-batches are executed (and
  // survive process restart). Never iterate a one-shot in-memory snapshot.
  const reportOverallProgress = async (
    stage: AnalysisRun['stage'],
    materialType?: AnalysisWorkItemType,
    batchIndex?: number,
    state: AnalysisProgressUpdate['state'] = 'running',
  ): Promise<{ current: number; total: number }> => {
    // Progress is always computed from the database so dynamic sub-batches
    // increase total and survive restart. Post-extraction stages are part of
    // the same bar so 2/2 extraction never reads as "全部完成".
    const items = await listWorkItems(runId);
    const completedWorkItems = items.filter(i => i.state === 'completed').length;
    const progress = computeCanonOverallProgress({
      completedWorkItems,
      workItemCount: items.length,
      stage,
      state: 'running',
    });
    await updateRunState(db, runId, {
      stage,
      progressCurrent: progress.current,
      progressTotal: progress.total,
    });
    options.onProgress?.({
      runId,
      stage,
      progressCurrent: progress.current,
      progressTotal: progress.total,
      materialType,
      batchIndex,
      state,
    });
    return { current: progress.current, total: progress.total };
  };

  const reportWorkItem = async (
    materialType: AnalysisWorkItemType,
    batchIndex: number,
    state: AnalysisProgressUpdate['state'],
  ): Promise<{ current: number; total: number }> =>
    reportOverallProgress(
      'chapter_extraction',
      materialType,
      batchIndex,
      state,
    );

  // Partial coverage is keyed by batchIndex + materialType so two routes
  // shrinking in the same parent batch never overwrite each other.
  type PartialCoverageInfo = {
    materialType: AnalysisWorkItemType;
    analyzedCharEnds: number[];
    effectiveSlice: BoundedSourceChapter[];
    chapterWindows: Map<number, { charStart: number; charEnd: number }>;
  };
  const partialCoverageEntries: PartialCoverageInfo[] = [];

  while (true) {
    if (signal.aborted) {
      break;
    }
    const batch = await findNextQueuedBatch(db, runId);
    if (!batch) break;

    const ts = now();
    await execute(
      db,
      `UPDATE continuation_analysis_batches SET state = 'running', attempt_count = attempt_count + 1, updated_at = ?
        WHERE run_id = ? AND batch_index = ? AND state = 'queued'`,
      [ts, runId, batch.batchIndex],
    );

    try {
      // H1 + H3: stream chapters for this batch range only.
      const slice =
        await continuationSourceReader.listBoundedSourceChaptersForRange(
          sourceSnapshot,
          batch.startPosition,
          batch.endPosition,
        );
      for (const ch of slice) {
        if (ch.range.end > sourceSnapshot.boundary.charOffsetExclusive) {
          throw new Error('批次章节越过边界');
        }
      }

      // Segment fields (Schema 34) take priority over in-memory chunk meta so
      // restart recovery does not depend on process memory.
      let effectiveSlice: typeof slice = slice;
      let chunkMetadata: { chunkIndex: number; chunkCount: number } | undefined;
      const chapterWindows = new Map<
        number,
        { charStart: number; charEnd: number }
      >();

      if (batch.coverageKind === 'retry_tail') {
        // One packed tail per parent×material: may span multiple chapters with
        // an optional mid-chapter start on the first chapter.
        effectiveSlice = applyRetryTailWindow(slice, {
          firstChapterCharStart: batch.sourceCharStart,
          lastChapterCharEnd: batch.sourceCharEnd,
        });
        for (const ch of effectiveSlice) {
          const cs =
            typeof (ch as { chunkStartChar?: number }).chunkStartChar ===
            'number'
              ? (ch as { chunkStartChar: number }).chunkStartChar
              : 0;
          const ce =
            typeof (ch as { chunkEndChar?: number }).chunkEndChar === 'number'
              ? (ch as { chunkEndChar: number }).chunkEndChar
              : cs + ch.content.length;
          chapterWindows.set(ch.id, { charStart: cs, charEnd: ce });
        }
        chunkMetadata = { chunkIndex: 1, chunkCount: 1 };
      } else if (
        batch.chapterId != null &&
        batch.sourceCharStart != null &&
        batch.sourceCharEnd != null
      ) {
        const chapter =
          slice.find(c => c.id === batch.chapterId) ?? slice[0];
        if (!chapter) {
          throw new Error(`子批次章节 ${batch.chapterId} 不存在`);
        }
        const charStart = batch.sourceCharStart;
        const charEnd = batch.sourceCharEnd;
        chapterWindows.set(chapter.id, { charStart, charEnd });
        effectiveSlice = [
          {
            ...chapter,
            content: chapter.content.slice(charStart, charEnd),
            chunkStartChar: charStart,
            chunkEndChar: charEnd,
          },
        ];
        chunkMetadata = {
          chunkIndex: 0,
          chunkCount: 1,
        };
      } else {
        const chunkMeta = batchChunkMeta[batch.batchIndex];
        if (chunkMeta && slice.length === 1) {
          const chapter = slice[0];
          chapterWindows.set(chapter.id, {
            charStart: chunkMeta.chunkStartChar,
            charEnd: chunkMeta.chunkEndChar,
          });
          effectiveSlice = [
            {
              ...chapter,
              content: chapter.content.slice(
                chunkMeta.chunkStartChar,
                chunkMeta.chunkEndChar,
              ),
              chunkStartChar: chunkMeta.chunkStartChar,
              chunkEndChar: chunkMeta.chunkEndChar,
            },
          ];
          chunkMetadata = {
            chunkIndex: chunkMeta.chunkIndex,
            chunkCount: chunkMeta.chunkCount,
          };
        }
      }

      // Always re-read work items for this batch from DB (sub-batches insert
      // new rows after the loop starts).
      const allItemsNow = await listWorkItems(runId);
      const batchItems = allItemsNow.filter(
        item => item.batchIndex === batch.batchIndex,
      );
      // Route-exclusive tail sub-batches only run their material_type.
      const materialsToRun: AnalysisWorkItemType[] =
        batch.materialType != null
          ? [batch.materialType as AnalysisWorkItemType]
          : batchItems.map(item => item.materialType);
      partialCoverageEntries.length = 0;
      const runMaterial = async (materialType: AnalysisWorkItemType) => {
        if (signal.aborted) throw new Error('分析已暂停或取消');
        const item = batchItems.find(
          candidate => candidate.materialType === materialType,
        );
        if (item?.state === 'completed' && item.resultJson) {
          // Re-validate input hash before reusing a cached result.
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
          // retry_tail batches consume ALL remaining text inside this work item
          // (sequential 30% slices) so we never explode into N per-chapter kids.
          const consumeUntilCovered = batch.coverageKind === 'retry_tail';
          const outcome = consumeUntilCovered
            ? await extractMaterialUntilCovered(
                effectiveSlice,
                run.profile,
                run.modelConfigId,
                materialType,
                runId,
                signal,
                metrics => {
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
                adaptivePlanFromCheckpoint,
              )
            : await extractMaterialWithLlm(
                effectiveSlice,
                run.profile,
                run.modelConfigId,
                materialType,
                runId,
                signal,
                metrics => {
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
                chunkMetadata,
                adaptivePlanFromCheckpoint,
              );
          // Late-response guard: cancelled runs must not persist result_json.
          if (signal.aborted) throw new Error('分析已暂停或取消');
          if (outcome.warning) {
            // eslint-disable-next-line no-console
            console.warn(
              `[canon] ${materialType} batch ${batch.batchIndex} warning: ${outcome.warning}`,
            );
          }
          // Main batches may still report partial once; retry_tail must not
          // spawn further per-chapter children (hard cap: 1 tail per route).
          const partialCoverage =
            !consumeUntilCovered && outcome.partialCoverage === true;
          const partialWarning =
            outcome.warning && partialCoverage
              ? `${outcome.warning}；正文尾部因缩块重试未分析，将挂 1 个打包补尾任务`
              : outcome.warning;
          await updateWorkItem(db, {
            runId,
            batchIndex: batch.batchIndex,
            materialType,
            state: 'completed',
            resultJson: JSON.stringify(outcome.result),
            errorCode: partialCoverage
              ? 'partial_coverage'
              : outcome.warning
                ? 'partial_drop'
                : null,
            errorMessage: partialWarning,
            completedAt: now(),
          });
          await reportWorkItem(materialType, batch.batchIndex, 'completed');
          if (partialCoverage && outcome.analyzedCharEnds) {
            partialCoverageEntries.push({
              materialType,
              analyzedCharEnds: outcome.analyzedCharEnds,
              effectiveSlice,
              chapterWindows: new Map(chapterWindows),
            });
          }
          return outcome.result;
        } catch (error) {
          const message = formatUnknownError(error);
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
      const settled = await Promise.allSettled(materialsToRun.map(runMaterial));
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
          // 2026-08-04 修复（问题1）：落库前用 SourceReader 回读校验，确保
          // chunk 偏移错误/越界证据无法落库。
          readBackVerifier: async (cs, ce) =>
            continuationSourceReader.readBoundedEvidenceRange({
              snapshot: sourceSnapshot,
              start: asUtf16Offset(cs),
              end: asUtf16Offset(ce),
            }),
        },
        extraction,
        slice,
      );

      // Hard cap: each parent batch × material_type gets at most ONE retry_tail
      // child that carries the entire remaining range (no per-chapter explosion).
      if (partialCoverageEntries.length > 0 && !signal.aborted) {
        let spawned = 0;
        for (const info of partialCoverageEntries) {
          const tail = remainingTailFromAnalyzedEnds(
            info.effectiveSlice,
            info.analyzedCharEnds,
          );
          if (!tail) continue;

          // Enforce cap even if older code paths left children.
          const existingKids = (await listBatches(runId)).filter(
            b =>
              b.parentBatchIndex === batch.batchIndex &&
              b.materialType === info.materialType &&
              b.coverageKind === 'retry_tail',
          );
          if (existingKids.length > 0) continue;

          const contentHash = sha256Hex(
            [
              tail.firstChapterId,
              tail.firstChapterCharStart,
              tail.lastChapterCharEnd,
              tail.startPosition,
              tail.endPosition,
            ].join(':'),
          );
          const inputHash = sha256Hex(
            [
              run.sourceId,
              run.sourceVersion,
              run.sourceSha256,
              run.parserVersion,
              run.normalizationVersion,
              run.boundaryCharOffsetExclusive,
              run.profile,
              info.materialType,
              tail.startPosition,
              tail.endPosition,
              tail.firstChapterCharStart,
              tail.lastChapterCharEnd,
              'retry_tail',
              EXTRACTION_VERSION,
              contentHash,
            ].join('|'),
          );
          const idempotencyKey = [
            runId,
            batch.batchIndex,
            info.materialType,
            tail.startPosition,
            tail.endPosition,
            tail.firstChapterCharStart,
            'retry_tail',
          ].join(':');

          const nextIndex = await allocateNextBatchIndex(db, runId);
          const { inserted, batchIndex: subBatchIndex } =
            await insertSubBatchIfAbsent(db, {
              runId,
              canonSnapshotId: run.canonSnapshotId,
              batchIndex: nextIndex,
              startPosition: tail.startPosition,
              endPosition: tail.endPosition,
              inputHash,
              idempotencyKey,
              parentBatchIndex: batch.batchIndex,
              materialType: info.materialType,
              chapterId: tail.firstChapterId,
              sourceCharStart: tail.firstChapterCharStart,
              sourceCharEnd: tail.lastChapterCharEnd,
              coverageKind: 'retry_tail',
            });
          if (inserted) {
            await insertWorkItems(db, [
              {
                runId,
                batchIndex: subBatchIndex,
                materialType: info.materialType,
              },
            ]);
            spawned += 1;
          }
        }
        await execute(
          db,
          `UPDATE continuation_analysis_batches SET
            state = 'partial', result_json = ?, error_code = 'partial_coverage',
            error_message = ?,
            had_partial_coverage = 1,
            updated_at = ?, completed_at = NULL
            WHERE run_id = ? AND batch_index = ?`,
          [
            JSON.stringify(extraction),
            spawned > 0
              ? `缩块未覆盖全部正文，已按路线挂 ${spawned} 个打包补尾任务（每路线最多 1 个）`
              : '缩块未覆盖全部正文，补尾任务已存在或无需新建',
            now(),
            runId,
            batch.batchIndex,
          ],
        );
      } else {
        await execute(
          db,
          `UPDATE continuation_analysis_batches SET
            state = 'completed', result_json = ?, error_code = NULL, error_message = NULL,
            updated_at = ?, completed_at = ?
            WHERE run_id = ? AND batch_index = ?`,
          [JSON.stringify(extraction), now(), now(), runId, batch.batchIndex],
        );
      }
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
      const message = formatUnknownError(err);
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

  // Close partial parents whose children have all completed. Parent stays
  // partial only while uncovered tails are still queued/running/failed.
  {
    const latest = await listBatches(runId);
    for (const parent of latest.filter(b => b.state === 'partial')) {
      const children = latest.filter(
        b => b.parentBatchIndex === parent.batchIndex,
      );
      if (children.length === 0) continue;
      const allChildrenDone = children.every(c => c.state === 'completed');
      if (allChildrenDone) {
        await execute(
          db,
          `UPDATE continuation_analysis_batches SET
            state = 'completed', had_partial_coverage = 1,
            error_code = NULL,
            error_message = 'partial 尾段已由子批次完成',
            updated_at = ?, completed_at = ?
            WHERE run_id = ? AND batch_index = ?`,
          [now(), now(), runId, parent.batchIndex],
        );
      }
    }
  }

  // Hard gate before finalizing: any non-terminal batch/work item blocks Gate,
  // style analysis, activation.
  const allBatchesNow = await listBatches(runId);
  const blockingBatches = allBatchesNow.filter(b =>
    ['queued', 'running', 'partial', 'failed'].includes(b.state),
  );
  const allItemsNow = await listWorkItems(runId);
  const blockingItems = allItemsNow.filter(i =>
    ['queued', 'running', 'failed'].includes(i.state),
  );
  if (blockingBatches.length > 0 || blockingItems.length > 0) {
    const hasFailed =
      blockingBatches.some(b => b.state === 'failed') ||
      blockingItems.some(i => i.state === 'failed');
    const hasOpen =
      blockingBatches.some(b =>
        ['queued', 'running', 'partial'].includes(b.state),
      ) ||
      blockingItems.some(i => ['queued', 'running'].includes(i.state));
    if (hasOpen || hasFailed) {
      await updateRunState(db, runId, {
        state: 'failed',
        stage: 'chapter_extraction',
        errorCode: hasFailed ? 'batch_failed' : 'incomplete_batches',
        errorMessage: hasFailed
          ? '存在失败的分析批次或 work item，无法进入最终验收'
          : `仍有未完成批次（queued/running/partial=${blockingBatches
              .map(b => `${b.batchIndex}:${b.state}`)
              .join(',') || 'none'}），禁止最终验收与激活`,
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
  }

  // Evidence validation + finalize. Overall progress includes these stages
  // after extraction so the bar does not sit at 100% while style still runs.
  await reportOverallProgress('evidence_validation');
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

  const failedBatches = allBatchesNow.filter(b => b.state === 'failed');
  const completedBatches = allBatchesNow.filter(
    b => b.state === 'completed' || b.state === 'partial',
  );

  await reportOverallProgress('finalizing');
  // Work items can all be complete before the local evidence/coverage merge is
  // finished. Keep a light database heartbeat during this potentially long
  // phase so the overview can distinguish active result consolidation from a
  // stale 100% screen. The guarded UPDATE never changes a later stage.
  const stopFinalizingHeartbeat = startFinalizingHeartbeat(db, runId);
  const analyzedRanges = completedBatches.map(batch => ({
    startPosition: asSourcePosition(batch.startPosition),
    endPosition: asSourcePosition(batch.endPosition),
  }));
  // H1: finalize 阶段用轻量 metas（不含正文）计算 analyzedChapters / total，
  // 避免 allChapters 全量正文常驻。completedBatches 的 position 区间是
  // half-open [start, end)，章节数 = 区间内 metas 计数。
  const finalMetas =
    await continuationSourceReader.listBoundedSourceChapterMetas(
      sourceSnapshot,
    );
  let analyzedChapters = 0;
  for (const meta of finalMetas) {
    const pos = Number(meta.position);
    if (
      completedBatches.some(
        batch => pos >= batch.startPosition && pos < batch.endPosition,
      )
    ) {
      analyzedChapters += 1;
    }
  }
  const analyzedThroughPosition = completedBatches.reduce(
    (max, batch) => Math.max(max, batch.endPosition - 1),
    0,
  );
  const { capabilities, coverage } = await buildCoverage(
    db,
    run.canonSnapshotId,
    run.profile,
    analyzedChapters,
    finalMetas.length,
    analyzedThroughPosition,
    scope,
    analyzedRanges,
  );

  if (failedBatches.length > 0) {
    stopFinalizingHeartbeat();
    await updateRunState(db, runId, {
      state: 'failed',
      stage: 'chapter_extraction',
      errorCode: 'batch_failed',
      errorMessage: `有 ${failedBatches.length}/${
        allBatchesNow.length
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

  // ── Materialisation re-read verification (quality spec §6 / §11) ───────
  // `result_json` being non-empty does NOT mean analysis succeeded. Verify
  // that the five-dimension Canon tables actually contain rows for THIS run +
  // snapshot. A JSON-with-data-but-tables-empty state (partial transaction
  // failure, wrong snapshot id, etc.) must fail the run, not silently
  // activate an empty snapshot.
  const materializedCounts = await countValidCanonRowsForGate(
    db,
    run.canonSnapshotId,
    runId,
  );
  const materializedTotal =
    materializedCounts.characters +
    materializedCounts.worldRules +
    materializedCounts.relationships +
    materializedCounts.plotThreads +
    materializedCounts.experiences;
  if (materializedTotal === 0) {
    stopFinalizingHeartbeat();
    const msg =
      '原著分析 JSON 已保存，但五维 Canon 表物化后为空（写入失败或事务未提交）。' +
      '本次运行未激活，原有成功产物保持不变。';
    await updateRunState(db, runId, {
      state: 'failed',
      stage: 'finalizing',
      errorCode: 'analysis_materialization_empty',
      errorMessage: msg,
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

  // ── Five-dimension hard gate + targeted rescan (quality spec §7 / §12) ─
  // Each mode must independently pass: characters / world_rules /
  // relationships / plot_threads / experiences each >= REQUIRED_MIN_COUNT, counted from the
  // current run + snapshot after the full pipeline. Missing dimensions
  // trigger a bounded targeted rescan focused on those dimensions only.
  // Keep stage as finalizing (not style_validation) so overall progress and
  // UI labels correctly reflect "still consolidating", not style complete.
  await reportOverallProgress('finalizing');
  let gateResult: FiveDimensionGateResult = evaluateFiveDimensionGate(
    materializedCounts,
  );
  if (!gateResult.passed) {
    gateResult = await runTargetedRescanForMissingDimensions({
      db,
      run,
      sourceSnapshot,
      scope,
      missingDimensions: gateResult.missingDimensions,
      signal,
      onProgress: update => {
        // Keep rescan heartbeats on the overall bar (do not reset to 0/0).
        void reportOverallProgress('finalizing', undefined, undefined, 'running');
        options.onProgress?.(update);
      },
    });
  }
  if (!gateResult.passed) {
    stopFinalizingHeartbeat();
    const summary = describeGateResult(gateResult);
    const msg =
      `${summary}。系统已完成定向补扫（最多 ${MAX_TARGETED_RESCAN_ROUNDS} 轮），` +
      `但仍未达到每维至少 ${REQUIRED_MIN_COUNT} 条的标准。本次结果未激活，` +
      '原有成功分析产物保持不变。';
    await updateRunState(db, runId, {
      state: 'failed',
      stage: 'finalizing',
      errorCode: 'analysis_minimum_coverage_not_met',
      errorMessage: msg,
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

  // 2026-08-04 修复（问题5）：补扫通过后，coverage / capabilities 必须从数据库
  // 重新计算。原逻辑在补扫之前就 buildCoverage 一次，补扫新增的事实不会反映到
  // 快照的 capabilities / categoryCounts / analyzedChapters 里，导致 UI 和
  // CanonQueryService 读到与数据库不一致的旧 coverage。
  const recomputed = await buildCoverage(
    db,
    run.canonSnapshotId,
    run.profile,
    analyzedChapters,
    finalMetas.length,
    analyzedThroughPosition,
    scope,
    analyzedRanges,
  );
  // Keep the Canon snapshot available as a reviewable candidate while the
  // required style analysis is still in flight. The analysis run itself must
  // remain running until atomic Canon + style activation completes; marking it
  // awaiting_review here would stop polling and make an interrupted run
  // impossible to resume before style analysis.
  await updateSnapshotMeta(db, run.canonSnapshotId, {
    status: 'awaiting_review',
    capabilities: recomputed.capabilities,
    coverage: recomputed.coverage,
  });
  await reportOverallProgress('finalizing');
  // Only activateSnapshotAndStyleProfile may mark the run completed.
  // Keep stage=finalizing so heartbeat / overview labels stay in consolidation
  // (not style_validation) until style analysis actually starts.
  await updateRunState(db, runId, {
    state: 'running',
    stage: 'finalizing',
    completedAt: null,
  });
  await execute(
    db,
    `UPDATE continuation_settings SET analysis_status = 'running', updated_at = ?
      WHERE project_id = ?`,
    [now(), run.projectId],
  );

  stopFinalizingHeartbeat();

  // ---- style_analysis stage (Spec §5.1) ----
  // Must run BEFORE the Canon snapshot is activated: otherwise the first
  // continuation could see a ready Canon but no style profile. On failure the
  // snapshot stays awaiting_review (NOT activated) and the run becomes failed;
  // the user can retry style analysis alone.
  await reportOverallProgress('style_analysis');
  // A failed style attempt occupies the UNIQUE fingerprint slot.  This path
  // is also reached by resumeAnalysis (the "重试未完成项" UI action), not only
  // by retryStyleAnalysis, so cleanup must happen at the shared pipeline
  // boundary immediately before inserting the next profile attempt.
  await deleteStyleProfileByFingerprint(run.projectId, {
    sourceId: sourceSnapshot.sourceId,
    sourceVersion: sourceSnapshot.sourceVersion,
    sourceSha256: sourceSnapshot.normalizedSha256,
    parserVersion: sourceSnapshot.parserVersion,
    normalizationVersion: sourceSnapshot.normalizationVersion,
    boundaryChapterId: sourceSnapshot.boundary.chapterId,
    boundaryPosition: sourceSnapshot.boundary.chapterPosition,
    boundaryCharOffsetExclusive: sourceSnapshot.boundary.charOffsetExclusive,
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
  await reportOverallProgress('style_validation');
  await activateSnapshotAndStyleProfile({
    projectId: run.projectId,
    analysisRunId: runId,
    canonSnapshotId: run.canonSnapshotId,
    styleProfileId: styleOutcome.profileId,
    allowStyleSkip: false,
  });

  // Mark the overall bar complete after activation (run may already be
  // completed by activateSnapshotAndStyleProfile).
  {
    const items = await listWorkItems(runId);
    const progress = computeCanonOverallProgress({
      completedWorkItems: items.filter(i => i.state === 'completed').length,
      workItemCount: items.length,
      stage: 'style_validation',
      state: 'completed',
    });
    const latest = await getRunById(runId);
    if (latest && latest.state === 'completed') {
      await updateRunState(db, runId, {
        progressCurrent: progress.current,
        progressTotal: progress.total,
      });
    }
  }

  return (await getRunById(runId))!;
}

/**
 * Touch only the run heartbeat while local finalization is active. This keeps
 * `updated_at` fresh for UI polling without racing a transition to style
 * analysis or changing progress/state fields.
 */
function startFinalizingHeartbeat(
  db: SQLite.SQLiteDatabase,
  runId: string,
): () => void {
  let stopped = false;
  const pulse = () => {
    if (stopped) return;
    void execute(
      db,
      `UPDATE continuation_analysis_runs SET updated_at = ?
        WHERE id = ? AND state = 'running' AND stage = 'finalizing'`,
      [now(), runId],
    ).catch(() => undefined);
  };
  pulse();
  const timer = setInterval(pulse, 10_000);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
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
  // H9 修复：原代码对每个 quote 生成 O(quote_len) 个 anchor（160 字 quote →
  // ~626 anchor），每个 anchor 在 chapter.content（24000 字符）中 indexOf 所有
  // 出现位置，每个位置做 O(quote_len × excerpt_len) 的 lcsLength。单条
  // evidence 最坏数百万操作，100 条 evidence batch 卡死数十秒。
  // 改三步预算控制：
  //   1) anchor 数量上限 64（足够覆盖 160 字 quote 的关键 ngram）
  //   2) 总 indexOf 位置预算 200（找到就停，不再穷举所有出现）
  //   3) 命中 score >= 0.85 立即返回（高质量匹配无需继续）
  const anchors = new Set<string>();
  const ANCHOR_BUDGET = 64;
  for (let size = Math.min(6, normalizedQuote.length); size >= 3; size -= 1) {
    for (let index = 0; index <= normalizedQuote.length - size; index += 1) {
      anchors.add(normalizedQuote.slice(index, index + size));
      if (anchors.size >= ANCHOR_BUDGET) break;
    }
    if (anchors.size >= ANCHOR_BUDGET) break;
  }
  let best: { start: number; preview: string; score: number } | null = null;
  const POSITION_BUDGET = 200;
  let positionsTried = 0;
  for (const anchor of anchors) {
    if (positionsTried >= POSITION_BUDGET) break;
    let index = chapter.content.indexOf(anchor);
    while (index >= 0 && positionsTried < POSITION_BUDGET) {
      positionsTried++;
      const excerpt = sourceSentenceExcerpt(chapter.content, index);
      const score =
        lcsLength(normalizedQuote, normalizedEvidenceText(excerpt.preview)) /
        normalizedQuote.length;
      if (!best || score > best.score) {
        best = { ...excerpt, score };
      }
      // 高质量匹配立即返回，避免无意义穷举
      if (best && best.score >= 0.85) return best;
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
    // 2026-08-04 修复（问题1）：当 chapter 是超长章节被切片后的片段时，
    // `chapter.content` 已经是 `originalContent.slice(chunkStartChar,
    // chunkEndChar)`，`indexOf` 得到的是片段内局部偏移。全书绝对偏移必须加回
    // chunkStartChar，否则第 2 个及之后的 chunk 的 evidence 会整体向前偏移
    // chunkStartChar 个字符。chunkStartChar 对整章对象为 0，行为不变。
    const absoluteOffset = (
      chapter: BoundedSourceChapter,
      localIndex: number,
    ): number =>
      Number(chapter.range.start) + (chapter.chunkStartChar ?? 0) + localIndex;
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
        const charStart = absoluteOffset(
          paraphrase.chapter,
          paraphrase.match.start,
        );
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
        Math.abs(absoluteOffset(a.chapter, a.index) - evidence.charStart) -
        Math.abs(absoluteOffset(b.chapter, b.index) - evidence.charStart),
    );
    const selected = candidates[0];
    const charStart = absoluteOffset(selected.chapter, selected.index);
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

/** Map five-dimension gate keys to extraction JSON array fields. */
const DIMENSION_TO_EXTRACTION_CATEGORY: Record<
  RequiredCanonDimension,
  keyof ExtractionStats
> = {
  characters: 'characters',
  worldRules: 'worldRules',
  relationships: 'relationships',
  plotThreads: 'plotThreads',
  experiences: 'experiences',
};

const DIMENSION_FOCUS_LABELS: Record<RequiredCanonDimension, string> = {
  characters: '人物资料(characters)',
  worldRules: '世界观规则(worldRules)',
  relationships: '人物关系(relationships)',
  plotThreads: '剧情线(plotThreads)',
  experiences: '人物经历(experiences)',
};

export interface ExtractMaterialOutcome {
  result: ChapterExtractionResult;
  /**
   * Non-fatal dropped-item summary written to the work item as a warning
   * (state stays `completed`). `null` when nothing was dropped.
   */
  warning: string | null;
  /**
   * 2026-08-04 修复（问题3）：当本次成功结果是在缩块重试后取得的（即原 batch
   * 正文尾部被截断、未被模型分析），partialCoverage=true。调用方必须据此把未
   * 覆盖的尾部重新规划成持久化子批次，禁止把截断结果当作 batch 完整覆盖。
   */
  partialCoverage?: boolean;
  /**
   * 每个输入章节实际被分析的正文字符终点（相对于该章节 content 的 UTF-16 偏移）。
   * 当 partialCoverage=true 时，该值 < chapter.content.length；调用方据此计算
   * 未覆盖区间 [analyzedCharEnds[i], content.length) 并重新切分子批次。
   */
  analyzedCharEnds?: number[];
}

/**
 * Optional extraction constraints used by targeted rescan.
 * When `requiredCategories` is set, a response that only fills sibling owned
 * categories (e.g. plotThreads when worldRules is missing) is treated as a
 * recoverable failure so the route cannot "succeed" without the missing dims.
 */
export interface ExtractMaterialOptions {
  requiredCategories?: Array<keyof ExtractionStats>;
  focusInstruction?: string;
}

/**
 * Max sequential 30% slices inside one retry_tail work item. Prevents unbounded
 * loops while still covering multi-chapter remaining ranges without DB explosion.
 */
export const MAX_RETRY_TAIL_INNER_SLICES = 24;

/**
 * Consume an entire remaining range by repeatedly slicing at the normal 30%
 * budget and calling {@link extractMaterialWithLlm}. Used only for packed
 * retry_tail batches so each parent×material has at most one child batch.
 */
export async function extractMaterialUntilCovered(
  chapters: BoundedSourceChapter[],
  profile: AnalysisProfile,
  modelConfigId: number | null,
  materialType: AnalysisWorkItemType,
  runId: string,
  signal: AbortSignal,
  onProgress?: (metrics: LLMRequestMetrics) => void,
  adaptivePlan?: {
    effectiveInputBudget: number;
    targetInputBudget?: number;
    outputReserve: number;
    retryOutputCeiling?: number;
    promptOverhead: number;
    estimatedBatchCount: number;
  },
): Promise<ExtractMaterialOutcome> {
  if (!modelConfigId) {
    throw new Error(
      '分析任务缺少 LLM 配置；请重新发起 Standard 或 Deep 分析。',
    );
  }
  const requestConfig = await resolveLLMRequestConfigById(modelConfigId);
  const packBudget = resolveCanonBudget({
    profile,
    declaredContextWindow: requestConfig.context_window,
    configuredMaxOutputTokens: requestConfig.max_output_tokens,
    promptOverhead: estimatePromptOverhead({ profile, materialType }),
    chunkRatio: SOURCE_CHUNK_RATIO_NORMAL,
  });
  // Prefer a healthy 30% pack budget; fall back to whatever adaptive plan had.
  const totalTokenBudget = packBudget.ok
    ? packBudget.sourceChunkTargetTokens
    : adaptivePlan?.targetInputBudget ??
      adaptivePlan?.effectiveInputBudget ??
      4096;

  const sliceAdaptivePlan = {
    effectiveInputBudget: totalTokenBudget,
    targetInputBudget: totalTokenBudget,
    outputReserve:
      packBudget.configuredMaxOutputTokens ||
      adaptivePlan?.outputReserve ||
      8192,
    retryOutputCeiling:
      packBudget.configuredMaxOutputTokens ||
      adaptivePlan?.retryOutputCeiling ||
      8192,
    promptOverhead:
      packBudget.promptOverhead || adaptivePlan?.promptOverhead || 600,
    estimatedBatchCount: adaptivePlan?.estimatedBatchCount ?? 1,
  };

  let startCursor: { chapterId: number; charOffset: number } | null = null;
  const mergedParts: ChapterExtractionResult[] = [];
  const warnings: string[] = [];
  let rounds = 0;

  while (rounds < MAX_RETRY_TAIL_INNER_SLICES) {
    if (signal.aborted) throw new Error('分析已暂停或取消');
    rounds += 1;
    const plan = planSourceSlice({
      chapters,
      totalTokenBudget,
      startCursor,
    });
    if (plan.segments.length === 0) {
      break;
    }
    const sent = segmentsToBoundedChapters(plan);
    const outcome = await extractMaterialWithLlm(
      sent,
      profile,
      modelConfigId,
      materialType,
      runId,
      signal,
      onProgress,
      undefined,
      sliceAdaptivePlan,
    );
    mergedParts.push(outcome.result);
    if (outcome.warning) warnings.push(outcome.warning);

    // Advance past what was actually sent/analysed.
    // planSourceSlice cursors are relative to each chapter's `.content`
    // (already window-trimmed for retry_tail). Convert absolute full-chapter
    // offsets from remainingTailFromAnalyzedEnds when needed.
    if (outcome.partialCoverage && outcome.analyzedCharEnds) {
      const tail = remainingTailFromAnalyzedEnds(sent, outcome.analyzedCharEnds);
      if (tail) {
        const host = chapters.find(c => c.id === tail.firstChapterId);
        const base =
          host &&
          typeof (host as { chunkStartChar?: number }).chunkStartChar ===
            'number'
            ? (host as { chunkStartChar: number }).chunkStartChar
            : 0;
        startCursor = {
          chapterId: tail.firstChapterId,
          charOffset: Math.max(0, tail.firstChapterCharStart - base),
        };
        continue;
      }
    }
    if (plan.nextCursor) {
      startCursor = plan.nextCursor;
      continue;
    }
    // This plan fully covered from startCursor to end of chapters.
    return {
      result: mergeMaterialResults(mergedParts),
      warning: warnings.length ? warnings.join('；') : null,
      partialCoverage: false,
      analyzedCharEnds: chapters.map(c => c.content.length),
    };
  }

  // Hit inner-slice cap: still return whatever we got; do NOT spawn more DB kids.
  return {
    result: mergeMaterialResults(mergedParts),
    warning:
      (warnings.length ? `${warnings.join('；')}；` : '') +
      `打包补尾达到单任务切片上限 ${MAX_RETRY_TAIL_INNER_SLICES}，已尽可能覆盖剩余正文`,
    partialCoverage: false,
    analyzedCharEnds: chapters.map(c => c.content.length),
  };
}

export async function extractMaterialWithLlm(
  chapters: BoundedSourceChapter[],
  profile: AnalysisProfile,
  modelConfigId: number | null,
  materialType: AnalysisWorkItemType,
  runId: string,
  signal: AbortSignal,
  onProgress?: (metrics: LLMRequestMetrics) => void,
  // 2026-08-01 修复：新增 chunk 元数据与 adaptive plan 派生值参数
  chunkMetadata?: { chunkIndex: number; chunkCount: number },
  adaptivePlan?: {
    effectiveInputBudget: number;
    /** Old interrupted runs do not have this field; retain hard-cap fallback. */
    targetInputBudget?: number;
    outputReserve: number;
    retryOutputCeiling?: number;
    promptOverhead: number;
    estimatedBatchCount: number;
  },
  extractOptions?: ExtractMaterialOptions,
): Promise<ExtractMaterialOutcome> {
  if (!modelConfigId) {
    throw new Error(
      '分析任务缺少 LLM 配置；请重新发起 Standard 或 Deep 分析。',
    );
  }
  const requestConfig = await resolveLLMRequestConfigById(modelConfigId);
  // ── Model capability: keep it intact ──────────────────────────────────
  // The request sends the FULL configured max_output_tokens on every attempt.
  // There is no Canon-specific output ceiling (no 65K / 32K / 131072). Thinking
  // mode is preserved: we never emit `thinking: { type: 'disabled' }`. The
  // only thing this function shrinks on failure is the SOURCE CHUNK.
  const requestMaxTokens = resolveExtractionMaxTokens({
    profile,
    maxOutputTokens: requestConfig.max_output_tokens,
    effectiveInputBudget: adaptivePlan?.effectiveInputBudget ?? 0,
    outputReserve: adaptivePlan?.outputReserve,
  });
  // ── Source-chunk sizing (TOTAL request budget, not per-chapter) ───────
  // Normal target = 30% of declared context window. Shrink ladder:
  // 30% → 20% → 12% of context window for the whole request body.
  const baseTokenBudget =
    adaptivePlan?.targetInputBudget ??
    adaptivePlan?.effectiveInputBudget ??
    (() => {
      const budget = resolveCanonBudget({
        profile,
        declaredContextWindow: requestConfig.context_window,
        configuredMaxOutputTokens: requestConfig.max_output_tokens,
        promptOverhead: estimatePromptOverhead({ profile, materialType }),
        chunkRatio: SOURCE_CHUNK_RATIO_NORMAL,
      });
      return budget.sourceChunkTargetTokens;
    })();
  const chunkNotice = chunkMetadata
    ? `\n注意：本章由于篇幅过大，已按字符区间切分为 ${
        chunkMetadata.chunkCount
      } 个片段。当前为第 ${
        chunkMetadata.chunkIndex + 1
      } 个片段。请仅基于本片段内容提取 evidence；跨片段的关联（如人物关系、伏笔）由后续合并阶段处理。bodyStart/bodyEnd 仍按全书 UTF-16 绝对偏移填写。`
    : '';
  const focusInstruction = extractOptions?.focusInstruction?.trim() || '';
  const buildPromptForSegments = (
    segments: ReturnType<typeof planSourceSlice>['segments'],
  ): string =>
    [
      '你是严谨的原著 Canon 分析器。只允许根据下面给出的章节正文提取事实，禁止利用外部知识或补写。',
      '必须只返回一个完整、可 JSON.parse 的 JSON 对象，不要 Markdown、思考过程、解释或任何前后缀。schemaVersion 必须为 1，八个数组字段都必须出现，不能返回 null 或空白。',
      `分析档位：${profile}。${MATERIAL_PROMPTS[materialType]}`,
      focusInstruction,
      '每一个数组条目都必须至少有一条 evidence。evidence 必须引用本批章节中连续、逐字一致的原文片段作为 quotePreview（不超过 160 字）。',
      '每章 metadata 给出 bodyStart 和 bodyEnd：charStart/charEnd 是全书 UTF-16 绝对偏移；请使用 quotePreview 在该章正文中定位后填写，不能猜测。',
      EXTRACTION_FIELD_SPEC,
      EVIDENCE_FIELD_SPEC,
      EXTRACTION_JSON_SKELETON,
      '章节正文：',
      ...segments.map(
        s =>
          `### ${s.title} (chapterId=${s.chapterId}, position=${s.chapterPosition}, bodyStart=${s.absoluteBookCharStart}, bodyEnd=${s.absoluteBookCharEnd}, segmentStart=${s.charStart}, segmentEnd=${s.charEnd})\n${s.content}`,
      ),
      chunkNotice,
    ]
      .filter(Boolean)
      .join('\n');

  // Shrink ladder ratios relative to the base 30% budget: 1.0 → 0.667 → 0.4
  // which maps to 30% → 20% → 12% of context_window.
  const shrinkSteps = RETRY_CHUNK_RATIOS.map(
    ratio => ratio / SOURCE_CHUNK_RATIO_NORMAL,
  );
  let attemptShrinkStep = 0;
  let lastSlicePlan: ReturnType<typeof planSourceSlice> | null = null;
  let lastOutputError: Error | null = null;
  let lastDroppedStats: ExtractionStats | null = null;
  const attemptDiagnostics: CanonExtractionFailureDiagnostic['attempts'] = [];
  let lastDiagnostic: { finishReason?: string | null } | null = null;
  const ownedCategories = MATERIAL_CATEGORY_OWNERSHIP[materialType];
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
      const tokenBudget = Math.max(
        512,
        Math.floor(baseTokenBudget * shrinkSteps[attemptShrinkStep]),
      );
      const slicePlan = planSourceSlice({
        chapters,
        totalTokenBudget: tokenBudget,
      });
      lastSlicePlan = slicePlan;
      if (slicePlan.segments.length === 0) {
        throw canonOutputError('正文预算过小，无法构造提取请求');
      }
      const prompt = buildPromptForSegments(slicePlan.segments);
      const response = await callLLMResult(
        [{ role: 'user', content: `${prompt}${retryInstruction}` }],
        // max_tokens is the full configured value on EVERY attempt — never
        // doubled, never capped. Thinking mode is left to the model default
        // (we do not pass `thinking: { type: 'disabled' }`).
        requestMaxTokens,
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
        // On length / reasoning_only / empty, shrink the SOURCE CHUNK for the
        // next attempt. max_tokens stays at its full configured value.
        if (
          emptyReason === 'length' ||
          emptyReason === 'reasoning_only' ||
          !emptyReason
        ) {
          attemptShrinkStep = Math.min(
            attemptShrinkStep + 1,
            shrinkSteps.length - 1,
          );
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
        // Truncated JSON: shrink the TOTAL source budget so the model has more
        // output headroom relative to its input.
        if (lastDiagnostic.finishReason === 'length') {
          attemptShrinkStep = Math.min(
            attemptShrinkStep + 1,
            shrinkSteps.length - 1,
          );
        }
        throw canonOutputError(
          formatUnknownError(error) || '提取结果不是合法 JSON',
        );
      }
      // Evidence resolution must use the segments actually sent, not the full
      // original chapters (unsent tails have no quote support).
      const sentChapters = lastSlicePlan
        ? segmentsToBoundedChapters(lastSlicePlan)
        : chapters;
      const evidenceResolution = resolveExtractionEvidenceAgainstChapters(
        parsed,
        sentChapters,
      );
      parsed = evidenceResolution.result;
      const filtered = onlyMaterial(parsed, materialType);
      // S3 (strengthened): the route is responsible for its owned categories.
      // If the route produced NO valid data for its owned categories — whether
      // because (a) the model returned items but all were dropped by schema,
      // or (b) the model returned a legitimately-shaped but all-empty result
      // for its owned route — treat it as a recoverable failure and shrink the
      // source chunk. Previously a truly-empty owned array (received===0)
      // bypassed retry; that let a lazy "all empty arrays" response succeed.
      const ownedTotalAfterValidation = ownedCategories.reduce(
        (sum, cat) => sum + parsed[cat].length,
        0,
      );
      const wiped = ownedCategories.filter(
        cat =>
          stats[cat].received > 0 &&
          (stats[cat].accepted === 0 || parsed[cat].length === 0),
      );
      // Targeted rescan: require the specifically missing categories, not just
      // any sibling owned category. Otherwise a world_plot rescan that only
      // re-emits plotThreads can "succeed" while worldRules stays at 0.
      const requiredCategories = extractOptions?.requiredCategories ?? [];
      const missingRequired = requiredCategories.filter(
        cat => (parsed[cat]?.length ?? 0) === 0,
      );
      if (
        ownedTotalAfterValidation === 0 ||
        wiped.length > 0 ||
        missingRequired.length > 0
      ) {
        lastDroppedStats = stats;
        attemptDiagnostics.push(
          extractionAttemptDiagnostic(
            rawExtraction,
            stats,
            response.text.length,
            (response as { finishReason?: string | null })?.finishReason,
          ),
        );
        // Shrink the TOTAL source budget for the next attempt.
        attemptShrinkStep = Math.min(
          attemptShrinkStep + 1,
          shrinkSteps.length - 1,
        );
        const detail =
          missingRequired.length > 0
            ? `定向补扫必填分类仍为空：${missingRequired.join('、')}`
            : wiped.length > 0
              ? `本组负责的分类全部被丢弃：${wiped
                  .map(cat => `${cat}(received=${stats[cat].received})`)
                  .join('、')}`
              : '本组负责的所有分类在 Schema/evidence 校验后均无有效条目';
        throw canonOutputError(detail);
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
      // partialCoverage only when the total-budget slicer did not fully cover
      // the input chapters (not merely because a retry happened).
      const plan = lastSlicePlan!;
      const partialCoverage = plan.fullyCovered === false;
      // analyzedCharEnds are relative to each input chapter's content string
      // (which may already be a window slice for segment sub-batches).
      const analyzedCharEnds = chapters.map(c => {
        const segs = plan.segments.filter(s => s.chapterId === c.id);
        if (segs.length === 0) return 0;
        const chunkBase =
          typeof (c as { chunkStartChar?: number }).chunkStartChar === 'number'
            ? (c as { chunkStartChar: number }).chunkStartChar
            : 0;
        // charEnd is in full-chapter coords when chunkBase>0; convert to content-relative.
        const maxEnd = Math.max(...segs.map(s => s.charEnd));
        return Math.min(c.content.length, Math.max(0, maxEnd - chunkBase));
      });
      return {
        result: filtered,
        warning,
        partialCoverage,
        analyzedCharEnds,
      };
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
        requestMaxTokens,
        requestMaxTokens,
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

/**
 * Targeted rescan for dimensions still below the hard minimum after the normal
 * batch pass (quality spec §8 / §12.3).
 *
 * For each missing dimension, re-analyse the CURRENT MODE's source range
 * (full = all chapters, quick = last 10) with a prompt focused on the missing
 * dimension's request group and a smaller source chunk (15% of the declared
 * window). The model's max output and thinking mode stay fully intact.
 *
 * New results flow through the SAME Schema → evidence → materialise → re-read
 * pipeline. The run is scoped: it never reads another mode's data, and
 * duplicate facts are filtered by the existing per-position DELETE-then-INSERT
 * in `materializeBatchResult` plus character name dedup.
 *
 * Bounded to {@link MAX_TARGETED_RESCAN_ROUNDS} rounds. If dimensions remain
 * below the minimum after exhausting rounds, the returned gate result has
 * `passed === false` and the caller must fail the run without activating.
 */
async function runTargetedRescanForMissingDimensions(input: {
  db: SQLite.SQLiteDatabase;
  run: AnalysisRun;
  sourceSnapshot: ContinuationSourceSnapshot;
  scope: AnalysisScope;
  missingDimensions: RequiredCanonDimension[];
  signal: AbortSignal;
  onProgress?: (update: AnalysisProgressUpdate) => void;
}): Promise<FiveDimensionGateResult> {
  const { db, run, sourceSnapshot, scope, signal, onProgress } = input;
  // Re-select the current mode's source range. Full mode rescans ALL chapters;
  // quick mode rescans only the last 10. Never reads the other mode's data.
  const allChapters = await continuationSourceReader.listBoundedSourceChapters(
    sourceSnapshot,
  );
  const plan = planAnalysisScope(allChapters, scope);
  const rescanChapters = plan.nearChapters;
  if (rescanChapters.length === 0) {
    const counts = await countValidCanonRowsForGate(
      db,
      run.canonSnapshotId,
      run.id,
    );
    return evaluateFiveDimensionGate(counts);
  }
  // 2026-08-04 修复（问题4）：从真实 LLM context_window 派生 15% source chunk
  // 预算，而不是传 undefined 退回硬编码上限。max_output_tokens 保持用户完整配置，
  // thinking 保持模型默认。prompt overhead 正确计入。协议要求 input+output<=context
  // 时只缩正文（resolveCanonBudget 内部处理）。
  const rescanRequestConfig = run.modelConfigId
    ? await resolveLLMRequestConfigById(run.modelConfigId)
    : null;
  const rescanPromptOverhead = estimatePromptOverhead({
    profile: run.profile,
    materialType: 'character_state',
  });
  const rescanBudget = resolveCanonBudget({
    profile: run.profile,
    declaredContextWindow: rescanRequestConfig?.context_window,
    configuredMaxOutputTokens: rescanRequestConfig?.max_output_tokens,
    promptOverhead: rescanPromptOverhead,
    chunkRatio: SOURCE_CHUNK_RATIO_RESCAN,
  });
  const rescanAdaptivePlan = rescanBudget.ok
    ? {
        effectiveInputBudget: rescanBudget.sourceChunkTargetTokens,
        targetInputBudget: rescanBudget.sourceChunkTargetTokens,
        outputReserve: rescanBudget.configuredMaxOutputTokens,
        retryOutputCeiling: rescanBudget.configuredMaxOutputTokens,
        promptOverhead: rescanBudget.promptOverhead,
        estimatedBatchCount: 1,
      }
    : undefined;
  // Group missing dimensions by their producing request group so each rescan
  // call covers exactly the dimensions that need more data.
  const groupsToRescan = new Set(
    input.missingDimensions.map(dim => DIMENSION_TO_REQUEST_GROUP[dim]),
  );
  for (let round = 1; round <= MAX_TARGETED_RESCAN_ROUNDS; round += 1) {
    if (signal.aborted) break;
    let addedAny = false;
    // Round 1: scan from the boundary side (end). Round 2: scan from the
    // start of the mode-scoped range. Quick mode never leaves last-10 chapters.
    const half = Math.ceil(rescanChapters.length / 2);
    const roundChapters =
      round === 1
        ? rescanChapters.slice(-half)
        : rescanChapters.slice(0, Math.max(half, 1));
    for (const requestGroup of groupsToRescan) {
      if (signal.aborted) break;
      const currentCounts = await countValidCanonRowsForGate(
        db,
        run.canonSnapshotId,
        run.id,
      );
      const currentGate = evaluateFiveDimensionGate(currentCounts);
      const stillMissingForGroup = currentGate.missingDimensions.filter(
        dim => DIMENSION_TO_REQUEST_GROUP[dim] === requestGroup,
      );
      if (stillMissingForGroup.length === 0) continue;

      const requiredCategories = stillMissingForGroup.map(
        dim => DIMENSION_TO_EXTRACTION_CATEGORY[dim],
      );
      const focusLabels = stillMissingForGroup
        .map(dim => DIMENSION_FOCUS_LABELS[dim])
        .join('、');
      const focusInstruction =
        `【定向补扫】当前五维硬验收不足：${focusLabels}。` +
        `本请求必须优先并尽量多地补充这些不足维度（每维尽量产出多条带原文 evidence 的有效条目），` +
        `已充足维度可少写或不写。禁止只重复已充足维度来敷衍。` +
        `禁止编造原文没有的事实。`;

      // Slice the mode-scoped chapters under a 15% TOTAL token budget. One
      // rescan round may produce multiple 15% requests; never dump half the
      // book into a single extractor call.
      let cursor: { chapterId: number; charOffset: number } | null = null;
      let sliceGuard = 0;
      const maxSlicesPerRound = Math.max(1, roundChapters.length * 4);
      while (sliceGuard < maxSlicesPerRound) {
        sliceGuard += 1;
        if (signal.aborted) break;
        const tokenBudget =
          rescanAdaptivePlan?.targetInputBudget ??
          rescanAdaptivePlan?.effectiveInputBudget ??
          4096;
        const slicePlan = planSourceSlice({
          chapters: roundChapters,
          totalTokenBudget: tokenBudget,
          startCursor: cursor,
        });
        if (slicePlan.segments.length === 0) break;
        const sentChapters = segmentsToBoundedChapters(slicePlan);
        try {
          const outcome = await extractMaterialWithLlm(
            sentChapters,
            run.profile,
            run.modelConfigId,
            requestGroup,
            run.id,
            signal,
            undefined,
            undefined,
            rescanAdaptivePlan,
            {
              requiredCategories,
              focusInstruction,
            },
          );
          if (signal.aborted) break;
          // Materialize ONLY the segments that were actually sent.
          await materializeRescanResult(
            db,
            {
              projectId: run.projectId,
              sourceId: run.sourceId,
              snapshotId: run.canonSnapshotId,
              runId: run.id,
              boundaryExclusive: run.boundaryCharOffsetExclusive,
              profile: run.profile,
              requestGroup,
              rescanOperationId: `${run.id}:rescan:r${round}:${requestGroup}:s${sliceGuard}`,
              readBackVerifier: async (cs, ce) =>
                continuationSourceReader.readBoundedEvidenceRange({
                  snapshot: sourceSnapshot,
                  start: asUtf16Offset(cs),
                  end: asUtf16Offset(ce),
                }),
            },
            outcome.result,
            sentChapters,
          );
          addedAny = true;
        } catch (err) {
          if (signal.aborted) break;
          onProgress?.({
            runId: run.id,
            stage: 'finalizing',
            progressCurrent: 0,
            progressTotal: 0,
            state: 'running',
          });
          void err;
        }
        if (slicePlan.fullyCovered || !slicePlan.nextCursor) break;
        cursor = slicePlan.nextCursor;
      }
    }
    const afterCounts = await countValidCanonRowsForGate(
      db,
      run.canonSnapshotId,
      run.id,
    );
    const afterGate = evaluateFiveDimensionGate(afterCounts);
    if (afterGate.passed) return afterGate;
    if (!addedAny) break;
  }
  const finalCounts = await countValidCanonRowsForGate(
    db,
    run.canonSnapshotId,
    run.id,
  );
  return evaluateFiveDimensionGate(finalCounts);
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
  // Persist terminal/paused state BEFORE aborting network so late responses
  // observe the durable state and refuse to write.
  await updateRunState(db, runId, { state: 'paused' });
  await execute(
    db,
    `UPDATE continuation_analysis_work_items SET state = 'queued', updated_at = ?
      WHERE run_id = ? AND state IN ('running', 'cancelled')`,
    [now(), runId],
  );
  await execute(
    db,
    `UPDATE continuation_analysis_batches SET state = 'queued', updated_at = ?
      WHERE run_id = ? AND state = 'running'`,
    [now(), runId],
  );
  analysisControllers.get(runId)?.abort();
}

export async function cancelAnalysis(runId: string): Promise<void> {
  const db = await openDatabase();
  const run = await getRunById(runId);
  if (!run) return;
  // 1) Persist cancelled state first
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
  await execute(
    db,
    `UPDATE continuation_analysis_batches SET state = 'cancelled', updated_at = ?
      WHERE run_id = ? AND state IN ('queued', 'running', 'partial', 'failed')`,
    [now(), runId],
  );
  // 2) Then abort in-flight network / queue work
  analysisControllers.get(runId)?.abort();
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
  // partial parents stay partial; their queued children remain executable.
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
