import * as db from './database';
import { estimateMessagesTokens, estimateTokens } from '../utils/tokenEstimator';

export interface LLMCallConfig {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  scenario?: string;
  projectId?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMResult {
  text: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  errorCode?: string;
  rawUsage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
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
  if (url.endsWith('/v1')) return `${url}/chat/completions`;
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

async function getRequestConfig() {
  const llmConfig = await db.getLLMConfig();
  if (!llmConfig.base_url || !llmConfig.api_key || !llmConfig.model_name) {
    throw createLLMConfigError();
  }
  return {
    ...llmConfig,
    url: normalizeChatCompletionUrl(llmConfig.base_url),
  };
}

export async function testLLMConnection(baseUrl: string, apiKey: string, modelName: string): Promise<string> {
  const url = normalizeChatCompletionUrl(baseUrl);
  if (!url || !apiKey.trim() || !modelName.trim()) {
    throw createLLMConfigError();
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey.trim()}`,
      },
      body: JSON.stringify({
        model: modelName.trim(),
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
    return data.choices?.[0]?.message?.content || '连接成功';
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error('连接测试超时，请检查手机网络、API 地址和模型服务。');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function callLLM(
  messages: ChatMessage[],
  maxTokens?: number,
  config?: LLMCallConfig,
): Promise<string | null> {
  const result = await callLLMResult(messages, maxTokens, config);
  return result.text;
}

export async function callLLMResult(
  messages: ChatMessage[],
  maxTokens?: number,
  config?: LLMCallConfig,
  externalSignal?: AbortSignal,
): Promise<LLMResult> {
  const llmConfig = await getRequestConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  // 联动外部 signal：用户取消流水线时立即 abort，无需等 60s 超时
  // handler 提到外部作用域，便于在 finally 中移除，避免监听器累积
  const onAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', onAbort, { once: true });
    }
  }
  const inputEstimate = estimateMessagesTokens(messages);
  const scenario = config?.scenario || 'chat';
  const modelName = llmConfig.model_name;
  const projectId = config?.projectId;

  try {
    const response = await limitLLMRequest(() =>
      fetch(llmConfig.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${llmConfig.api_key}`,
        },
        body: JSON.stringify({
          model: llmConfig.model_name,
          messages,
          temperature: config?.temperature ?? 0.8,
          top_p: config?.top_p ?? 0.9,
          max_tokens: maxTokens ?? config?.max_tokens ?? 4000,
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
    const text = data.choices?.[0]?.message?.content || null;
    const usage = data.usage || {};
    const inputTokens = Number(usage.prompt_tokens || inputEstimate);
    const outputTokens = Number(usage.completion_tokens || estimateTokens(text || ''));
    const totalTokens = Number(usage.total_tokens || inputTokens + outputTokens);

    await safeLogUsage({ scenario, inputTokens, outputTokens, totalTokens, status: 'success', modelName, projectId });

    return { text, inputTokens, outputTokens, totalTokens, rawUsage: data.usage };
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      // 区分用户主动取消和请求超时：外部 signal 被 abort 视为用户取消，不当作失败
      if (externalSignal?.aborted) {
        const cancelError = new Error('朗读已取消') as Error & { code?: string };
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
    });
    throw error;
  } finally {
    clearTimeout(timeout);
    // 正常完成时移除监听器，避免监听器累积
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onAbort);
    }
  }
}

export async function callLLMStream(
  messages: ChatMessage[],
  config?: LLMCallConfig,
  onChunk?: (chunk: string, fullText: string) => void,
  onDone?: (fullText: string) => void,
  abortSignal?: AbortSignal,
): Promise<string | null> {
  if (abortSignal?.aborted) {
    onDone?.('');
    return '';
  }

  const result = await callLLM(messages, config?.max_tokens, config);
  if (result) {
    onChunk?.(result, result);
    onDone?.(result);
  }
  return result;
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
}) {
  try {
    await db.logLLMUsage(fields);
  } catch {
    // Usage logging must never break generation.
  }
}
