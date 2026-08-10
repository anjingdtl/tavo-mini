import type { LLMCallConfig, LLMRequestConfig } from '../llm';

/**
 * The only request policy for Story Memory network calls. Story Memory is a
 * structured extraction task, so it must never inherit a creative model's
 * thinking setting. Provider compatibility may omit the extension, but the
 * caller always starts with an explicit disabled policy.
 */
export const STORY_MEMORY_STRUCTURED_POLICY = {
  temperature: 0.1,
  responseFormat: 'json_object' as const,
  thinking: { type: 'disabled' as const },
  queueClass: 'background' as const,
  queuePriority: 'normal' as const,
};

export function buildStoryMemoryLLMConfig(
  input: Pick<LLMCallConfig, 'scenario' | 'projectId' | 'physicalRequestHooks'> & {
    requestConfig?: LLMRequestConfig;
  },
): LLMCallConfig {
  return {
    ...STORY_MEMORY_STRUCTURED_POLICY,
    scenario: input.scenario,
    projectId: input.projectId,
    physicalRequestHooks: input.physicalRequestHooks,
    requestConfig: input.requestConfig,
  };
}
