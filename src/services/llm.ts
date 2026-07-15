import * as db from './database';
import { getProvider } from './llm/providerRegistry';
import { normalizeChatCompletionUrl } from './llm/openAICompatibleProvider';
import type {
  ChatMessage,
  LLMProviderType,
  LLMRequestConfig,
  LLMResult,
} from './llm/types';

export type { ChatMessage, LLMGenerateOptions, LLMProviderType, LLMRequestConfig, LLMResult } from './llm/types';

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
  scenario?: string;
  projectId?: number;
  requestConfig?: LLMRequestConfig;
}

async function repairLegacyLocalConfigSelection(config: Awaited<ReturnType<typeof db.getLLMConfig>>) {
  const providerType = config.provider_type || 'openai_compatible';
  const isBlankOnlineConfig = providerType === 'openai_compatible'
    && !config.base_url.trim()
    && !config.api_key.trim()
    && !config.model_name.trim();

  if (!isBlankOnlineConfig) return config;

  const configs = await db.getLLMConfigs();
  const localConfigs = configs.filter(item => item.provider_type === 'llama_cpp' && item.local_model_id);
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
  };
}

export async function testLLMConnection(
  baseUrl: string,
  apiKey: string,
  modelName: string,
  providerType: LLMProviderType = 'openai_compatible',
  localModelId?: string,
): Promise<string> {
  const provider = getProvider(providerType);
  return provider.test({
    provider_type: providerType,
    api_key: apiKey,
    model_name: modelName,
    url: normalizeChatCompletionUrl(baseUrl),
    local_model_id: localModelId,
  });
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
  const requestConfig = config?.requestConfig ?? await resolveLLMRequestConfig();
  const provider = getProvider(requestConfig.provider_type);
  return provider.generate(
    messages,
    {
      temperature: config?.temperature,
      top_p: config?.top_p,
      max_tokens: maxTokens ?? config?.max_tokens,
      scenario: config?.scenario,
      projectId: config?.projectId,
      requestConfig,
    },
    externalSignal,
  );
}
