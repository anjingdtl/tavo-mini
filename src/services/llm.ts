import * as db from './database';

export interface LLMCallConfig {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export function normalizeChatCompletionUrl(baseUrl: string): string {
  let url = baseUrl.trim();
  if (!url) return '';
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
      throw new Error(`API 请求失败 (${response.status})：${text.slice(0, 200)}`);
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
  const llmConfig = await getRequestConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch(llmConfig.url, {
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
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API 请求失败 (${response.status})：${text.slice(0, 200)}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error('请求超时，请检查网络或模型服务。');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
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
