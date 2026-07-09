import * as db from '../database';
import { estimateMessagesTokens, estimateTokens } from '../../utils/tokenEstimator';
import type { LLMProvider } from '../../types/llmProvider';
import type { ChatMessage, LLMGenerateOptions, LLMRequestConfig, LLMResult } from './types';

export function normalizeChatCompletionUrl(baseUrl: string): string {
  let url = baseUrl.trim();
  if (!url) return '';
  if (url.startsWith('http://')) {
    console.warn(`[LLM] ⚠️ 正在使用非 HTTPS 地址：${url}，API Key 将以明文传输。`);
  }
  if (url.endsWith('/chat/completions')) return url;
  if (url.endsWith('/chat/completions/')) return url.slice(0, -1);
  url = url.replace(/\/+$/, '');
  if (/^https?:\/\/api\.deepseek\.com$/i.test(url)) return `${url}/chat/completions`;
  // 识别任意版本号段（/v1、/v2、/v4 等）：智谱 BigModel 用 /v4，只追加 /chat/completions，
  // 不能强塞 /v1 否则会拼成 /v4/v1/chat/completions 触发 404
  if (/\/v\d+$/.test(url)) return `${url}/chat/completions`;
  return `${url}/v1/chat/completions`;
}

export function createLLMConfigError(): Error {
  return new Error('请先在设置中配置 API 地址、API Key 和模型名称。');
}

export function formatLLMError(status: number, responseText: string): Error & { code?: string; status?: number } {
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

  const formatted = new Error(`API 请求失败 (${status}, ${code}): ${message}`) as Error & {
    code?: string;
    status?: number;
  };
  formatted.code = code;
  formatted.status = status;
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

const limitLLMRequest = createConcurrencyLimiter(250);

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

export const openAICompatibleProvider: LLMProvider = {
  type: 'openai_compatible',

  async test(config: LLMRequestConfig): Promise<string> {
    const url = normalizeChatCompletionUrl(config.url);
    if (!url || !config.api_key.trim() || !config.model_name.trim()) {
      throw createLLMConfigError();
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
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
        signal: controller.signal,
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
      if (error?.name === 'AbortError') {
        throw new Error('连接测试超时，请检查手机网络、API 地址和模型服务。');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  },

  async generate(messages: ChatMessage[], options: LLMGenerateOptions, externalSignal?: AbortSignal): Promise<LLMResult> {
    const config = options.requestConfig;
    if (!config) {
      throw new Error('缺少 LLM 请求配置');
    }
    if (!config.url || !config.api_key || !config.model_name) {
      throw createLLMConfigError();
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    const onAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        externalSignal.addEventListener('abort', onAbort, { once: true });
      }
    }

    const inputEstimate = estimateMessagesTokens(messages);
    const scenario = options.scenario || 'chat';
    const modelName = config.model_name;
    const projectId = options.projectId;
    const llmConfigId = config.id;
    const llmConfigName = config.name;

    try {
      const response = await limitLLMRequest(() =>
        fetch(config.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.api_key}`,
          },
          body: JSON.stringify({
            model: config.model_name,
            messages,
            temperature: options.temperature ?? 0.8,
            top_p: options.top_p ?? 0.9,
            max_tokens: options.max_tokens ?? 4000,
            stream: false,
          }),
          signal: controller.signal,
        }),
      );

      if (!response.ok) {
        const text = await response.text();
        throw formatLLMError(response.status, text);
      }

      const data = await response.json();
      const message = data.choices?.[0]?.message || {};
      const text = message.content || message.reasoning_content || null;
      const usage = data.usage || {};
      const inputTokens = Number(usage.prompt_tokens ?? inputEstimate);
      const outputTokens = Number(usage.completion_tokens ?? estimateTokens(text || ''));
      const totalTokens = Number(usage.total_tokens ?? inputTokens + outputTokens);

      await safeLogUsage({
        scenario,
        inputTokens,
        outputTokens,
        totalTokens,
        status: 'success',
        modelName,
        projectId,
        llmConfigId,
        llmConfigName,
      });

      return { text, inputTokens, outputTokens, totalTokens, rawUsage: data.usage };
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        if (externalSignal?.aborted) {
          const cancelError = new Error('已取消') as Error & { code?: string };
          cancelError.code = 'cancelled';
          throw cancelError;
        }
        const timeoutError = new Error('请求超时，请检查网络或模型服务。') as Error & { code?: string };
        timeoutError.code = 'timeout';
        await safeLogUsage({
          scenario,
          inputTokens: inputEstimate,
          outputTokens: 0,
          totalTokens: inputEstimate,
          status: 'error',
          errorCode: timeoutError.code,
          modelName,
          projectId,
          llmConfigId,
          llmConfigName,
        });
        throw timeoutError;
      }

      await safeLogUsage({
        scenario,
        inputTokens: inputEstimate,
        outputTokens: 0,
        totalTokens: inputEstimate,
        status: 'error',
        errorCode: String(error?.code || error?.status || 'unknown'),
        modelName,
        projectId,
        llmConfigId,
        llmConfigName,
      });
      throw error;
    } finally {
      clearTimeout(timeout);
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onAbort);
      }
    }
  },
};
