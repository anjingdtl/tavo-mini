import * as db from '../database';
import {
  estimateMessagesTokens,
  estimateTokens,
} from '../../utils/tokenEstimator';
import type { LLMProvider } from '../../types/llmProvider';
import type {
  ChatMessage,
  LLMFailurePhase,
  LLMGenerateOptions,
  LLMOutputBudgetTrace,
  LLMRequestConfig,
  LLMRequestMetrics,
  LLMResult,
  LLMQueueClass,
} from './types';
import {
  scheduleLLMRequest,
  getLLMTaskQueueDefaults,
  LLMQueueError,
} from './requestScheduler';
import {
  createLLMTimeoutController,
  LLMRequestError,
  resolveLLMTimeoutPolicy,
  toLLMRequestError,
} from './requestPolicy';
import { assertAllowedLLMEndpoint } from './networkPolicy';
import {
  resolveProviderCapability,
  resolveProviderOutputBudget,
  resolveProviderReasoningEffort,
} from './providerCapabilities';

export function normalizeChatCompletionUrl(baseUrl: string): string {
  let url = baseUrl.trim();
  if (!url) return '';
  if (url.endsWith('/chat/completions')) return url;
  if (url.endsWith('/chat/completions/')) return url.slice(0, -1);
  url = url.replace(/\/+$/, '');
  if (/^https?:\/\/api\.deepseek\.com$/i.test(url))
    return `${url}/chat/completions`;
  // 识别任意版本号段（/v1、/v2、/v4 等）：智谱 BigModel 用 /v4，只追加 /chat/completions，
  // 不能强塞 /v1 否则会拼成 /v4/v1/chat/completions 触发 404
  if (/\/v\d+$/.test(url)) return `${url}/chat/completions`;
  return `${url}/v1/chat/completions`;
}

export function createLLMConfigError(): Error {
  return new Error('请先在设置中配置 API 地址、API Key 和模型名称。');
}

/**
 * Backward-compatible boolean facade over the explicit provider capability
 * registry. A model name or compatible gateway alone never grants support.
 */
export function supportsReasoningEffort(params: {
  providerType?: string | null;
  modelName?: string | null;
  baseUrl?: string | null;
}): boolean {
  return (
    resolveProviderCapability({
      provider_type: params.providerType as 'openai_compatible',
      model_name: String(params.modelName ?? ''),
      url: String(params.baseUrl ?? ''),
    }).supportsReasoningEffort === 'supported'
  );
}

function parseNonNegativeUsageNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/** Parse the official completion_tokens_details.reasoning_tokens field. */
export function parseReasoningTokens(usage: unknown): number | null {
  if (!usage || typeof usage !== 'object') return null;
  const details = (usage as { completion_tokens_details?: unknown })
    .completion_tokens_details;
  if (!details || typeof details !== 'object') return null;
  return parseNonNegativeUsageNumber(
    (details as { reasoning_tokens?: unknown }).reasoning_tokens,
  );
}

/**
 * Parse DeepSeek prompt-cache telemetry fields. Returns `{null, null}` when the
 * provider did not report them — never fabricates 0. Does not reject generation
 * when `hit + miss != prompt_tokens` (provider accounting varies), and never
 * changes `inputTokens` fallback or `reasoningTokens` parsing. Observation-only.
 */
export function parsePromptCacheUsage(usage: unknown): {
  hitTokens: number | null;
  missTokens: number | null;
} {
  if (!usage || typeof usage !== 'object') {
    return { hitTokens: null, missTokens: null };
  }
  const record = usage as {
    prompt_cache_hit_tokens?: unknown;
    prompt_cache_miss_tokens?: unknown;
  };
  return {
    hitTokens: parseNonNegativeUsageNumber(record.prompt_cache_hit_tokens),
    missTokens: parseNonNegativeUsageNumber(record.prompt_cache_miss_tokens),
  };
}

/**
 * Normalise `message.content` into a trimmed business-text string.
 *
 * OpenAI's canonical shape is a string; a handful of compatible gateways
 * instead return an array of typed parts (`[{type:'text',text:'...'}]`).
 * We join the text parts so the emptiness decision reflects the real
 * payload. Non-text parts (image_url etc.) are ignored. Returns `null`
 * when there is no usable text — same contract as before.
 */
export function extractContentText(rawContent: unknown): string | null {
  if (typeof rawContent === 'string') {
    return rawContent.trim().length > 0 ? rawContent : null;
  }
  if (Array.isArray(rawContent)) {
    const joined = rawContent
      .filter(
        (part): part is { type: string; text: string } =>
          !!part &&
          typeof part === 'object' &&
          (part as { type?: unknown }).type === 'text' &&
          typeof (part as { text?: unknown }).text === 'string',
      )
      .map(part => part.text)
      .join('');
    return joined.trim().length > 0 ? joined : null;
  }
  return null;
}

/**
 * Map an empty `text` to a categorical reason (Spec §1 / S1). Ordered so the
 * most actionable signals win: a content_filter or length finish_reason is
 * more informative than a generic "empty". `reasoning_only` means only that
 * business `content` is absent while `reasoning_content` exists; it must not
 * be treated as proof that chain-of-thought exhausted the output budget.
 * `finishReason=length` is the separate truncation signal.
 */
export function classifyEmptyResponse(input: {
  finishReason: string | null;
  hasReasoning: boolean;
  hasChoices: boolean;
}):
  | 'length'
  | 'content_filter'
  | 'reasoning_only'
  | 'no_choices'
  | 'empty'
  | undefined {
  if (input.finishReason === 'content_filter') return 'content_filter';
  if (input.finishReason === 'length') {
    return input.hasReasoning ? 'reasoning_only' : 'length';
  }
  if (input.hasReasoning) return 'reasoning_only';
  if (!input.hasChoices) return 'no_choices';
  return 'empty';
}

export function formatLLMError(
  status: number,
  responseText: string,
  headers?: Headers | null,
): Error & {
  code?: string;
  status?: number;
  retryAfterMs?: number;
  providerRequestId?: string;
  failurePhase?: 'provider' | 'http';
} {
  let code = `HTTP_${status}`;
  let message = responseText.slice(0, 300);

  try {
    const parsed = JSON.parse(responseText);
    const error = parsed?.error || parsed;
    code = String(error?.code || error?.type || code);
    message = String(error?.message || message);
  } catch {
    // Keep raw text for non-JSON providers.
  }

  // Phase 3: surface Retry-After and provider request id for durable attempts.
  let retryAfterMs: number | undefined;
  let providerRequestId: string | undefined;
  try {
    const retryAfter = headers?.get?.('retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) {
        retryAfterMs = Math.ceil(seconds * 1000);
      }
    }
    providerRequestId =
      headers?.get?.('x-request-id') ||
      headers?.get?.('request-id') ||
      headers?.get?.('x-amzn-requestid') ||
      undefined;
  } catch {
    // headers access is best-effort
  }

  const formatted = new Error(
    `API 请求失败 (${status}, ${code}): ${message}`,
  ) as Error & {
    code?: string;
    status?: number;
    retryAfterMs?: number;
    providerRequestId?: string;
    failurePhase?: 'provider' | 'http';
  };
  formatted.code = code;
  formatted.status = status;
  formatted.failurePhase = status === 200 ? 'provider' : 'http';
  if (retryAfterMs !== undefined) formatted.retryAfterMs = retryAfterMs;
  if (providerRequestId) formatted.providerRequestId = providerRequestId;
  return formatted;
}

export type LLMTask<T> = () => Promise<T>;

export function createConcurrencyLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  const runNext = () => {
    if (active >= limit) return;
    const next = queue.shift();
    if (!next) return;
    active++;
    next();
  };

  return function limitTask<T>(task: LLMTask<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      queue.push(() => {
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            runNext();
          });
      });
      runNext();
    });
  };
}

async function safeLogUsage(fields: {
  scenario: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  status: string;
  errorCode?: string;
  modelName?: string;
  projectId?: number;
  llmConfigId?: number;
  llmConfigName?: string;
  promptCacheHitTokens?: number | null;
  promptCacheMissTokens?: number | null;
}) {
  try {
    await db.logLLMUsage(fields);
  } catch {
    // Usage logging must never break generation.
  }
}

function resolveQueueClass(options: LLMGenerateOptions): LLMQueueClass {
  const taskDefaults = getLLMTaskQueueDefaults(options.taskId);
  if (taskDefaults?.queueClass) return taskDefaults.queueClass;
  if (options.queueClass) return options.queueClass;
  if (options.scenario?.startsWith('pipeline_')) return 'pipeline';
  return 'normal';
}

function resolveQueuePriority(options: LLMGenerateOptions) {
  return (
    getLLMTaskQueueDefaults(options.taskId)?.queuePriority ||
    options.queuePriority ||
    'normal'
  );
}

export const openAICompatibleProvider: LLMProvider = {
  type: 'openai_compatible',

  async test(
    config: LLMRequestConfig,
    externalSignal?: AbortSignal,
  ): Promise<string> {
    const url = normalizeChatCompletionUrl(config.url);
    if (!url || !config.api_key.trim() || !config.model_name.trim()) {
      throw createLLMConfigError();
    }
    assertAllowedLLMEndpoint(url, config.allow_insecure_lan_http === true);
    const timeoutController = createLLMTimeoutController({
      policy: resolveLLMTimeoutPolicy('connection_test', 'openai_compatible'),
      externalSignal,
      timeoutCode: 'connect_timeout',
    });
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.api_key.trim()}`,
        },
        body: JSON.stringify({
          model: config.model_name.trim(),
          messages: [{ role: 'user', content: '请回复“连接成功”。' }],
          temperature: 0,
          // Connection probes deliberately omit max_tokens. A probe must not
          // become another product-wide output default; the provider may use
          // its own minimal response behavior for this short fixed prompt.
          stream: false,
        }),
        signal: timeoutController.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw formatLLMError(response.status, text);
      }

      const data = await response.json();
      const replyText =
        data.choices?.[0]?.message?.content ||
        data.choices?.[0]?.message?.reasoning_content ||
        '连接成功';
      return replyText;
    } catch (error: any) {
      throw toLLMRequestError(
        error,
        timeoutController,
        '连接测试失败，请检查 API 地址和模型服务。',
      );
    } finally {
      timeoutController.dispose();
    }
  },

  async generate(
    messages: ChatMessage[],
    options: LLMGenerateOptions,
    externalSignal?: AbortSignal,
  ): Promise<LLMResult> {
    const config = options.requestConfig;
    if (!config) {
      throw new Error('缺少 LLM 请求配置');
    }
    if (!config.url || !config.api_key || !config.model_name) {
      throw createLLMConfigError();
    }
    assertAllowedLLMEndpoint(
      config.url,
      config.allow_insecure_lan_http === true,
    );

    const inputEstimate = estimateMessagesTokens(messages);
    const scenario = options.scenario || 'chat';
    const modelName = config.model_name;
    const projectId = options.projectId;
    const llmConfigId = config.id;
    const llmConfigName = config.name;
    // Request-boundary timestamps are observation only. They deliberately sit
    // outside the timeout controller so queue wait remains visible without
    // changing the existing watchdog semantics.
    const queuedAt = Date.now();

    try {
      const result = await scheduleLLMRequest(
        async queueSignal => {
          const dispatchStartedAt = Date.now();
          let requestSentAt: number | undefined;
          let responseReceivedAt: number | undefined;
          let parseCompletedAt: number | undefined;
          let providerRequestId: string | undefined;
          let outputBudgetTrace: LLMOutputBudgetTrace | undefined;
          const timeoutController = createLLMTimeoutController({
            policy: resolveLLMTimeoutPolicy(scenario, 'openai_compatible'),
            taskId: options.taskId,
            externalSignal: queueSignal,
            onProgress: options.onProgress,
          });
          try {
            // Defense-in-depth: per-call options.thinking is authoritative;
            // a thinking field attached to the requestConfig (a historical
            // misplacement) is honored as a fallback so the caller's intent
            // still reaches the wire instead of being silently dropped.
            const effectiveThinking = options.thinking ?? config.thinking;
            const providerCapability = resolveProviderCapability(config);
            const reasoningEffortWire = resolveProviderReasoningEffort({
              capability: providerCapability,
              thinking: effectiveThinking,
              requestedEffort: options.reasoningEffort,
            });
            const outputBudget = resolveProviderOutputBudget({
              config,
              requestedMaxTokens: options.max_tokens,
            });
            outputBudgetTrace = outputBudget.trace;
            const requestBody: Record<string, unknown> = {
              model: config.model_name,
              messages,
              temperature: options.temperature ?? 0.8,
              top_p: options.top_p ?? 0.9,
              max_tokens: outputBudget.wireMaxTokens,
              stream: false,
            };
            if (options.responseFormat === 'json_object') {
              requestBody.response_format = { type: 'json_object' };
            }
            if (effectiveThinking) {
              requestBody.thinking = effectiveThinking;
            }
            if (reasoningEffortWire) {
              requestBody.reasoning_effort = reasoningEffortWire;
            }
            const sendRequest = async (kind: string) => {
              await options.physicalRequestHooks?.beforeRequest?.({ kind });
              try {
                if (requestSentAt === undefined) requestSentAt = Date.now();
                const response = await fetch(config.url, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${config.api_key}`,
                  },
                  body: JSON.stringify(requestBody),
                  signal: timeoutController.signal,
                });
                responseReceivedAt = Date.now();
                const responseRequestId =
                  typeof response.headers?.get === 'function'
                    ? response.headers.get('x-request-id') ||
                      response.headers.get('request-id') ||
                      response.headers.get('x-amzn-requestid') ||
                      undefined
                    : undefined;
                if (responseRequestId) providerRequestId = responseRequestId;
                try {
                  await options.physicalRequestHooks?.afterRequest?.({
                    kind,
                    outcome: 'response',
                    httpStatus: response.status,
                    providerRequestId: responseRequestId,
                  });
                } catch {
                  // Durable accounting is intentionally fail-closed before a
                  // request, but an after-response bookkeeping failure must
                  // never replace the provider response or cause a duplicate
                  // request. A sent row remains recoverable as unknown.
                }
                return response;
              } catch (error) {
                try {
                  await options.physicalRequestHooks?.afterRequest?.({
                    kind,
                    outcome: 'transport_error',
                    error,
                  });
                } catch {
                  // Preserve the original transport error.
                }
                throw error;
              }
            };
            let response = await sendRequest('primary');

            // OpenAI-compatible gateways do not agree on optional protocol
            // extensions. Structured V3.1 calls request disabled Thinking, so
            // a gateway that rejects that extension can safely retry once with
            // the field omitted (omission is the portable non-thinking form).
            // Enabled Thinking is intentionally not silently downgraded: it
            // is a user-visible creative-quality choice and must fail closed
            // if the provider rejects its reasoning contract.
            for (let fallback = 0; !response.ok && fallback < 2; fallback++) {
              const text = await response.text();
              const responseFormatUnsupported =
                options.responseFormat === 'json_object' &&
                response.status === 400 &&
                /(response[_ ]?format|json[_ -]?object)/i.test(text) &&
                /(unsupported|unknown|not supported|invalid|unrecognized|unexpected)/i.test(
                  text,
                );
              const disabledThinkingUnsupported =
                effectiveThinking?.type === 'disabled' &&
                response.status === 400 &&
                /(thinking|reasoning(?:[_ ]?content|[_ ]?effort)?)/i.test(
                  text,
                ) &&
                /(unsupported|unknown|not supported|invalid|unrecognized|unexpected|additional|extra)/i.test(
                  text,
                );
              if (!responseFormatUnsupported && !disabledThinkingUnsupported) {
                parseCompletedAt = Date.now();
                throw formatLLMError(response.status, text, response.headers);
              }
              if (responseFormatUnsupported) delete requestBody.response_format;
              if (disabledThinkingUnsupported) {
                delete requestBody.thinking;
                delete requestBody.reasoning_effort;
              }
              response = await sendRequest('protocol_fallback');
            }
            if (!response.ok) {
              parseCompletedAt = Date.now();
              throw formatLLMError(
                response.status,
                await response.text(),
                response.headers,
              );
            }

            const data = await response.json();
            // Some OpenAI-compatible gateways answer HTTP 200 but place the
            // real error inside the body (`{"error":{...}}`, no `choices`).
            // Surfacing it here prevents Canon analysis from retrying an
            // unsupported-parameter failure three times and then reporting a
            // misleading "model does not support JSON" message.
            if (!Array.isArray(data.choices) || data.choices.length === 0) {
              if (data && typeof data === 'object' && 'error' in data) {
                parseCompletedAt = Date.now();
                throw formatLLMError(
                  200,
                  JSON.stringify(data.error),
                  response.headers,
                );
              }
            }
            const choice = data.choices?.[0];
            const message = choice?.message || {};
            // Strict separation: never fall back reasoning_content into business text.
            const rawContent = message.content;
            const rawReasoning = message.reasoning_content;
            // Some gateways serialise content as an array of typed parts
            // ([{type:'text',text:'...'}, ...]). Join the text parts so the
            // emptiness check below reflects the real payload.
            const text = extractContentText(rawContent);
            const reasoningText =
              typeof rawReasoning === 'string' && rawReasoning.trim().length > 0
                ? rawReasoning
                : null;
            const finishReason =
              typeof choice?.finish_reason === 'string'
                ? choice.finish_reason
                : null;
            const emptyReason = text
              ? undefined
              : classifyEmptyResponse({
                  finishReason,
                  hasReasoning: !!reasoningText,
                  hasChoices: !!choice,
                });
            const usage = data.usage || {};
            const inputUsage = parseNonNegativeUsageNumber(usage.prompt_tokens);
            const outputUsage = parseNonNegativeUsageNumber(
              usage.completion_tokens,
            );
            const totalUsage = parseNonNegativeUsageNumber(usage.total_tokens);
            const inputTokens = inputUsage ?? inputEstimate;
            const outputTokens =
              outputUsage ??
              estimateTokens(text || '') + estimateTokens(reasoningText || '');
            const totalTokens = totalUsage ?? inputTokens + outputTokens;
            const reasoningTokens = parseReasoningTokens(usage);
            const visibleOutputTokens =
              reasoningTokens == null
                ? null
                : Math.max(0, outputTokens - reasoningTokens);
            const promptCache = parsePromptCacheUsage(usage);
            timeoutController.markProgress('progress');
            parseCompletedAt = Date.now();
            const metrics = buildProviderRequestMetrics({
              base: timeoutController.metrics,
              queuedAt,
              dispatchStartedAt,
              requestSentAt,
              responseReceivedAt,
              parseCompletedAt,
            });
            const failurePhase: LLMFailurePhase | null =
              finishReason === 'length' || finishReason === 'content_filter'
                ? 'generation'
                : !text
                  ? 'parse'
                  : null;
            return {
              text,
              reasoningText,
              reasoningTokens,
              visibleOutputTokens,
              inputTokens,
              outputTokens,
              totalTokens,
              promptCacheHitTokens: promptCache.hitTokens,
              promptCacheMissTokens: promptCache.missTokens,
              providerRequestId: providerRequestId ?? null,
              finishReason,
              emptyReason,
              metrics,
              rawUsage: data.usage,
              outputBudget: outputBudget.trace,
              reasoningEffortWire,
              reasoningEffortSupport:
                providerCapability.supportsReasoningEffort,
              failurePhase,
            };
          } catch (error: any) {
            const parseFailed =
              responseReceivedAt !== undefined && parseCompletedAt === undefined;
            if (parseFailed) {
              parseCompletedAt = Date.now();
            }
            const failureMetrics = buildProviderRequestMetrics({
              base: timeoutController.metrics,
              queuedAt,
              dispatchStartedAt,
              requestSentAt,
              responseReceivedAt,
              parseCompletedAt,
            });
            const normalized = toLLMRequestError(
              error,
              timeoutController,
              'API 请求失败，请检查网络或服务商状态。',
              {
                metrics: failureMetrics,
                phaseHint: parseFailed ? 'parse' : undefined,
              },
            );
            Object.assign(normalized, {
              metrics: failureMetrics,
              outputBudget: outputBudgetTrace,
              providerRequestId:
                normalized.providerRequestId || providerRequestId || undefined,
            });
            throw normalized;
          } finally {
            timeoutController.dispose();
          }
        },
        {
          taskId: options.taskId,
          queueClass: resolveQueueClass(options),
          queuePriority: resolveQueuePriority(options),
          projectId,
          externalSignal,
          onQueueState: options.onQueueState,
        },
      );

      await safeLogUsage({
        scenario,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        totalTokens: result.totalTokens,
        status: 'success',
        modelName,
        projectId,
        llmConfigId,
        llmConfigName,
        // Provider-reported cache telemetry. When the provider did not report
        // hit/miss these are null and persist as NULL — never fabricated as 0.
        promptCacheHitTokens: result.promptCacheHitTokens ?? null,
        promptCacheMissTokens: result.promptCacheMissTokens ?? null,
      });

      return result;
    } catch (error: any) {
      await safeLogUsage({
        scenario,
        inputTokens: inputEstimate,
        outputTokens: 0,
        totalTokens: inputEstimate,
        status: 'error',
        errorCode: String(error?.code || 'provider_error'),
        modelName,
        projectId,
        llmConfigId,
        llmConfigName,
      });
      if (error instanceof LLMQueueError) {
        throw new LLMRequestError(error.message, error.code, error, {
          failureClass: 'fatal',
          failurePhase: 'queue',
          requestMayHaveExecuted: false,
        });
      }
      throw error;
    }
  },
};

function buildProviderRequestMetrics(input: {
  base: LLMRequestMetrics;
  queuedAt: number;
  dispatchStartedAt: number;
  requestSentAt?: number;
  responseReceivedAt?: number;
  parseCompletedAt?: number;
}): LLMRequestMetrics {
  const now = Date.now();
  const requestSentAt = input.requestSentAt;
  const responseReceivedAt = input.responseReceivedAt;
  const parseCompletedAt = input.parseCompletedAt;
  return {
    ...input.base,
    queuedAt: input.queuedAt,
    dispatchStartedAt: input.dispatchStartedAt,
    ...(requestSentAt == null ? {} : { requestSentAt }),
    ...(responseReceivedAt == null ? {} : { responseReceivedAt }),
    ...(parseCompletedAt == null ? {} : { parseCompletedAt }),
    queueWaitMs: Math.max(0, input.dispatchStartedAt - input.queuedAt),
    ...(requestSentAt == null
      ? {}
      : {
          providerElapsedMs: Math.max(
            0,
            (responseReceivedAt ?? parseCompletedAt ?? now) - requestSentAt,
          ),
        }),
    ...(responseReceivedAt == null
      ? {}
      : {
          parseMs: Math.max(
            0,
            (parseCompletedAt ?? now) - responseReceivedAt,
          ),
        }),
    totalMs: Math.max(
      0,
      (parseCompletedAt ?? responseReceivedAt ?? now) - input.queuedAt,
    ),
  };
}
