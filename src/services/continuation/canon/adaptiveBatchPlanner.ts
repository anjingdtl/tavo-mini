/**
 * Adaptive batch planner for Canon analysis (Spec §1 / 2026-08-01 fix).
 *
 * Replaces the legacy `planAnalysisTokenBudget` which hardcoded
 * `CANON_OUTPUT_BASELINE_TOKENS = { deep: 32768 }` and refused when the
 * model's context window could not reserve that much output. That made
 * many reasonable LLM configurations (e.g. context_window=8K, max_output_tokens=4K)
 * fail outright even for small source books.
 *
 * The new planner is **fully derived from the user's LLM configuration**:
 *   - `effectiveInputBudget = context_window - max_output_tokens - promptOverhead`
 *   - original text is greedily packed to a context-aware operational target
 *   - single chapters larger than the budget are split into chunk batches
 *   - no chapter is ever skipped (the user requires complete Canon coverage)
 *
 * Chapter boundaries are preserved for evidence provenance, but never impose a
 * second batch-size ceiling: an advertised 1M context must be used according to
 * the source's actual token volume, not its chapter formatting. The only
 * defensive lower bound (`MIN_INPUT_BUDGET_TOKENS`) prevents infinite loops when
 * the configured `max_output_tokens` exceeds `context_window`.
 */
import type { BoundedSourceChapter } from '../types';
import type { AnalysisProfile, AnalysisWorkItemType } from './types';
import { estimateTokens } from '../../../utils/tokenEstimator';
import {
  EXTRACTION_FIELD_SPEC,
  EVIDENCE_FIELD_SPEC,
  EXTRACTION_JSON_SKELETON,
} from './extractionPromptSpec';

/**
 * Defensive lower bound. When `effectiveInputBudget` falls at or below this
 * value the planner refuses — anything smaller is not worth analysing. This is
 * NOT a hardcoded context window threshold; it only kicks in when the user's
 * configured `max_output_tokens` leaves almost no room for input.
 */
export const MIN_INPUT_BUDGET_TOKENS = 1024;

/**
 * Fill ratio for normal contexts. This is intentionally separate from the
 * hard `CANON_ANALYSIS_CONTEXT_UTILIZATION` safety ceiling: it controls tail
 * latency, not request validity.
 */
const NORMAL_CONTEXT_BATCH_FILL_RATIO = 0.8;

/**
 * Very large advertised contexts can accept a request but still have a steep
 * KV-cache latency curve. A live 1M-context acceptance run showed this long
 * tail clearly. Keep a second operational margin there while preserving the
 * 80% hard safety ceiling and parallel Canon lanes.
 */
export const LARGE_CONTEXT_BATCH_FILL_RATIO = 0.6;
export const LARGE_CONTEXT_WINDOW_THRESHOLD = 512_000;

export function resolveCanonBatchFillRatio(declaredWindow: number): number {
  return declaredWindow >= LARGE_CONTEXT_WINDOW_THRESHOLD
    ? LARGE_CONTEXT_BATCH_FILL_RATIO
    : NORMAL_CONTEXT_BATCH_FILL_RATIO;
}

/**
 * Minimum chunk char size. When a chapter must be split into chunks, each chunk
 * is at least this many characters. Anything smaller would generate excessive
 * LLM calls for marginal benefit.
 */
const MIN_CHUNK_CHAR_SIZE = 512;

/**
 * Fallback output baseline per profile, used only when the LLM config does not
 * declare `max_output_tokens`. Mirrors the historical defaults so behaviour is
 * preserved when the user has not customised the output token setting.
 */
const DEFAULT_OUTPUT_BASELINE_BY_PROFILE: Record<AnalysisProfile, number> = {
  quick: 4096,
  standard: 8192,
  deep: 8192,
};

/**
 * Fallback context window when the LLM config does not declare one. Derived
 * from the configured output baseline (8x) so the input budget remains usable.
 * This is NOT a hardcoded threshold — it scales with the user's `max_output_tokens`.
 */
const DEFAULT_CONTEXT_WINDOW_MULTIPLIER = 8;
const DEFAULT_CONTEXT_WINDOW_FLOOR = 32_768;

/**
 * A configured context window is an upper protocol limit, not a safe request
 * size. Sending an almost-full 128K/1M request makes many OpenAI-compatible
 * backends allocate an enormous KV cache, which turns a long original into an
 * avoidable server OOM or a request timeout. Reserve 20% headroom and derive
 * the batch size from the remaining safe budget; complete coverage is
 * preserved by creating more resumable batches.
 */
export const CANON_ANALYSIS_CONTEXT_UTILIZATION = 0.8;
const CANON_ANALYSIS_MAX_OUTPUT_SHARE = 0.25;
/**
 * Reasoning-capable models occasionally spend their configured completion
 * budget before emitting the JSON body. This retry-only ceiling is deliberately
 * modest: it gives the model 8K → 16K → 32K recovery room without turning a
 * normal extraction into a huge 200K-output request.
 */
export const CANON_REASONING_RETRY_OUTPUT_CEILING = 65_536;

/** Material-type prompt prefixes used by the extractor. */
const MATERIAL_PROMPTS: Record<AnalysisWorkItemType, string> = {
  character_state:
    '请提取人物画像、人物状态、人物经历、人物知识与人物关系（包括别名与状态快照）。',
  world_plot:
    '请提取世界观规则、主线剧情与时间线事件（覆盖世界约束、剧情线索与时间点）。',
  // Legacy single-call groups retained for backward compatibility with v3 runs.
  world_rules: '请提取世界观规则。',
  characters: '请提取人物画像与别名。',
  relationships: '请提取人物关系。',
  plot_threads: '请提取主线剧情。',
  experiences: '请提取人物经历。',
  full_extraction: '请提取所有八类 Canon 资料。',
};

/** A single batch in the adaptive plan. */
export type AdaptiveBatch =
  | { type: 'normal'; chapters: BoundedSourceChapter[] }
  | {
      type: 'chunk';
      chapter: BoundedSourceChapter;
      chunkIndex: number;
      chunkCount: number;
      chunkStartChar: number;
      chunkEndChar: number;
    };

/** Result of the adaptive batch planner. */
export interface AdaptiveBatchPlan {
  ok: boolean;
  batches: AdaptiveBatch[];
  /** Per-batch input token budget derived from the LLM config. */
  effectiveInputBudget: number;
  /** Operational input target used for packing/chunking, never above the hard budget. */
  targetInputBudget: number;
  /** Output token reserve (== configured max_output_tokens). */
  outputReserve: number;
  /** Retry-only completion ceiling for reasoning-only/length responses. */
  retryOutputCeiling: number;
  /** Estimated prompt skeleton overhead in tokens. */
  promptOverhead: number;
  /** Total batch count (normal + chunk). */
  estimatedBatchCount: number;
  /** Reason when ok=false. */
  reason?: string;
  /** Suggested context_window for UI hints when ok=false. */
  suggestedContextWindow?: number;
  /** Suggested max_output_tokens for UI hints when ok=false. */
  suggestedMaxOutputTokens?: number;
}

/** Input for {@link planAdaptiveBatching}. */
export interface AdaptiveBatchPlanInput {
  chapters: BoundedSourceChapter[];
  profile: AnalysisProfile;
  providerType?: string | null;
  contextWindow: number | null | undefined;
  maxOutputTokens: number | null | undefined;
  /** Representative material type used to estimate prompt overhead. */
  materialType?: AnalysisWorkItemType;
}

/**
 * Estimate the prompt skeleton token overhead by constructing an empty user
 * message (no chapter content) and counting tokens. This is dynamic, not a
 * hardcoded 600 — different profiles / material types produce different
 * overheads.
 */
export function estimatePromptOverhead(input: {
  profile: AnalysisProfile;
  materialType?: AnalysisWorkItemType;
}): number {
  const materialType = input.materialType ?? 'character_state';
  const promptPrefix = [
    '你是严谨的原著 Canon 分析器。只允许根据下面给出的章节正文提取事实，禁止利用外部知识或补写。',
    '必须只返回一个完整、可 JSON.parse 的 JSON 对象，不要 Markdown、思考过程、解释或任何前后缀。schemaVersion 必须为 1，八个数组字段都必须出现，不能返回 null 或空白。',
    `分析档位：${input.profile}。${MATERIAL_PROMPTS[materialType] ?? ''}`,
    '每一个数组条目都必须至少有一条 evidence。evidence 必须引用本批章节中连续、逐字一致的原文片段作为 quotePreview（不超过 160 字）。',
    '每章 metadata 给出 bodyStart 和 bodyEnd：charStart/charEnd 是全书 UTF-16 绝对偏移；请使用 quotePreview 在该章正文中定位后填写，不能猜测。',
    EXTRACTION_FIELD_SPEC,
    EVIDENCE_FIELD_SPEC,
    EXTRACTION_JSON_SKELETON,
    '章节正文：',
  ].join('\n');
  return estimateTokens(promptPrefix) + 8; // +8 for role + message wrapper
}

/**
 * Estimate tokens for a single chapter using actual content. Uses the existing
 * `estimateTokens` estimator rather than a length-based heuristic so the
 * planner reflects real token counts for mixed CJK / ASCII text.
 *
 * For very long chapters (e.g. 100K chars), this is more expensive than the
 * length-based heuristic but the planner only runs once per analysis start.
 */
export function estimateChapterTokens(chapter: BoundedSourceChapter): number {
  const titleTokens = estimateTokens(chapter.title);
  const headerTokens = estimateTokens(
    `### (chapterId=${chapter.id}, position=${chapter.position}, bodyStart=${chapter.range.start}, bodyEnd=${chapter.range.end})\n`,
  );
  const contentTokens = estimateTokens(chapter.content);
  return titleTokens + headerTokens + contentTokens;
}

/**
 * Estimate tokens-per-char for a chapter by sampling its first 1KB. Returns a
 * weighted average of the CJK ratio (1.0 token/char) and ASCII ratio (0.25
 * token/char) so chunk sizes adapt to the actual language mix.
 */
export function estimateTokensPerCharForChapter(
  chapter: BoundedSourceChapter,
): number {
  const sample = chapter.content.slice(0, 1024);
  if (!sample) return 0.6; // defensive fallback
  let cjkCount = 0;
  let asciiCount = 0;
  for (const char of sample) {
    if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(char)) {
      cjkCount += 1;
    } else if (/[A-Za-z0-9_]/.test(char)) {
      asciiCount += 1;
    }
  }
  const totalSampled = cjkCount + asciiCount;
  if (totalSampled === 0) return 0.6;
  // CJK ≈ 1.0 token/char, ASCII word ≈ 0.25 token/char (4 chars per token)
  const cjkRatio = cjkCount / totalSampled;
  const asciiRatio = asciiCount / totalSampled;
  return cjkRatio * 1.0 + asciiRatio * 0.25;
}

/**
 * Plan adaptive batches for Canon analysis.
 *
 * The planner is **fully derived from the LLM configuration** and never
 * hardcodes a context-window threshold. See the module docstring for details.
 */
export function planAdaptiveBatching(
  input: AdaptiveBatchPlanInput,
): AdaptiveBatchPlan {
  const profileBaseline =
    DEFAULT_OUTPUT_BASELINE_BY_PROFILE[input.profile] ?? 8192;
  const configuredOutputTokens =
    input.maxOutputTokens && input.maxOutputTokens > 0
      ? input.maxOutputTokens
      : profileBaseline;
  const declaredWindow =
    input.contextWindow && input.contextWindow > 0
      ? input.contextWindow
      : Math.max(
          configuredOutputTokens * DEFAULT_CONTEXT_WINDOW_MULTIPLIER,
          DEFAULT_CONTEXT_WINDOW_FLOOR,
        );
  const safeRequestBudget = Math.floor(
    declaredWindow * CANON_ANALYSIS_CONTEXT_UTILIZATION,
  );
  // Keep no more than a quarter of the safe request budget for generation,
  // including thinking tokens. With a 1M-context model this permits a useful
  // 200K output reserve while still leaving ~600K for the original and a 20%
  // context-window margin.
  const outputReserve = Math.min(
    configuredOutputTokens,
    Math.floor(safeRequestBudget * CANON_ANALYSIS_MAX_OUTPUT_SHARE),
  );
  const promptOverhead = estimatePromptOverhead({
    profile: input.profile,
    materialType: input.materialType,
  });
  const unconstrainedInputBudget = Math.max(
    0,
    safeRequestBudget - outputReserve - promptOverhead,
  );
  const effectiveInputBudget = unconstrainedInputBudget;
  const targetInputBudget = Math.floor(
    effectiveInputBudget * resolveCanonBatchFillRatio(declaredWindow),
  );
  const retryOutputCeiling = Math.min(
    Math.floor(safeRequestBudget * CANON_ANALYSIS_MAX_OUTPUT_SHARE),
    Math.max(outputReserve, CANON_REASONING_RETRY_OUTPUT_CEILING),
  );

  // Refuse when the user's max_output_tokens leaves no room for input.
  if (effectiveInputBudget <= MIN_INPUT_BUDGET_TOKENS) {
    const suggestedMaxOutputTokens = Math.max(
      1024,
      Math.floor(declaredWindow * 0.25),
    );
    const suggestedContextWindow = Math.max(
      declaredWindow,
      outputReserve + promptOverhead + MIN_INPUT_BUDGET_TOKENS + 1024,
    );
    return {
      ok: false,
      batches: [],
      effectiveInputBudget,
      targetInputBudget,
      outputReserve,
      retryOutputCeiling,
      promptOverhead,
      estimatedBatchCount: 0,
      reason:
        `当前 LLM 配置的 context_window=${declaredWindow}、max_output_tokens=${outputReserve}，` +
        `扣除输出与 prompt 骨架后剩余输入预算仅 ${effectiveInputBudget} tokens` +
        `（低于最低 ${MIN_INPUT_BUDGET_TOKENS}）。` +
        `请在「设置 → LLM 配置」降低 max_output_tokens 至 ≤ ${suggestedMaxOutputTokens}，` +
        `或增大 context_window 至 ≥ ${suggestedContextWindow}。`,
      suggestedContextWindow,
      suggestedMaxOutputTokens,
    };
  }

  // Pre-compute per-chapter token estimates. For very long books (2000+ chapters)
  // this loop is the only O(n) work in the planner; we keep it synchronous
  // because callers already handle the chapter list load upfront.
  const chapterTokens: Array<{
    chapter: BoundedSourceChapter;
    tokens: number;
  }> = [];
  for (let i = 0; i < input.chapters.length; i++) {
    const chapter = input.chapters[i];
    chapterTokens.push({
      chapter,
      tokens: estimateChapterTokens(chapter),
    });
  }

  const batches: AdaptiveBatch[] = [];
  let currentBatch: BoundedSourceChapter[] = [];
  let currentTokens = 0;
  const fillTarget = targetInputBudget;

  for (const { chapter, tokens } of chapterTokens) {
    if (tokens > targetInputBudget) {
      // Flush the in-progress text batch first.
      if (currentBatch.length > 0) {
        flushNormalBatch(batches, currentBatch);
        currentBatch = [];
        currentTokens = 0;
      }
      // Split this oversized chapter into chunk batches.
      const tokensPerChar = estimateTokensPerCharForChapter(chapter);
      const chunkCharSize = Math.max(
        MIN_CHUNK_CHAR_SIZE,
        Math.floor(targetInputBudget / Math.max(tokensPerChar, 0.1)),
      );
      const totalChars = chapter.content.length;
      const chunkCount = Math.max(1, Math.ceil(totalChars / chunkCharSize));
      for (let i = 0; i < chunkCount; i++) {
        const chunkStartChar = i * chunkCharSize;
        const chunkEndChar = Math.min((i + 1) * chunkCharSize, totalChars);
        batches.push({
          type: 'chunk',
          chapter,
          chunkIndex: i,
          chunkCount,
          chunkStartChar,
          chunkEndChar,
        });
      }
    } else if (currentTokens + tokens > fillTarget) {
      // Reached the fill target — close this batch and start a new one.
      if (currentBatch.length > 0) {
        flushNormalBatch(batches, currentBatch);
      }
      currentBatch = [chapter];
      currentTokens = tokens;
    } else {
      currentBatch.push(chapter);
      currentTokens += tokens;
    }
  }
  if (currentBatch.length > 0) {
    flushNormalBatch(batches, currentBatch);
  }

  return {
    ok: true,
    batches,
    effectiveInputBudget,
    targetInputBudget,
    outputReserve,
    retryOutputCeiling,
    promptOverhead,
    estimatedBatchCount: batches.length,
  };
}

/** Helper: push one contiguous text-budgeted batch. */
function flushNormalBatch(
  batches: AdaptiveBatch[],
  chapters: BoundedSourceChapter[],
): void {
  batches.push({ type: 'normal', chapters: [...chapters] });
}

/**
 * Precheck result for UI confirmation dialogs. Returned by
 * {@link precheckCanonAnalysis} so the UI can show estimated batch count and
 * duration before the user commits to a long-running analysis.
 */
export interface CanonAnalysisPrecheck {
  ok: boolean;
  reason?: string;
  /** Current LLM config snapshot for display. */
  contextWindow: number;
  maxOutputTokens: number;
  /** Derived values. */
  effectiveInputBudget: number;
  /** Actual per-request packing target, below the hard safety budget. */
  targetInputBudget: number;
  estimatedBatchCount: number;
  estimatedWorkItemCount: number;
  estimatedDurationMinutes: number;
  /** Suggestions when ok=false. */
  suggestedContextWindow?: number;
  suggestedMaxOutputTokens?: number;
}

/**
 * Precheck an analysis without committing any state. Used by the UI to show a
 * confirmation dialog with the estimated batch count and duration.
 *
 * Assumes the caller has already loaded the bounded chapters. This keeps the
 * precheck pure (no DB access) so it can be called from the UI thread.
 */
export function precheckCanonAnalysis(input: {
  chapters: BoundedSourceChapter[];
  profile: AnalysisProfile;
  providerType?: string | null;
  contextWindow: number | null | undefined;
  maxOutputTokens: number | null | undefined;
}): CanonAnalysisPrecheck {
  const plan = planAdaptiveBatching({
    chapters: input.chapters,
    profile: input.profile,
    providerType: input.providerType,
    contextWindow: input.contextWindow,
    maxOutputTokens: input.maxOutputTokens,
    materialType: 'character_state',
  });
  // Each batch produces 2 work items (character_state + world_plot) per
  // the v3.1 `request_groups_v3_1_split` protocol.
  const estimatedWorkItemCount = plan.estimatedBatchCount * 2;
  // Conservative 30s per work item — covers JSON generation + retry budget.
  const estimatedDurationMinutes = Math.ceil(
    (estimatedWorkItemCount * 30) / 60,
  );
  if (!plan.ok) {
    return {
      ok: false,
      reason: plan.reason,
      contextWindow: input.contextWindow ?? 0,
      maxOutputTokens: input.maxOutputTokens ?? 0,
      effectiveInputBudget: plan.effectiveInputBudget,
      targetInputBudget: plan.targetInputBudget,
      estimatedBatchCount: 0,
      estimatedWorkItemCount: 0,
      estimatedDurationMinutes: 0,
      suggestedContextWindow: plan.suggestedContextWindow,
      suggestedMaxOutputTokens: plan.suggestedMaxOutputTokens,
    };
  }
  return {
    ok: true,
    contextWindow: input.contextWindow ?? 0,
    maxOutputTokens: input.maxOutputTokens ?? 0,
    effectiveInputBudget: plan.effectiveInputBudget,
    targetInputBudget: plan.targetInputBudget,
    estimatedBatchCount: plan.estimatedBatchCount,
    estimatedWorkItemCount,
    estimatedDurationMinutes,
  };
}

/**
 * Estimate the actual `max_tokens` to send to the LLM for a single extraction
 * call. Mirrors the planner's `outputReserve` so the request and the budget
 * check stay consistent.
 *
 * When `max_output_tokens` is configured we use it directly; otherwise we fall
 * back to the per-profile default. The retry path can scale this value up to
 * the model's hard cap (kept by the caller for backward compatibility).
 */
export function resolveExtractionMaxTokens(input: {
  profile: AnalysisProfile;
  maxOutputTokens: number | null | undefined;
  effectiveInputBudget: number;
  /** Adaptive plan's reserved completion budget, when analysing a new run. */
  outputReserve?: number;
}): number {
  const profileBaseline =
    DEFAULT_OUTPUT_BASELINE_BY_PROFILE[input.profile] ?? 8192;
  const configured = input.maxOutputTokens ?? profileBaseline;
  // Keep the actual request aligned with the planner's 80%-window reservation.
  // Retry may use the reserved completion headroom but cannot consume the
  // 20% context safety margin.
  const ceiling = Math.max(profileBaseline, input.effectiveInputBudget * 4);
  return Math.min(
    configured,
    ceiling,
    input.outputReserve ?? Number.POSITIVE_INFINITY,
  );
}

/**
 * Compute the per-chapter character slice limit derived from the input budget.
 * Replaces the hardcoded `CANON_ONLINE_CHAPTER_TEXT_LIMIT = 24000`.
 */
export function resolveChapterTextLimitFromBudget(
  effectiveInputBudget: number,
): number {
  // Conservative CJK ratio of 0.8 tokens/char (worst-case for dense CJK text).
  // The actual estimator uses ~0.6 but we add headroom to avoid overflow.
  const tokensPerChar = 0.8;
  const charBudget = Math.floor(effectiveInputBudget / tokensPerChar);
  // Lower floor of 1024 chars to ensure at least some content per chunk.
  return Math.max(1024, charBudget);
}
