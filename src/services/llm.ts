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

  // 共用请求体（stream 字段由各路径覆盖）
  const buildBody = (stream: boolean) =>
    JSON.stringify({
      model: llmConfig.model_name,
      messages,
      temperature: config?.temperature ?? 0.8,
      top_p: config?.top_p ?? 0.9,
      max_tokens: maxTokens ?? config?.max_tokens ?? 4000,
      stream,
    });
  const fetchHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${llmConfig.api_key}`,
  };

  try {
    // 优先流式：reader 循环周期性读取让 JS 线程保持活跃，
    // 显著降低 App 切后台时被 Android 判定为"空闲可挂起"的概率。
    // 失败时（provider 不支持 SSE / 解析异常 / 非 200）降级非流式。
    let result: LLMResult;
    try {
      if (controller.signal.aborted) throw new Error('aborted');
      result = await limitLLMRequest(() =>
        fetchStreaming(llmConfig.url, fetchHeaders, buildBody(true), controller.signal, inputEstimate),
      );
    } catch (streamError: any) {
      // 用户取消或超时不降级，直接抛出走统一错误处理
      if (streamError?.name === 'AbortError' || controller.signal.aborted) throw streamError;
      // 流式不可用，降级非流式（兼容不支持 SSE 的 provider）
      result = await limitLLMRequest(() =>
        fetchNonStreaming(llmConfig.url, fetchHeaders, buildBody(false), controller.signal, inputEstimate),
      );
    }

    await safeLogUsage({
      scenario,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      totalTokens: result.totalTokens,
      status: 'success',
      modelName,
      projectId,
    });

    return result;
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      // 区分用户主动取消和请求超时：外部 signal 被 abort 视为用户取消，不当作失败
      if (externalSignal?.aborted) {
        // 改为通用文案"已取消"：callLLMResult 被管线/摘要/风格分析共享，
        // 管线取消时显示"朗读已取消"语义错乱
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

/**
 * 流式 SSE 请求：逐 chunk 读取响应，保持 JS 线程活跃（后台保活关键）。
 * 解析 OpenAI 兼容的 data: 行，累积 content 与末尾 usage。
 */
async function fetchStreaming(
  url: string,
  headers: Record<string, string>,
  body: string,
  signal: AbortSignal,
  inputEstimate: number,
): Promise<LLMResult> {
  const response = await fetch(url, { method: 'POST', headers, body, signal });
  if (!response.ok) {
    const text = await response.text();
    throw formatLLMError(response.status, text);
  }
  // 部分_provider 对 stream 请求仍返回普通 JSON（非 SSE），按 content-type 兜底
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream') && !contentType.includes('application/x-ndjson')) {
    // 非流式响应体，按 JSON 解析
    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || null;
    const usage = data.usage || {};
    return {
      text,
      inputTokens: Number(usage.prompt_tokens ?? inputEstimate),
      outputTokens: Number(usage.completion_tokens ?? estimateTokens(text || '')),
      totalTokens: Number(usage.total_tokens ?? inputEstimate + (Number(usage.completion_tokens ?? estimateTokens(text || '')))),
      rawUsage: data.usage,
    };
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('STREAM_NO_READER');

  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let content = '';
  let usage: any = null;

  // reader.read() 循环：每次 await 让 JS 事件循环保持活跃，是后台保活的核心
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE 以 \n\n 分隔事件，按行处理已完整的行
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // 保留最后不完整的一行
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || !line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta?.content;
        if (typeof delta === 'string') content += delta;
        // 流式 usage 通常在最后一个 chunk 携带
        if (json.usage) usage = json.usage;
      } catch {
        // 单行解析失败不影响整体累积
      }
    }
  }

  const outputEstimate = estimateTokens(content);
  return {
    text: content || null,
    inputTokens: Number(usage?.prompt_tokens ?? inputEstimate),
    outputTokens: Number(usage?.completion_tokens ?? outputEstimate),
    totalTokens: Number(usage?.total_tokens ?? inputEstimate + outputEstimate),
    rawUsage: usage || undefined,
  };
}

/**
 * 非流式请求（流式降级路径，或 provider 不支持 SSE 时使用）。
 */
async function fetchNonStreaming(
  url: string,
  headers: Record<string, string>,
  body: string,
  signal: AbortSignal,
  inputEstimate: number,
): Promise<LLMResult> {
  const response = await fetch(url, { method: 'POST', headers, body, signal });
  if (!response.ok) {
    const text = await response.text();
    throw formatLLMError(response.status, text);
  }
  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || null;
  const usage = data.usage || {};
  // 用 ?? 而非 ||：provider 返回 0 是有效值（如纯嵌入请求），不应回退到估算。
  const inputTokens = Number(usage.prompt_tokens ?? inputEstimate);
  const outputTokens = Number(usage.completion_tokens ?? estimateTokens(text || ''));
  const totalTokens = Number(usage.total_tokens ?? inputTokens + outputTokens);
  return { text, inputTokens, outputTokens, totalTokens, rawUsage: data.usage };
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
