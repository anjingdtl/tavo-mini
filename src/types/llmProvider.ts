import type {
  ChatMessage,
  LLMMessageContent,
  LLMGenerateOptions,
  LLMResult,
  LLMProviderType,
  LLMRequestConfig,
} from '../services/llm/types';

export interface LLMProvider {
  readonly type: LLMProviderType;
  test(config: LLMRequestConfig, signal?: AbortSignal): Promise<string>;
  generate(
    messages: Array<ChatMessage<LLMMessageContent>>,
    options: LLMGenerateOptions,
    signal?: AbortSignal,
  ): Promise<LLMResult>;
}
