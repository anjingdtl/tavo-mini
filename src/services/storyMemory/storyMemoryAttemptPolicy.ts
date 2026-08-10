import type { LLMResult } from '../llm';

/**
 * V2.11.38 repair plan P1 — unified empty-response classification for Story
 * Memory checkpoint / patch requests.
 *
 * The provider already distinguishes WHY `text` is empty
 * (`length` / `content_filter` / `reasoning_only` / `no_choices` / `empty`).
 * Story Memory callers previously collapsed every case into a generic
 * "模型没有返回补丁" error thrown BEFORE any repair / retry logic ran, so
 * the bounded recovery state machine never executed.
 *
 * This module decides the next physical request per the recovery matrix
 * (§6.2 of the repair plan):
 *
 * | first result    | next action                                            |
 * |-----------------|--------------------------------------------------------|
 * | reasoning_only  | fresh retry with thinking disabled + higher budget     |
 * | length          | higher budget (within model cap); shrink batch if cap  |
 * | empty           | one fresh retry (thinking may be disabled)             |
 * | no_choices      | fail with actionable gateway/provider diagnostic       |
 * | content_filter  | fail; provider refused output — never blind-retry     |
 */

export type StoryMemoryEmptyResponseAction =
  | {
      type: 'fresh_retry';
      /** Pass `thinking: { type: 'disabled' }` on the next request. */
      disableThinking: boolean;
      /**
       * Token budget for the next request. Already capped by the model's
       * `max_output_tokens` / context window when a budget planner is used.
       */
      budget: number;
      reason: string;
    }
  | {
      type: 'fail';
      /** True when a later retry (after user action) could still succeed. */
      retryable: boolean;
      code: string;
      reason: string;
      /**
       * Optional model capability suggestion shown to the user
       * (e.g. "context_window 或 max_output_tokens 过小").
       */
      userActionHint?: string;
      /**
       * True when this failure is a length/truncation dead end: the budget
       * cannot grow further. The coordinator converts this to a batch split
       * (MEMORY_CHECKPOINT_BATCH_TOO_LARGE) when the batch has more than one
       * chapter, or to an actionable model-capability error for a single
       * chapter. Pure policy — the coordinator owns the batch-size decision.
       */
      shrinkBatch?: boolean;
    };

export interface DecideEmptyResponseActionInput {
  emptyReason?: LLMResult['emptyReason'];
  finishReason?: string | null;
  /**
   * 1-based index of the request that just returned empty.
   * The coordinator must never exceed `maxAttempts` total physical requests.
   */
  attempt: number;
  maxAttempts: number;
  /** Token budget that was used for this attempt. */
  currentBudget: number;
  /** Next budget the coordinator would use (already clamped). */
  nextBudget: number;
}

export const STORY_MEMORY_MAX_PHYSICAL_REQUESTS = 3;

/** Only transport failures known to be safe can consume another budget slot. */
export function isSafeStoryMemoryRetryError(error: unknown): boolean {
  const value = error as {
    failureClass?: unknown;
    httpStatus?: unknown;
    status?: unknown;
    cause?: { status?: unknown };
    code?: unknown;
  } | null;
  if (!value) return false;
  if (value.failureClass === 'outcome_unknown') return false;
  if (
    value.failureClass === 'safe_retry' ||
    value.failureClass === 'rate_limit'
  ) {
    return true;
  }
  const status = Number(
    value.httpStatus || value.status || value.cause?.status || 0,
  );
  if (status === 429 || status >= 500) return true;
  return ['connect_timeout', 'safe_retry', 'rate_limit'].includes(
    String(value.code || '').toLowerCase(),
  );
}

/**
 * Decide the recovery action for an empty LLM response.
 * Pure function — unit-testable without any database or provider.
 */
export function decideEmptyResponseAction(
  input: DecideEmptyResponseActionInput,
): StoryMemoryEmptyResponseAction {
  const reason = input.emptyReason || 'empty';
  const isLastAttempt = input.attempt >= input.maxAttempts;

  switch (reason) {
    case 'reasoning_only':
      // Reasoning burned the output budget. Next request disables thinking
      // (keeps `responseFormat: json_object`) and may raise the budget.
      if (isLastAttempt) {
        return {
          type: 'fail',
          retryable: true,
          code: 'MEMORY_CHECKPOINT_EMPTY_RESPONSE',
          reason:
            '模型连续只返回思考内容而没有业务输出。请关闭模型思考模式，或更换支持直接 JSON 输出的模型后重试。',
        };
      }
      return {
        type: 'fresh_retry',
        disableThinking: true,
        budget: input.nextBudget,
        reason: '模型仅返回思考内容，已关闭思考模式并提高输出预算重试。',
      };
    case 'length':
      // Output was truncated. Raise budget; when the budget is already at
      // the model cap the coordinator shrinks the batch (shrinkBatch).
      if (isLastAttempt || input.nextBudget <= input.currentBudget) {
        return {
          type: 'fail',
          retryable: true,
          code: 'MEMORY_CHECKPOINT_EMPTY_RESPONSE',
          reason:
            '模型输出持续达到长度上限，且输出预算已到模型上限。请提高模型的 max_output_tokens 或 context_window 后重试。',
          userActionHint: 'context_window / max_output_tokens 过小',
          shrinkBatch: true,
        };
      }
      return {
        type: 'fresh_retry',
        disableThinking: false,
        budget: input.nextBudget,
        reason: '模型输出达到长度上限，已提高输出预算重试。',
      };
    case 'no_choices':
      return {
        type: 'fail',
        retryable: true,
        code: 'MEMORY_CHECKPOINT_EMPTY_RESPONSE',
        reason: '模型网关没有返回任何输出（no choices）。请检查模型服务状态或切换模型后重试。',
      };
    case 'content_filter':
      return {
        type: 'fail',
        retryable: false,
        code: 'MEMORY_CHECKPOINT_EMPTY_RESPONSE',
        reason: '模型内容审核拒绝了本次输出，未自动重试。请调整章节内容或提示词后重试。',
      };
    case 'empty':
    default:
      if (isLastAttempt) {
        return {
          type: 'fail',
          retryable: true,
          code: 'MEMORY_CHECKPOINT_EMPTY_RESPONSE',
          reason: '模型连续没有返回任何输出。请检查模型服务状态后重试。',
        };
      }
      return {
        type: 'fresh_retry',
        disableThinking: false,
        budget: input.nextBudget,
        reason: '模型没有返回输出，已重新发起请求。',
      };
  }
}
