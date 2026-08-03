/**
 * Adaptive batch planner for Canon analysis (original-analysis quality spec
 * 2026-08-03, §6).
 *
 * The planner packs original-text chapters into batches sized at 30% of the
 * declared context window (`sourceChunkTargetTokens`). The model's real
 * capabilities — `context_window`, `max_output_tokens`, thinking mode — are
 * NEVER compressed or written back. See `canonBudgetPolicy.ts` for the policy.
 *
 * Rules:
 *   - `sourceChunkTargetTokens = floor(declaredContextWindow * 0.30)`.
 *   - 30% controls ONLY the source chunk size per batch, not the request
 *     context ceiling, not max output, not thinking.
 *   - The full configured `max_output_tokens` is sent on every request.
 *   - Protocol compatibility (`input + output <= window`) shrinks the chunk,
 *     never the output.
 *   - Single chapters larger than the target are split into chunk batches;
 *     no chapter is ever skipped (complete coverage).
 *   - On recoverable output failures (length / reasoning-only / truncated
 *     JSON / route-owned categories all empty) the retry ladder shrinks the
 *     chunk to 20% then 12%, never the output. Retry happens at the extractor.
 */
import type { BoundedSourceChapter } from '../types';
import type { AnalysisProfile, AnalysisWorkItemType } from './types';
import { estimateTokens } from '../../../utils/tokenEstimator';
import {
  EXTRACTION_FIELD_SPEC,
  EVIDENCE_FIELD_SPEC,
  EXTRACTION_JSON_SKELETON,
} from './extractionPromptSpec';
import {
  resolveCanonBudget,
  SOURCE_CHUNK_RATIO_NORMAL,
  DEFAULT_OUTPUT_BASELINE_BY_PROFILE,
  MIN_SOURCE_CHUNK_TOKENS,
  MIN_CHUNK_CHAR_SIZE,
} from './canonBudgetPolicy';

/**
 * Defensive lower bound. When `effectiveInputBudget` falls at or below this
 * value the planner refuses — anything smaller is not worth analysing. This is
 * NOT a hardcoded context window threshold; it only kicks in when the user's
 * configured `max_output_tokens` leaves almost no room for input.
 */
export const MIN_INPUT_BUDGET_TOKENS = MIN_SOURCE_CHUNK_TOKENS;

// Re-exported for backward compatibility with imports that referenced these
// from this module. They no longer cap the model's output; the planner itself
// never reduces max_output_tokens.
export const CANON_ANALYSIS_CONTEXT_UTILIZATION = 1;
export const CANON_REASONING_RETRY_OUTPUT_CEILING = Number.POSITIVE_INFINITY;

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
  const promptOverhead = estimatePromptOverhead({
    profile: input.profile,
    materialType: input.materialType,
  });
  const budget = resolveCanonBudget({
    profile: input.profile,
    declaredContextWindow: input.contextWindow,
    configuredMaxOutputTokens: input.maxOutputTokens,
    promptOverhead,
    chunkRatio: SOURCE_CHUNK_RATIO_NORMAL,
  });
  if (!budget.ok) {
    return {
      ok: false,
      batches: [],
      // The hard input budget (after protocol-compat shrink) is the chunk target.
      effectiveInputBudget: budget.sourceChunkTargetTokens,
      targetInputBudget: budget.sourceChunkTargetTokens,
      // The full configured max output is preserved; never compressed.
      outputReserve: budget.configuredMaxOutputTokens,
      retryOutputCeiling: budget.configuredMaxOutputTokens,
      promptOverhead: budget.promptOverhead,
      estimatedBatchCount: 0,
      reason: budget.reason,
      suggestedContextWindow: budget.suggestedContextWindow,
      suggestedMaxOutputTokens: budget.suggestedMaxOutputTokens,
    };
  }
  // 30% of the declared context window, further bounded by protocol compat.
  const targetInputBudget = budget.sourceChunkTargetTokens;
  const effectiveInputBudget = targetInputBudget;
  // The model's real configured max output — sent in full on every request.
  const outputReserve = budget.configuredMaxOutputTokens;

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
      // Reached the 30% fill target — close this batch and start a new one.
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
    // Full configured max output; never an internal ceiling. Kept on the plan
    // so persisted checkpoints (which store this value) keep working, and the
    // extractor sends exactly this value as max_tokens.
    outputReserve,
    retryOutputCeiling: outputReserve,
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
 * Estimate the `max_tokens` to send to the LLM for a single extraction call.
 *
 * Per the original-analysis quality spec (§6.2 / §7.1) the model's real
 * `max_output_tokens` is sent in FULL on every request. There is no
 * Canon-specific output ceiling, no 4× input scaling, no 25% share. The
 * fallback per-profile baseline is used ONLY when the config does not declare
 * a value. The `outputReserve` argument (the planner's stored value) is kept
 * for signature compatibility but is honoured only when it equals the
 * configured output — it never compresses a configured value.
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
  const configured =
    input.maxOutputTokens && input.maxOutputTokens > 0
      ? input.maxOutputTokens
      : profileBaseline;
  // Honour the planner's stored outputReserve when it carries the configured
  // value (new runs). It is the full configured max_output_tokens and is
  // returned as-is; never compressed.
  if (input.outputReserve && input.outputReserve > 0) {
    return Math.max(configured, input.outputReserve);
  }
  return configured;
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
