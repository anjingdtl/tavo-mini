import { estimateTokens } from '../../utils/tokenEstimator';
import { resolveModelOutputCapability } from '../llm/providerCapabilities';

/**
 * V2.11.38 repair plan P1 §6.3 — Story Memory checkpoint budget planner.
 *
 * The legacy `checkpointMaxTokens(memoryPatchMaxTokens, batchSize)` only
 * derived 2400..16000 from the memory patch tokens and batch size; it never
 * consulted the ACTIVE model's `context_window` / `max_output_tokens`. A
 * request that cannot fit the model window was sent anyway and truncated or
 * rejected — and the empty response was then blamed on the model.
 *
 * Safe output budget:
 *
 *   safeOutputMax = min(configured max_output_tokens,
 *                       context_window - estimatedInputTokens - protocolSafety)
 *
 * When `safeOutputMax` is below the minimal JSON budget, the caller MUST NOT
 * send a request that is doomed to fail — it shrinks the batch first, and
 * only fails with an actionable model-capability hint when a single chapter
 * still cannot fit.
 */

/** Minimum JSON budget required by the checkpoint protocol, not a capability. */
export const MIN_CHECKPOINT_OUTPUT_TOKENS = 2400;
/** Fixed protocol / prompt overhead + safety margin reserved for input. */
const PROTOCOL_SAFETY_TOKENS = 256;

export interface CheckpointBudgetInput {
  memoryPatchMaxTokens: number;
  batchSize: number;
  /** Active model context window; 0 = unknown (no clamp). */
  contextWindow?: number;
  /** Active model max output tokens; 0 = unknown (no clamp). */
  maxOutputTokens?: number;
  /** Estimated input tokens for this request; 0 = unknown. */
  estimatedInputTokens?: number;
}

/**
 * The most output tokens the active model can physically accept for this
 * request. `0` means the model window cannot even fit protocol + input —
 * callers must shrink the batch or fail with an actionable hint.
 */
export function safeOutputMaxForModel(
  input: CheckpointBudgetInput,
): number {
  void input.memoryPatchMaxTokens;
  const capability = resolveModelOutputCapability({
    contextWindow: input.contextWindow,
    configuredMaxOutputTokens: input.maxOutputTokens,
  }).maxOutputTokens;
  let cap = capability ?? 0;
  if (input.contextWindow != null && input.contextWindow > 0) {
    const inputTokens =
      input.estimatedInputTokens != null && input.estimatedInputTokens > 0
        ? Math.floor(input.estimatedInputTokens)
        : 0;
    const headroom = Math.max(
      0,
      Math.floor(input.contextWindow) - inputTokens - PROTOCOL_SAFETY_TOKENS,
    );
    cap = Math.min(cap, headroom);
  }
  return Math.max(0, cap);
}

/**
 * Model-capability-aware checkpoint output budget.
 * Keeps the legacy demand shape (base × √batch, with the protocol minimum)
 * and then clamps by what the active model can actually accept. The model
 * capability is always required; there is no product-sized output fallback.
 *
 * Returns 0 when the model window cannot fit even the protocol + input —
 * the caller must fail with an actionable hint. A small but positive value
 * (below MIN_CHECKPOINT_OUTPUT_TOKENS) is returned as-is: sending with the
 * model's hard cap is still better than a doomed oversized request, and the
 * length-truncation recovery path shrinks the batch afterwards.
 */
export function checkpointMaxTokens(input: CheckpointBudgetInput): number {
  const base = Number.isFinite(input.memoryPatchMaxTokens)
    ? Math.max(1, Math.floor(input.memoryPatchMaxTokens))
    : 0;
  if (base <= 0) return 0;
  const scaled =
    base * Math.max(1, Math.sqrt(Math.max(1, Math.floor(input.batchSize) || 1)));
  const bounded = Math.max(MIN_CHECKPOINT_OUTPUT_TOKENS, Math.round(scaled));
  const cap = safeOutputMaxForModel(input);
  if (cap <= 0) return 0;
  return Math.min(bounded, cap);
}

export interface BatchShrinkDecision {
  /** True when the request would be doomed even for a single chapter. */
  infeasible: boolean;
  hint: string;
}

/**
 * Feasibility check used when the budget planner returns 0 (the model window
 * cannot fit protocol + input at all). Only this case is truly infeasible —
 * a positive-but-small budget still sends within the model's hard cap and
 * relies on the length-truncation recovery path to shrink the batch.
 */
export function decideCheckpointBatchSize(input: {
  safeOutputMax: number;
  estimatedInputTokens: number;
}): BatchShrinkDecision {
  if (input.safeOutputMax > 0) {
    return { infeasible: false, hint: '' };
  }
  return {
    infeasible: true,
    hint:
      '当前模型的 context_window 无法容纳本次检查点请求（含约 ' +
      `${Math.max(0, input.estimatedInputTokens)} 词元输入）。` +
      '请提高 context_window / max_output_tokens，或减少单章篇幅后重试。',
  };
}

export function estimateCheckpointInputTokens(
  messages: Array<{ role: string; content: string }>,
): number {
  return messages.reduce(
    (sum, message) => sum + estimateTokens(message.content || ''),
    0,
  );
}

/**
 * Next retry budget. The first argument carries the current budget; the
 * optional `maxOutputTokens` preserves the legacy two-arg contract. The
 * optional third argument carries the ACTIVE model capabilities so EVERY
 * expansion is clamped by the same `safeOutputMaxForModel` hard cap
 * (context_window - estimatedInputTokens - protocol safety) — a retry must
 * never exceed the model window that the first attempt already fit into.
 *
 * Returns 0 when the window cannot fit even protocol + input, i.e. the budget
 * cannot grow any further — callers must split the batch or fail with an
 * actionable model-capability hint.
 */
export function nextCheckpointBudget(
  current: number,
  maxOutputTokens?: number,
  model?: { contextWindow?: number; estimatedInputTokens?: number },
): number {
  const doubled = Math.max(1, Math.round(current)) * 2;
  const cap = safeOutputMaxForModel({
    memoryPatchMaxTokens: 1,
    batchSize: 1,
    contextWindow: model?.contextWindow,
    maxOutputTokens,
    estimatedInputTokens: model?.estimatedInputTokens,
  });
  return Math.max(
    0,
    Math.min(cap, Math.max(MIN_CHECKPOINT_OUTPUT_TOKENS, Math.round(doubled))),
  );
}
