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

// ───────────────────────── V2.2.0 流式路径 ─────────────────────────

export interface LLMStreamHandlers {
  /** 收到每个增量文本片段（不一定每 chunk 都触发，取决于 provider 与 stream_options）。 */
  onChunk: (delta: string) => void;
  /** 整段流结束（包含 usage），调用方拿到最终 LLMResult。 */
  onDone: (result: LLMResult) => void;
  /** 流式失败（用户取消 / 阶段超时 / stall / HTTP 失败等）。 */
  onError: (err: Error) => void;
}

export interface CallLLMStreamOptions {
  stallTimeoutMs?: number;
  totalTimeoutMs?: number;
}

// 不同 scenario 的默认超时。流式比非流式慢，60s 完全不够；按阶段给。
const SCENARIO_STREAM_TIMEOUTS: Record<string, { total: number; stall: number }> = {
  pipeline_draft: { total: 300_000, stall: 30_000 },
  pipeline_proof: { total: 300_000, stall: 30_000 },
  pipeline_review: { total: 120_000, stall: 30_000 },
  pipeline_factcheck: { total: 120_000, stall: 30_000 },
  chat: { total: 60_000, stall: 20_000 },
};
const STREAM_TIMEOUT_DEFAULT = { total: 60_000, stall: 20_000 };

/**
 * 把缓冲区内"完整 SSE message"切走，未完整的部分留在 rest。
 * 每个 message 以 \n\n 结尾；message 内可有多个 `data:` 行，取其拼接再 JSON.parse。
 */
function parseSSEChunk(buffer: string): { events: any[]; rest: string } {
  const events: any[] = [];
  let idx = 0;
  while (true) {
    const sep = buffer.indexOf('\n\n', idx);
    if (sep < 0) break;
    const block = buffer.slice(idx, sep);
    idx = sep + 2;
    const dataLines = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());
    if (dataLines.length === 0) continue;
    const data = dataLines.join('\n');
    if (data === '[DONE]') {
      events.push({ __done: true });
      continue;
    }
    try {
      events.push(JSON.parse(data));
    } catch {
      // 容忍畸形 JSON：SSE 偶发半包或厂商扩展，行级失败不影响整流
    }
  }
  return { events, rest: buffer.slice(idx) };
}

function extractDeltaFromEvent(evt: any): string {
  try {
    const choice = evt?.choices?.[0];
    if (!choice) return '';
    return (
      choice?.delta?.content ??
      choice?.message?.content ??
      ''
    );
  } catch {
    return '';
  }
}

function extractUsageFromEvent(evt: any): { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined {
  if (!evt || typeof evt !== 'object') return undefined;
  if (evt?.usage && typeof evt.usage === 'object') return evt.usage;
  const choice = evt?.choices?.[0];
  if (choice?.usage) return choice.usage;
  return undefined;
}

/**
 * 流式调用 LLM（OpenAI-compatible SSE）。
 *
 * 与 `callLLMResult` 关键差异：
 *  - 默认 30s stall / 按 scenario 区分的总超时（不再共用 60s）
 *  - 用户取消 / stall / 总超时 / HTTP 失败 4 类错误信号严格分层（V2.1.1 翻车的根源）
 *  - 每个 chunk 通过 onChunk 立即回调，调用方可以做实时草稿预览
 *  - 自动按 scenario 选超时；调用方可在 options 覆盖
 *
 * Provider 兼容性：要求 SSE（text/event-stream）。不支持的会被识别 Content-Type 后抛错，
 * 调用方按需降级到 `callLLMResult`。
 */
export async function callLLMStream(
  messages: ChatMessage[],
  maxTokens: number | undefined,
  config: LLMCallConfig | undefined,
  handlers: LLMStreamHandlers,
  externalSignal?: AbortSignal,
  options?: CallLLMStreamOptions,
): Promise<LLMResult> {
  const llmConfig = await getRequestConfig();
  const scenario = config?.scenario || 'chat';
  const timeouts = SCENARIO_STREAM_TIMEOUTS[scenario] || STREAM_TIMEOUT_DEFAULT;
  const totalTimeoutMs = options?.totalTimeoutMs ?? timeouts.total;
  const stallTimeoutMs = options?.stallTimeoutMs ?? timeouts.stall;
  const inputEstimate = estimateMessagesTokens(messages);
  const modelName = llmConfig.model_name;
  const projectId = config?.projectId;
  const llmConfigId = llmConfig.id;
  const llmConfigName = llmConfig.name;

  // 0) 外部 signal 在我们启动前已经被 abort——直接走 cancel 路径，不浪费一次 fetch
  if (externalSignal?.aborted) {
    const e = new Error('已取消') as Error & { code?: string };
    e.code = 'cancelled';
    await safeLogUsage({
      scenario, inputTokens: inputEstimate, outputTokens: 0, totalTokens: inputEstimate,
      status: 'error', errorCode: 'cancelled', modelName, projectId, llmConfigId, llmConfigName,
    });
    try {
      handlers.onError(e);
    } catch {
      /* ignore */
    }
    throw e;
  }

  const controller = new AbortController();
  let abortedReason: 'user' | 'stall' | 'total' | null = null;

  // 总超时（独立 timeout id）
  const totalTimer = setTimeout(() => {
    abortedReason = 'total';
    controller.abort();
  }, totalTimeoutMs);

  // stall watchdog：每次收到 chunk 就重置
  let stallTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    abortedReason = 'stall';
    controller.abort();
  }, stallTimeoutMs);
  const armStall = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      abortedReason = 'stall';
      controller.abort();
    }, stallTimeoutMs);
  };

  // 外部 signal → 内部 controller，一次性 listener
  const onExternalAbort = () => controller.abort();
  if (externalSignal) externalSignal.addEventListener('abort', onExternalAbort, { once: true });

  const cleanup = () => {
    clearTimeout(totalTimer);
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = null;
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    try {
      controller.abort();
    } catch {
      /* ignore */
    }
  };

  const throwError = async (
    err: Error,
    errorCode: string,
  ): Promise<never> => {
    cleanup();
    await safeLogUsage({
      scenario, inputTokens: inputEstimate, outputTokens: 0, totalTokens: inputEstimate,
      status: 'error', errorCode, modelName, projectId, llmConfigId, llmConfigName,
    });
    try {
      handlers.onError(err);
    } catch {
      /* ignore */
    }
    throw err;
  };

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
          stream: true,
        }),
        signal: controller.signal,
      }),
    );

    if (!response.ok) {
      const text = await response.text();
      const err = formatLLMError(response.status, text);
      await throwError(err, err.code || `HTTP_${response.status}`);
    }

    const ctype = response.headers.get('content-type') || '';
    const looksLikeSSE = ctype.includes('text/event-stream') || ctype.includes('event-stream');
    if (!looksLikeSSE) {
      const err = new Error(
        `Provider does not support streaming (Content-Type: ${ctype || '<empty>'})`,
      ) as Error & { code?: string };
      err.code = 'stream_not_supported';
      await throwError(err, 'stream_not_supported');
    }

    const reader = (response.body as any)?.getReader?.();
    if (!reader) {
      const err = new Error('No readable body in stream response') as Error & { code?: string };
      err.code = 'no_body';
      await throwError(err, 'no_body');
    }

    let outText = '';
    let totalOutputEstimate = 0;
    let rawUsage: any;
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const readResult = await reader.read();
      if (readResult.done) break;
      armStall();
      buffer += decoder.decode(readResult.value as Uint8Array, { stream: true });
      const { events, rest } = parseSSEChunk(buffer);
      buffer = rest;
      for (const evt of events) {
        if (evt?.__done) continue;
        const usage = extractUsageFromEvent(evt);
        if (usage) {
          rawUsage = usage;
          continue;
        }
        const delta = extractDeltaFromEvent(evt);
        if (delta) {
          outText += delta;
          totalOutputEstimate += estimateTokens(delta);
          try {
            handlers.onChunk(delta);
          } catch {
            /* UI 回调抛错不影响主流程 */
          }
        }
      }
    }

    const outputTokens = rawUsage?.completion_tokens ?? totalOutputEstimate;
    const promptTokens = rawUsage?.prompt_tokens ?? inputEstimate;
    const tokensTotal = rawUsage?.total_tokens ?? (promptTokens + outputTokens);
    const result: LLMResult = {
      text: outText || null,
      inputTokens: Number(promptTokens) || inputEstimate,
      outputTokens: Number(outputTokens) || totalOutputEstimate,
      totalTokens: Number(tokensTotal) || (inputEstimate + totalOutputEstimate),
      rawUsage,
    };
    cleanup();
    await safeLogUsage({
      scenario,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      totalTokens: result.totalTokens,
      status: 'success',
      modelName, projectId, llmConfigId, llmConfigName,
    });
    try {
      handlers.onDone(result);
    } catch {
      /* ignore */
    }
    return result;
  } catch (err: any) {
    // 4 类 abort 信号分层（V2.1.1 的根因）
    const totalSeconds = Math.max(1, Math.round(totalTimeoutMs / 1000));
    const stallSeconds = Math.max(1, Math.round(stallTimeoutMs / 1000));
    if (externalSignal?.aborted) {
      const e = new Error('已取消') as Error & { code?: string };
      e.code = 'cancelled';
      await throwError(e, 'cancelled');
    }
    if (abortedReason === 'stall') {
      const e = new Error(`流式响应停滞（${stallSeconds}s 内无新数据）`) as Error & { code?: string };
      e.code = 'stall';
      await throwError(e, 'stall');
    }
    if (abortedReason === 'total') {
      const e = new Error(`阶段超时（${totalSeconds}s）`) as Error & { code?: string };
      e.code = 'timeout';
      await throwError(e, 'timeout');
    }
    if (err?.name === 'AbortError') {
      const e = new Error('请求被中止') as Error & { code?: string };
      e.code = 'aborted';
      await throwError(e, 'aborted');
    }
    // 其他原生错误
    const e = err instanceof Error ? err : new Error(String(err));
    await throwError(e, String((err as any)?.code || (err as any)?.status || 'unknown'));
  }
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
  // V2.2.0 (schema 10): 用量日志按配置区分，多 LLM 切换可追溯来源
  const llmConfigId = llmConfig.id;
  const llmConfigName = llmConfig.name;

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
    // 用 ?? 而非 ||：provider 返回 0 是有效值（如纯嵌入请求），不应回退到估算。
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
    // 正常完成时移除监听器，避免监听器累积
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onAbort);
    }
  }
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
  // V2.2.0 (schema 10): 按配置区分用量，便于多 LLM 场景下识别来源
  llmConfigId?: number;
  llmConfigName?: string;
}) {
  try {
    await db.logLLMUsage(fields);
  } catch {
    // Usage logging must never break generation.
  }
}
