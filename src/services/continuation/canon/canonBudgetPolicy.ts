/**
 * Canon analysis budget & chunking policy (original-analysis quality spec
 * 2026-08-03, §2–§6).
 *
 * This module centralises the strict separation between the model's *real*
 * capabilities (declared context window, declared max output, thinking mode)
 * and the single quantity that this app is allowed to tune: how much original
 * source text goes into one analysis batch.
 *
 * Hard rules enforced here:
 *   - `declaredContextWindow` and the logical
 *     `configuredMaxOutputTokens` come straight from the user's LLM config and
 *     are never written back. The selected Provider capability adapter may
 *     translate the logical output to a smaller wire value when the gateway
 *     contract requires it.
 *   - 30% (`SOURCE_CHUNK_RATIO_NORMAL`) controls ONLY the source-chunk size,
 *     never the request context ceiling, never the max output, never thinking.
 *   - No Canon-specific output ceiling is applied. A Provider capability
 *     adapter is the only place allowed to translate a provider wire limit;
 *     Canon never invents a second cap.
 *   - Thinking mode is preserved (we never emit `thinking: { type: 'disabled' }`).
 *   - The only place the source chunk shrinks is the per-batch retry ladder on
 *     recoverable output failures (length / reasoning-only / truncated JSON /
 *     route-owned categories all empty). Shrinking the chunk never touches the
 *     model's logical output or thinking budget.
 *
 * Protocol compatibility: some providers require `input + max_output <=
 * context_window`. When that constraint binds, we shrink the SOURCE CHUNK to
 * fit (never the output). If the configuration itself leaves no input room we
 * report a configuration incompatibility rather than silently crippling the
 * model.
 */
import {
  normalizePositiveCapability,
  resolveModelOutputCapability,
  resolveProviderOutputBudget,
  type ProviderCapabilityConfig,
} from '../../llm/providerCapabilities';

/**
 * Normal (non-retry) source-chunk target as a fraction of the declared context
 * window. Spec §6.1: `sourceChunkTargetTokens = floor(C * 0.30)`.
 */
export const SOURCE_CHUNK_RATIO_NORMAL = 0.3;

/**
 * 2026-08-04 修复（问题4）：定向补扫的 source-chunk 目标比例 = context_window
 * 的 15%。比正常 30% 更小，让补扫聚焦于缺失维度的精读，同时保留完整
 * max_output_tokens 与 thinking。只缩正文，不缩模型能力。
 */
export const SOURCE_CHUNK_RATIO_RESCAN = 0.15;

/**
 * Retry ladder for recoverable output failures (Spec §6.5). Each step shrinks
 * ONLY the source chunk for the failing batch; the model's max output and
 * thinking mode stay at their configured values.
 */
export const RETRY_CHUNK_RATIOS = [0.3, 0.2, 0.12] as const;

/**
 * Maximum number of source-chunk shrink retries per work item. Equals the
 * length of {@link RETRY_CHUNK_RATIOS}.
 */
export const MAX_SOURCE_CHUNK_RETRIES = RETRY_CHUNK_RATIOS.length;

/**
 * Defensive floor for the derived input budget. Only used to refuse a clearly
 * unusable configuration (e.g. max_output_tokens >= context_window). This is
 * NOT a hardcoded context-window threshold and does not cap the model.
 */
export const MIN_SOURCE_CHUNK_TOKENS = 1024;

/**
 * Minimum chunk char size when a single chapter must be split into pieces.
 * Smaller chunks are not worth analysing.
 */
export const MIN_CHUNK_CHAR_SIZE = 512;

export interface CanonBudgetInput {
  profile: 'quick' | 'standard' | 'deep';
  /** Real declared context window from LLM config (`null` = unknown). */
  declaredContextWindow: number | null | undefined;
  /** Real configured max output tokens from LLM config (`null` = unknown). */
  configuredMaxOutputTokens: number | null | undefined;
  /** Optional provider identity for the shared logical → wire adapter. */
  providerConfig?: ProviderCapabilityConfig;
  /** Estimated prompt skeleton overhead in tokens (instructions + schema). */
  promptOverhead: number;
  /**
   * Current chunk ratio from the retry ladder (0.30 normal, 0.20 / 0.12 on
   * recoverable output failures). Defaults to the normal ratio.
   */
  chunkRatio?: number;
}

export interface CanonBudgetPlan {
  /** User-declared logical output capability before provider translation. */
  declaredMaxOutputTokens: number;
  /** Real declared context window; zero means the capability is unavailable. */
  declaredContextWindow: number;
  /** Provider-valid output reserve derived from the model capability. */
  configuredMaxOutputTokens: number;
  /** Target source-chunk token size for this attempt. */
  sourceChunkTargetTokens: number;
  /** Estimated prompt skeleton overhead. */
  promptOverhead: number;
  /** Chunk ratio used for this attempt (from the retry ladder). */
  chunkRatio: number;
  /** True when input + output fits the declared window (protocol compat). */
  ok: boolean;
  /** Why the configuration is incompatible, when ok=false. */
  reason?: string;
  /** Suggested context_window for UI hints when ok=false. */
  suggestedContextWindow?: number;
  /** Suggested max_output_tokens for UI hints when ok=false. */
  suggestedMaxOutputTokens?: number;
}

/**
 * Resolve a fully-derived budget plan that keeps the model's capabilities
 * intact and only tunes the source chunk size.
 *
 * The source chunk target is `floor(declaredContextWindow * chunkRatio)`. When
 * a provider's `input + max_output <= context_window` protocol constraint
 * binds, the chunk is shrunk to fit (never the output). If even a zero-size
 * chunk cannot satisfy the constraint, the configuration is reported as
 * incompatible.
 */
export function resolveCanonBudget(
  input: CanonBudgetInput,
): CanonBudgetPlan {
  const declaredContextWindow =
    normalizePositiveCapability(input.declaredContextWindow) ?? 0;
  const logicalOutput = resolveModelOutputCapability({
    contextWindow: declaredContextWindow,
    configuredMaxOutputTokens: input.configuredMaxOutputTokens,
  }).maxOutputTokens;
  const declaredMaxOutputTokens = logicalOutput ?? 0;
  const configuredMaxOutputTokens =
    declaredMaxOutputTokens > 0 && input.providerConfig
      ? resolveProviderOutputBudget({
          config: {
            ...input.providerConfig,
            context_window: declaredContextWindow,
            max_output_tokens: declaredMaxOutputTokens,
          },
          requestedMaxTokens: declaredMaxOutputTokens,
        }).wireMaxTokens
      : declaredMaxOutputTokens;
  const chunkRatio = input.chunkRatio ?? SOURCE_CHUNK_RATIO_NORMAL;
  const promptOverhead = input.promptOverhead;

  if (declaredContextWindow <= 0 || declaredMaxOutputTokens <= 0) {
    return {
      declaredContextWindow,
      declaredMaxOutputTokens,
      configuredMaxOutputTokens,
      sourceChunkTargetTokens: 0,
      promptOverhead,
      chunkRatio,
      ok: false,
      reason:
        'Canon 分析需要模型文档声明的 context_window；max_output_tokens 留空时会按该窗口的 20% 弹性派生，无法使用固定默认值。',
    };
  }

  const rawSourceChunkTarget = Math.floor(
    declaredContextWindow * chunkRatio,
  );
  // Protocol compatibility: some providers enforce input + max_output <= window.
  // Shrink the SOURCE CHUNK to fit. The logical configured value is not
  // rewritten; only a provider adapter may have translated it above.
  const protocolInputLimit = Math.max(
    0,
    declaredContextWindow - configuredMaxOutputTokens - promptOverhead,
  );
  const sourceChunkTargetTokens = Math.min(
    rawSourceChunkTarget,
    protocolInputLimit,
  );

  if (sourceChunkTargetTokens <= MIN_SOURCE_CHUNK_TOKENS) {
    const suggestedMaxOutputTokens = Math.max(
      1024,
      Math.floor(declaredContextWindow * 0.5),
    );
    const suggestedContextWindow = Math.max(
      declaredContextWindow,
      configuredMaxOutputTokens +
        promptOverhead +
        Math.max(rawSourceChunkTarget, MIN_SOURCE_CHUNK_TOKENS) +
        1024,
    );
    return {
      declaredContextWindow,
      declaredMaxOutputTokens,
      configuredMaxOutputTokens,
      sourceChunkTargetTokens,
      promptOverhead,
      chunkRatio,
      ok: false,
      reason:
        `当前 LLM 配置的 context_window=${declaredContextWindow}、` +
        `max_output_tokens=${configuredMaxOutputTokens}，扣除输出与 prompt 骨架后` +
        ` 剩余输入预算仅 ${sourceChunkTargetTokens} tokens` +
        `（低于最低 ${MIN_SOURCE_CHUNK_TOKENS}）。` +
        `请在「设置 → LLM 配置」降低 max_output_tokens 至 ≤ ${suggestedMaxOutputTokens}，` +
        `或增大 context_window 至 ≥ ${suggestedContextWindow}。`,
      suggestedContextWindow,
      suggestedMaxOutputTokens,
    };
  }

  return {
    declaredContextWindow,
    declaredMaxOutputTokens,
    configuredMaxOutputTokens,
    sourceChunkTargetTokens,
    promptOverhead,
    chunkRatio,
    ok: true,
  };
}

/**
 * Resolve the extraction request through the same Provider capability adapter
 * used by the transport. Canon itself never applies an output-side ceiling;
 * the adapter only prevents a provider-invalid wire value.
 */
export function resolveCanonRequestMaxTokens(input: {
  profile: 'quick' | 'standard' | 'deep';
  configuredMaxOutputTokens: number | null | undefined;
  contextWindow?: number | null;
  providerConfig?: ProviderCapabilityConfig;
}): number {
  void input.profile;
  const configured = resolveModelOutputCapability({
    contextWindow: input.contextWindow ?? input.providerConfig?.context_window,
    configuredMaxOutputTokens: input.configuredMaxOutputTokens,
  }).maxOutputTokens;
  if (configured == null) {
    throw new Error(
      'Canon 请求缺少有效的 context_window / max_output_tokens，已拒绝使用固定输出默认值。',
    );
  }
  if (!input.providerConfig) return configured;
  return resolveProviderOutputBudget({
    config: {
      ...input.providerConfig,
      max_output_tokens: configured,
    },
    requestedMaxTokens: configured,
  }).wireMaxTokens;
}
