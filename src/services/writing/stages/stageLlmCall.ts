/**
 * Shared physical LLM boundary for production Writer Stage capabilities.
 *
 * Stage-specific prompt/validator code may live in a capability adapter, but
 * the transport call itself stays behind the Writing Stage Set boundary. This
 * keeps the Kernel's post-Freeze call graph auditable and prevents a pipeline
 * or continuation runner from becoming a second Writer Core.
 */
import { callLLMResult } from '../../llm';
import type { LLMCallConfig } from '../../llm';
import type { ChatMessage, LLMResult } from '../../llm/types';

export function callWritingStageLLM(
  messages: ChatMessage[],
  maxTokens: number,
  config: LLMCallConfig,
  abortSignal?: AbortSignal,
): Promise<LLMResult> {
  return callLLMResult(messages, maxTokens, config, abortSignal);
}
