import * as db from '../database';
import {
  estimateMessagesTokens,
  estimateTokens,
} from '../../utils/tokenEstimator';
import type { LLMProvider } from '../../types/llmProvider';
import type {
  ChatMessage,
  LLMGenerateOptions,
  LLMRequestConfig,
  LLMResult,
  LLMQueueClass,
  ReasoningEffort,
} from './types';
import {
  scheduleLLMRequest,
  getLLMTaskQueueDefaults,
} from './requestScheduler';
import {
  createLLMTimeoutController,
  resolveLLMTimeoutPolicy,
  toLLMRequestError,
} from './requestPolicy';
import { assertAllowedLLMEndpoint } from './networkPolicy';

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
 * Resolve the deliberately narrow first-wave capability set.  A model name
 * alone is insufficient: compatible gateways may reject vendor extensions,
 * so only the official DeepSeek host is allowed to receive the field.
 */
export function supportsReasoningEffort(params: {
  providerType?: string | null;
  modelName?: string | null;
  baseUrl?: string | null;
}): boolean {
  if (params.providerType !== 'openai_compatible') return false;
  if (String(params.modelName ?? '').trim().toLowerCase() !== 'deepseek-v4-flash') {
    return false;
  }
  try {
    return new URL(String(params.baseUrl ?? '')).hostname.toLowerCase() === 'api.deepseek.com';
  } catch {
    return false;
  }
}

function isValidReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'max'
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
  };
  formatted.code = code;
  formatted.status = status;
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
          max_tokens: 16,
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

    try {
      const result = await scheduleLLMRequest(
        async queueSignal => {
          const timeoutController = createLLMTimeoutController({
            policy: resolveLLMTimeoutPolicy(scenario, 'openai_compatible'),
            taskId: options.taskId,
            externalSignal: queueSignal,
            onProgress: options.onProgress,
          });
          try {
            const requestBody: Record<string, unknown> = {
              model: config.model_name,
              messages,
              temperature: options.temperature ?? 0.8,
              top_p: options.top_p ?? 0.9,
              max_tokens: options.max_tokens ?? 4000,
              stream: false,
            };
            if (options.responseFormat === 'json_object') {
              requestBody.response_format = { type: 'json_object' };
            }
            if (options.thinking) {
              requestBody.thinking = options.thinking;
            }
            if (
              options.thinking?.type === 'enabled' &&
              isValidReasoningEffort(options.reasoningEffort) &&
              supportsReasoningEffort({
                providerType: config.provider_type,
                modelName: config.model_name,
                baseUrl: config.url,
              })
            ) {
              requestBody.reasoning_effort = options.reasoningEffort;
            }
            const sendRequest = () =>
              fetch(config.url, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${config.api_key}`,
                },
                body: JSON.stringify(requestBody),
                signal: timeoutController.signal,
              });
            let response = await sendRequest();

            if (!response.ok) {
              const text = await response.text();
              const responseFormatUnsupported =
                options.responseFormat === 'json_object' &&
                !('reasoning_effort' in requestBody) &&
                response.status === 400 &&
                /(response[_ ]?format|json[_ -]?object)/i.test(text) &&
                /(unsupported|unknown|not supported|invalid)/i.test(text);
              if (!responseFormatUnsupported) {
                throw formatLLMError(
                  response.status,
                  text,
                  response.headers,
                );
              }
              delete requestBody.response_format;
              response = await sendRequest();
              if (!response.ok) {
                throw formatLLMError(
                  response.status,
                  await response.text(),
                  response.headers,
                );
              }
            }

            const data = await response.json();
            // Some OpenAI-compatible gateways answer HTTP 200 but place the
            // real error inside the body (`{"error":{...}}`, no `choices`).
            // Surfacing it here prevents Canon analysis from retrying an
            // unsupported-parameter failure three times and then reporting a
            // misleading "model does not support JSON" message.
            if (
              !Array.isArray(data.choices) ||
              data.choices.length === 0
            ) {
              if (data && typeof data === 'object' && 'error' in data) {
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
            timeoutController.markProgress('progress');
            return {
              text,
              reasoningText,
              reasoningTokens,
              visibleOutputTokens,
              inputTokens,
              outputTokens,
              totalTokens,
              finishReason,
              emptyReason,
              metrics: { ...timeoutController.metrics },
              rawUsage: data.usage,
            };
          } catch (error: any) {
            throw toLLMRequestError(
              error,
              timeoutController,
              'API 请求失败，请检查网络或服务商状态。',
            );
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
      throw error;
    }
  },
};
