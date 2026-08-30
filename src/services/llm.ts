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
  LLMPhysicalRequestHooks,
  ReasoningEffort,
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
  LLMPhysicalRequestHooks,
  LLMOutputBudgetTrace,
  LLMProviderCapabilitySupport,
  LLMCompletionUsageSemantics,
  ReasoningEffort,
  LLMFailurePhase,
} from './llm/types';

export {
  normalizeChatCompletionUrl,
  createLLMConfigError,
  formatLLMError,
  createConcurrencyLimiter,
  supportsReasoningEffort,
  parseReasoningTokens,
} from './llm/openAICompatibleProvider';
export { classifyLLMFailurePhase } from './llm/requestPolicy';
export type {
  LLMProviderCapability,
  LLMProviderReasoningCapability,
  LLMReasoningEffortMapping,
  ProviderCapabilityConfig,
} from './llm/providerCapabilities';
export {
  ELASTIC_OUTPUT_RESERVE_RATIO,
  deriveElasticOutputReservation,
  normalizePositiveCapability,
  requireModelContextWindow,
  requireModelMaxOutputTokens,
  resolveEffectiveMaxOutputTokens,
  resolveModelOutputCapability,
  resolveProviderCapability,
  resolveProviderOutputBudget,
  resolveProviderReasoningEffort,
} from './llm/providerCapabilities';

import { resolveModelOutputCapability } from './llm/providerCapabilities';

export interface LLMCallConfig {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  responseFormat?: 'json_object';
  /** Optional OpenAI-compatible extension; omitted for existing callers. */
  thinking?: { type: 'enabled' | 'disabled' };
  reasoningEffort?: ReasoningEffort;
  scenario?: string;
  projectId?: number;
  taskId?: string;
  queueClass?: LLMQueueClass;
  queuePriority?: LLMQueuePriority;
  onQueueState?: (state: LLMQueueState) => void;
  onProgress?: (metrics: LLMRequestMetrics) => void;
  physicalRequestHooks?: LLMPhysicalRequestHooks;
  requestConfig?: LLMRequestConfig;
}

export interface LLMConnectionOptions {
  allowInsecureLanHttp?: boolean;
  taskId?: string;
  externalSignal?: AbortSignal;
  onQueueState?: (state: LLMQueueState) => void;
}

export async function resolveLLMRequestConfig(): Promise<LLMRequestConfig> {
  const config = await db.getLLMConfig();
  const raw = config as unknown as LLMRequestConfig & { base_url?: string };
  const providerType = raw.provider_type || 'openai_compatible';
  const capability = resolveModelOutputCapability({
    contextWindow: raw.context_window,
    configuredMaxOutputTokens: raw.max_output_tokens,
  });
  const allowInsecureLanHttp =
    typeof (db as any).getAllowInsecureLanHttp === 'function'
      ? await (db as any).getAllowInsecureLanHttp()
      : false;
  return {
    id: config.id,
    name: config.name,
    provider_type: providerType,
    api_key: config.api_key,
    model_name: config.model_name,
    url: normalizeChatCompletionUrl(config.base_url),
    context_window:
      capability.source === 'unknown'
        ? undefined
        : Number(raw.context_window),
    max_output_tokens: capability.maxOutputTokens ?? undefined,
    provider_adapter_id: raw.provider_adapter_id,
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
  const capability = resolveModelOutputCapability({
    contextWindow: config.context_window,
    configuredMaxOutputTokens: config.max_output_tokens,
  });
  const allowInsecureLanHttp =
    typeof (db as any).getAllowInsecureLanHttp === 'function'
      ? await (db as any).getAllowInsecureLanHttp()
      : false;
  return {
    id: config.id,
    name: config.name,
    provider_type: providerType,
    api_key: config.api_key,
    model_name: config.model_name,
    url: normalizeChatCompletionUrl(config.base_url),
    context_window:
      capability.source === 'unknown'
        ? undefined
        : Number(config.context_window),
    max_output_tokens: capability.maxOutputTokens ?? undefined,
    provider_adapter_id: (config as typeof config & { provider_adapter_id?: string | null })
      .provider_adapter_id,
    allow_insecure_lan_http: Boolean(allowInsecureLanHttp),
  };
}

export async function testLLMConnection(
  baseUrl: string,
  apiKey: string,
  modelName: string,
  _providerType: LLMProviderType = 'openai_compatible',
  _localModelId?: string,
  options: boolean | LLMConnectionOptions = false,
): Promise<string> {
  const connectionOptions: LLMConnectionOptions =
    typeof options === 'boolean' ? { allowInsecureLanHttp: options } : options;
  const provider = getProvider('openai_compatible');
  return scheduleLLMRequest(
    signal =>
      provider.test(
        {
          provider_type: 'openai_compatible',
          api_key: apiKey,
          model_name: modelName,
          url: normalizeChatCompletionUrl(baseUrl),
          allow_insecure_lan_http:
            connectionOptions.allowInsecureLanHttp === true,
        },
        signal,
      ),
    {
      taskId: connectionOptions.taskId,
      queueClass: 'connection',
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
      thinking: config?.thinking,
      reasoningEffort: config?.reasoningEffort,
      scenario: config?.scenario,
      projectId: config?.projectId,
      taskId: config?.taskId,
      queueClass: config?.queueClass,
      queuePriority: config?.queuePriority,
      onQueueState: config?.onQueueState,
      onProgress: config?.onProgress,
      physicalRequestHooks: config?.physicalRequestHooks,
      requestConfig,
    },
    externalSignal,
  );
}
