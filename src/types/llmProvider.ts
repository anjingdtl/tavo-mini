import type { ChatMessage, LLMGenerateOptions, LLMResult, LLMProviderType, LLMRequestConfig } from '../services/llm/types';

export interface LLMProvider {
  readonly type: LLMProviderType;
  test(config: LLMRequestConfig): Promise<string>;
  generate(
    messages: ChatMessage[],
    options: LLMGenerateOptions,
    signal?: AbortSignal,
  ): Promise<LLMResult>;
}
