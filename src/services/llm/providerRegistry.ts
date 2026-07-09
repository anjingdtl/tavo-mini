import { openAICompatibleProvider } from './openAICompatibleProvider';
import type { LLMProvider } from '../../types/llmProvider';
import type { LLMProviderType } from './types';

const providers: Record<LLMProviderType, LLMProvider> = {
  openai_compatible: openAICompatibleProvider,
};

export function getProvider(type: LLMProviderType): LLMProvider {
  const provider = providers[type];
  if (!provider) {
    throw new Error(`Unknown LLM provider type: ${type}`);
  }
  return provider;
}
