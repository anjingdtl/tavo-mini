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
import { createWritingPhysicalRequestAccounting } from '../observability/writingPhysicalRequestAccounting';

export type WritingStageLlmResult = LLMResult & {
  physicalRequestCount: number;
  protocolFallbackCount: number;
};

export async function callWritingStageLLM(
  messages: ChatMessage[],
  maxTokens: number,
  config: LLMCallConfig,
  abortSignal?: AbortSignal,
): Promise<WritingStageLlmResult> {
  const accounting = createWritingPhysicalRequestAccounting(
    config.physicalRequestHooks,
  );
  let result: LLMResult;
  try {
    result = await callLLMResult(
      messages,
      maxTokens,
      {
        ...config,
        physicalRequestHooks: accounting.hooks,
      },
      abortSignal,
    );
  } catch (error) {
    // A transport error can happen after one or more provider requests have
    // already been sent (for example, primary protocol rejection followed by
    // a fallback transport failure). Preserve that count for the failed
    // receipt and the durable stage-attempt ledger.
    const next =
      error instanceof Error ? error : new Error(String(error || 'LLM failed'));
    const snapshot = accounting.snapshot();
    Object.assign(next, {
      physicalRequestCount: snapshot.physicalRequestCount,
      protocolFallbackCount: snapshot.protocolFallbackCount,
    });
    throw next;
  }
  const snapshot = accounting.snapshot();
  return {
    ...result,
    physicalRequestCount: snapshot.physicalRequestCount || 1,
    protocolFallbackCount: snapshot.protocolFallbackCount,
  };
}
