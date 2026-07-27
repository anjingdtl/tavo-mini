import * as db from './database';
import { getProvider } from './llm/providerRegistry';
import { normalizeChatCompletionUrl } from './llm/openAICompatibleProvider';
import type {
  ChatMessage,
  LLMProviderType,
  LLMRequestConfig,
  LLMResult,
  LLMQueueClass,
  LLMQueuePriority,
  LLMQueueState,
  LLMRequestMetrics,
} from './llm/types';
import { scheduleLLMRequest } from './llm/requestScheduler';

export type {
  ChatMessage,
  LLMGenerateOptions,
  LLMProviderType,
  LLMRequestConfig,
  LLMResult,
  LLMQueueClass,
  LLMQueuePriority,
  LLMQueueState,
  LLMRequestMetrics,
} from './llm/types';

export {
  normalizeChatCompletionUrl,
  createLLMConfigError,
  formatLLMError,
  createConcurrencyLimiter,
} from './llm/openAICompatibleProvider';

export interface LLMCallConfig {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  responseFormat?: 'json_object';
  scenario?: string;
  projectId?: number;
  taskId?: string;
  queueClass?: LLMQueueClass;
  queuePriority?: LLMQueuePriority;
  onQueueState?: (state: LLMQueueState) => void;
  onProgress?: (metrics: LLMRequestMetrics) => void;
  requestConfig?: LLMRequestConfig;
}

export interface LLMConnectionOptions {
  allowInsecureLanHttp?: boolean;
  taskId?: string;
  externalSignal?: AbortSignal;
  onQueueState?: (state: LLMQueueState) => void;
}

async function repairLegacyLocalConfigSelection(
  config: Awaited<ReturnType<typeof db.getLLMConfig>>,
) {
  const providerType = config.provider_type || 'openai_compatible';
  const isBlankOnlineConfig =
    providerType === 'openai_compatible' &&
    !config.base_url.trim() &&
    !config.api_key.trim() &&
    !config.model_name.trim();

  if (!isBlankOnlineConfig) return config;

  const configs = await db.getLLMConfigs();
  const localConfigs = configs.filter(
    item => item.provider_type === 'llama_cpp' && item.local_model_id,
  );
  for (const localConfig of localConfigs) {
    const model = await db.getLocalModelById(localConfig.local_model_id!);
    if (model?.status !== 'ready') continue;

    await db.setActiveLLMConfig(localConfig.id);
    return { ...localConfig, is_active: 1 };
  }

  return config;
}

export async function resolveLLMRequestConfig(): Promise<LLMRequestConfig> {
  const currentConfig = await db.getLLMConfig();
  // Older builds created a local config without activating it. Repair that
  // persisted state only when the selected online config is entirely blank.
  const config = await repairLegacyLocalConfigSelection(currentConfig);
  const raw = config as unknown as LLMRequestConfig & { base_url?: string };
  const providerType = raw.provider_type || 'openai_compatible';
  const allowInsecureLanHttp =
    typeof (db as any).getAllowInsecureLanHttp === 'function'
      ? await (db as any).getAllowInsecureLanHttp()
      : false;
  return {
    id: config.id,
    name: config.name,
    provider_type: providerType,
    api_key: providerType === 'openai_compatible' ? config.api_key : '',
    model_name: config.model_name,
    url: normalizeChatCompletionUrl(config.base_url),
    local_model_id: raw.local_model_id,
    local_backend: raw.local_backend,
    context_window: raw.context_window,
    max_output_tokens: raw.max_output_tokens,
    allow_insecure_lan_http: Boolean(allowInsecureLanHttp),
  };
}

/** Resolve a specific persisted configuration without changing the active one. */
export async function resolveLLMRequestConfigById(
  configId: number,
): Promise<LLMRequestConfig> {
  const configs = await db.getLLMConfigs();
  const config = configs.find(item => item.id === configId);
  if (!config) throw new Error(`未找到 LLM 配置：${configId}`);
  const providerType = config.provider_type || 'openai_compatible';
  const allowInsecureLanHttp =
    typeof (db as any).getAllowInsecureLanHttp === 'function'
      ? await (db as any).getAllowInsecureLanHttp()
      : false;
  return {
    id: config.id,
    name: config.name,
    provider_type: providerType,
    api_key: providerType === 'openai_compatible' ? config.api_key : '',
    model_name: config.model_name,
    url: normalizeChatCompletionUrl(config.base_url),
    local_model_id: config.local_model_id ?? undefined,
    local_backend: config.local_backend ?? undefined,
    context_window: config.context_window,
    max_output_tokens: config.max_output_tokens,
    allow_insecure_lan_http: Boolean(allowInsecureLanHttp),
  };
}

export async function testLLMConnection(
  baseUrl: string,
  apiKey: string,
  modelName: string,
  providerType: LLMProviderType = 'openai_compatible',
  localModelId?: string,
  options: boolean | LLMConnectionOptions = false,
): Promise<string> {
  const connectionOptions: LLMConnectionOptions =
    typeof options === 'boolean' ? { allowInsecureLanHttp: options } : options;
  const provider = getProvider(providerType);
  const queueClass = providerType === 'llama_cpp' ? 'local' : 'connection';
  return scheduleLLMRequest(
    signal =>
      provider.test(
        {
          provider_type: providerType,
          api_key: apiKey,
          model_name: modelName,
          url: normalizeChatCompletionUrl(baseUrl),
          local_model_id: localModelId,
          allow_insecure_lan_http:
            connectionOptions.allowInsecureLanHttp === true,
        },
        signal,
      ),
    {
      taskId: connectionOptions.taskId,
      queueClass,
      queuePriority: 'manual',
      externalSignal: connectionOptions.externalSignal,
      onQueueState: connectionOptions.onQueueState,
    },
  );
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
  const requestConfig =
    config?.requestConfig ?? (await resolveLLMRequestConfig());
  const provider = getProvider(requestConfig.provider_type);
  return provider.generate(
    messages,
    {
      temperature: config?.temperature,
      top_p: config?.top_p,
      max_tokens: maxTokens ?? config?.max_tokens,
      responseFormat: config?.responseFormat,
      scenario: config?.scenario,
      projectId: config?.projectId,
      taskId: config?.taskId,
      queueClass: config?.queueClass,
      queuePriority: config?.queuePriority,
      onQueueState: config?.onQueueState,
      onProgress: config?.onProgress,
      requestConfig,
    },
    externalSignal,
  );
}
