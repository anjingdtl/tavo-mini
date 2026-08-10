import type { ChatMessage, LLMRequestConfig } from '../llm';
import * as llm from '../llm';
import { resolveElasticStageOutputReservation } from '../contextAutoAllocator';
import { estimateMessagesTokens } from '../../utils/tokenEstimator';
import * as db from '../database';
import { normalizeChatCompletionUrl } from '../llm/openAICompatibleProvider';
import { checkpointMaxTokens as legacyCheckpointMaxTokens } from './storyMemoryBudget';

/**
 * The only Story Memory capability snapshot used by one logical batch.
 *
 * `requestConfig` is intentionally carried alongside the derived numbers so
 * the provider cannot resolve a different active model after the budget has
 * been planned.  The fallback path is only for legacy/test callers whose LLM
 * facade does not expose a resolved request config.
 */
export interface FrozenStoryMemoryLLMConfig {
  configId: number | null;
  providerType: LLMRequestConfig['provider_type'];
  modelName: string;
  contextWindow: number;
  maxOutputTokens: number;
  requestConfig?: LLMRequestConfig;
}

export const STORY_MEMORY_INPUT_SAFETY_TOKENS = 256;

export interface StoryMemoryOutputBudgetInput {
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  /** Compatibility input used only when the model has no capability data. */
  legacyOutputTokens: number;
  batchSize: number;
}

/**
 * Resolve one Story Memory request's output reservation.
 *
 * With a real capability snapshot this delegates to the project's Budget V5
 * resolver.  `legacyOutputTokens` is deliberately ignored in that branch;
 * it exists only to keep old databases/configuration records usable when
 * neither model capability is available.
 */
export function resolveStoryMemoryOutputBudget(
  input: StoryMemoryOutputBudgetInput,
): number {
  const contextWindow = Math.max(0, Math.floor(Number(input.contextWindow) || 0));
  const maxOutputTokens = Math.max(
    0,
    Math.floor(Number(input.maxOutputTokens) || 0),
  );
  if (contextWindow > 0 || maxOutputTokens > 0) {
    return resolveElasticStageOutputReservation({
      contextWindow,
      modelMaxOutputTokens: maxOutputTokens || undefined,
    });
  }
  return legacyCheckpointMaxTokens({
    memoryPatchMaxTokens: input.legacyOutputTokens,
    batchSize: input.batchSize,
  });
}

export type StoryMemoryRequestPlanStrategy =
  | 'full_prompt'
  | 'preflight_split'
  | 'infeasible';

export interface StoryMemoryRequestPlan {
  messages: ChatMessage[];
  maxTokens: number;
  estimatedInputTokens: number;
  contextWindow: number;
  maxInputTokens: number;
  safetyTokens: number;
  capabilityKnown: boolean;
  fits: boolean;
  strategy: StoryMemoryRequestPlanStrategy;
  reason: string;
}

/**
 * Plan the complete prompt before a physical provider call.
 *
 * The current Story Memory prompt builder already emits the mandatory,
 * preferred and optional material in one semantically validated envelope.
 * Therefore the safe fast path is to retain that complete envelope. When it
 * cannot fit, callers split the chapter batch before fetch(); they never
 * silently slice the current chapter body.
 */
export function planStoryMemoryRequest(input: {
  config: FrozenStoryMemoryLLMConfig;
  messages: ChatMessage[];
  legacyOutputTokens: number;
  batchSize: number;
}): StoryMemoryRequestPlan {
  const contextWindow = Math.max(0, Math.floor(input.config.contextWindow || 0));
  const maxTokens = resolveStoryMemoryOutputBudget({
    contextWindow: input.config.contextWindow,
    maxOutputTokens: input.config.maxOutputTokens,
    legacyOutputTokens: input.legacyOutputTokens,
    batchSize: input.batchSize,
  });
  const estimatedInputTokens = estimateMessagesTokens(input.messages);
  const safetyTokens = contextWindow > 0 ? STORY_MEMORY_INPUT_SAFETY_TOKENS : 0;
  const maxInputTokens =
    contextWindow > 0
      ? Math.max(0, contextWindow - maxTokens - safetyTokens)
      : Number.MAX_SAFE_INTEGER;
  const fits =
    maxTokens > 0 &&
    (contextWindow <= 0 || estimatedInputTokens <= maxInputTokens);
  const capabilityKnown =
    input.config.contextWindow > 0 || input.config.maxOutputTokens > 0;

  return {
    messages: input.messages,
    maxTokens,
    estimatedInputTokens,
    contextWindow,
    maxInputTokens,
    safetyTokens,
    capabilityKnown,
    fits,
    strategy: fits
      ? 'full_prompt'
      : input.batchSize > 1
        ? 'preflight_split'
        : 'infeasible',
    reason: fits
      ? ''
      : `完整 Story Memory 请求需要约 ${estimatedInputTokens} 词元输入，` +
        `但当前模型可用输入预算为 ${maxInputTokens}（context_window=${contextWindow}，` +
        `输出 reservation=${maxTokens}）。`,
  };
}

function configFromActiveLLM(active: any): LLMRequestConfig {
  const providerType = active?.provider_type || 'openai_compatible';
  return {
    id: Number(active?.id || 0) || undefined,
    name: active?.name,
    provider_type: providerType,
    api_key: String(active?.api_key || ''),
    model_name: String(active?.model_name || ''),
    url: normalizeChatCompletionUrl(String(active?.base_url || '')),
    context_window: Number(active?.context_window || 0) || undefined,
    max_output_tokens: Number(active?.max_output_tokens || 0) || undefined,
    allow_insecure_lan_http: false,
  };
}

/** Freeze the active LLM request config and its real capabilities once. */
export async function freezeStoryMemoryLLMConfig(): Promise<FrozenStoryMemoryLLMConfig> {
  let requestConfig: LLMRequestConfig | undefined;
  try {
    const resolver = (llm as unknown as {
      resolveLLMRequestConfig?: () => Promise<LLMRequestConfig>;
    }).resolveLLMRequestConfig;
    if (typeof resolver === 'function') {
      requestConfig = await resolver();
    }
  } catch {
    // Fall back to the active config repository below. The caller still gets
    // one frozen snapshot; only the request-config facade was unavailable.
  }

  let active: any = null;
  if (!requestConfig) {
    const getActive = (db as any).getActiveLLMConfig;
    if (typeof getActive === 'function') {
      active = await getActive();
      requestConfig = configFromActiveLLM(active);
    } else {
      // Keep old/offline test doubles and pre-capability callers on the
      // legacy fallback. The production LLM facade always exposes
      // resolveLLMRequestConfig, so this branch does not weaken real-device
      // capability planning.
      requestConfig = {
        provider_type: 'openai_compatible',
        api_key: '',
        model_name: '',
        url: '',
      };
    }
  }

  const contextWindow = Math.max(
    0,
    Math.floor(Number(requestConfig.context_window ?? active?.context_window) || 0),
  );
  const maxOutputTokens = Math.max(
    0,
    Math.floor(
      Number(requestConfig.max_output_tokens ?? active?.max_output_tokens) || 0,
    ),
  );
  // A freshly created local config has schema defaults (4096 / 4000) but no
  // actual model selected. Treat that as capability-unknown until a model is
  // configured; otherwise an unconfigured app would fail preflight before it
  // can surface the provider's normal configuration error.
  const capabilityConfigured = Boolean(requestConfig.model_name.trim());
  return {
    configId: requestConfig.id == null ? null : Number(requestConfig.id),
    providerType: requestConfig.provider_type,
    modelName: requestConfig.model_name,
    contextWindow: capabilityConfigured ? contextWindow : 0,
    maxOutputTokens: capabilityConfigured ? maxOutputTokens : 0,
    requestConfig,
  };
}
