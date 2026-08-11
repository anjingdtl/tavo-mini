import type { ChatMessage, LLMRequestConfig } from '../llm';
import * as llm from '../llm';
import { resolveElasticStageOutputReservation } from '../contextAutoAllocator';
import { estimateMessagesTokens, estimateTokens, clipTextToTokenBudget } from '../../utils/tokenEstimator';
import * as db from '../database';
import { normalizeChatCompletionUrl } from '../llm/openAICompatibleProvider';
import { checkpointMaxTokens as legacyCheckpointMaxTokens } from './storyMemoryBudget';
import { allocateElasticStageContextBudget, type ElasticContextDemand, type ElasticDemandRequirement } from '../pipeline/elasticBudgetAllocator';
import { deriveDefaultSafetyMargin } from '../pipeline/budgetAllocator';
import type {
  StoryMemoryCheckpointMaterials,
  StoryMemoryPromptModule,
} from './storyMemoryPromptMaterials';
import { buildMessagesFromMaterials } from './storyMemoryPromptMaterials';
import {
  buildMessagesFromObservationMaterials,
  packWholeItems,
  type StoryMemoryObservationMaterials,
  type StoryMemoryObservationPromptModule,
} from './storyMemoryObservationMaterials';

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

export const STORY_MEMORY_V2_OUTPUT_BASE_TOKENS = 2048;
export const STORY_MEMORY_V2_OUTPUT_PER_CHAPTER = 6144;
export const STORY_MEMORY_V2_OUTPUT_HARD_CAP = 24576;
export const STORY_MEMORY_V2_OUTPUT_MIN_PER_CHAPTER = 4096;

export function resolveStoryMemoryV2OutputBudget(input: {
  batchSize: number;
  modelMaxOutputTokens?: number | null;
}): number {
  const size = Math.max(1, Math.floor(Number(input.batchSize) || 1));
  const target = Math.min(
    STORY_MEMORY_V2_OUTPUT_HARD_CAP,
    STORY_MEMORY_V2_OUTPUT_BASE_TOKENS +
      STORY_MEMORY_V2_OUTPUT_PER_CHAPTER * size,
  );
  const modelCap = Math.max(0, Math.floor(Number(input.modelMaxOutputTokens) || 0));
  return modelCap > 0 ? Math.min(target, modelCap) : target;
}

export interface StoryMemoryObservationRequestPlan {
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  maxTokens: number;
  estimatedInputTokens: number;
  contextWindow: number;
  safetyMargin: number;
  softInputLimit: number;
  burstInputLimit: number;
  hardInputLimit: number;
  capabilityKnown: boolean;
  fullPrompt: boolean;
  strategy: StoryMemoryRequestPlanStrategy;
  reason: string;
  includedModuleIds: string[];
  droppedModuleIds: string[];
}

function observationModuleToDemand(
  module: StoryMemoryObservationPromptModule,
): ElasticContextDemand {
  const availableTokens = Math.max(0, estimateTokens(module.text));
  const requirement: ElasticDemandRequirement =
    module.tier === 'mandatory' ? 'mandatory' : 'preferred';
  return {
    id: module.id,
    availableTokens,
    minTokens: requirement === 'mandatory' ? availableTokens : 0,
    targetTokens: availableTokens,
    maxTokens: availableTokens,
    priority: module.priority,
    relevance: module.relevance,
    requirement,
    reclaimable: requirement !== 'mandatory',
    shrinkPriority: module.shrinkPriority,
    burstPriority: module.burstPriority,
  };
}

function sortWholeItemCandidates(
  modules: StoryMemoryObservationPromptModule[],
): StoryMemoryObservationPromptModule[] {
  return [...modules].sort(
    (left, right) =>
      right.priority * right.relevance - left.priority * left.relevance ||
      right.burstPriority - left.burstPriority ||
      left.id.localeCompare(right.id),
  );
}

/**
 * Protocol V2 input planner. The shared elastic allocator still decides the
 * water levels; this adapter only changes final material selection from
 * character clipping to whole-item packing.
 */
export function planStoryMemoryObservationRequest(input: {
  config: FrozenStoryMemoryLLMConfig;
  materials: StoryMemoryObservationMaterials;
  batchSize: number;
}): StoryMemoryObservationRequestPlan {
  const contextWindow = Math.max(0, Math.floor(input.config.contextWindow || 0));
  const maxTokens = resolveStoryMemoryV2OutputBudget({
    batchSize: input.batchSize,
    modelMaxOutputTokens: input.config.maxOutputTokens,
  });
  const capabilityKnown =
    input.config.contextWindow > 0 || input.config.maxOutputTokens > 0;
  const minimumOutput =
    STORY_MEMORY_V2_OUTPUT_MIN_PER_CHAPTER * Math.max(1, input.batchSize);
  if (
    input.config.maxOutputTokens > 0 &&
    input.config.maxOutputTokens < minimumOutput
  ) {
    const strategy = input.batchSize > 1 ? 'preflight_split' : 'infeasible';
    return {
      messages: [],
      maxTokens,
      estimatedInputTokens: 0,
      contextWindow,
      safetyMargin: deriveDefaultSafetyMargin(contextWindow),
      softInputLimit: 0,
      burstInputLimit: 0,
      hardInputLimit: 0,
      capabilityKnown,
      fullPrompt: false,
      strategy,
      reason: `当前模型 max_output_tokens=${input.config.maxOutputTokens}，低于 Protocol V2 单批最低输出能力 ${minimumOutput}（context_window=${contextWindow}）。`,
      includedModuleIds: [],
      droppedModuleIds: input.materials.modules.map(module => module.id),
    };
  }

  if (!capabilityKnown || contextWindow <= 0) {
    const messages = buildMessagesFromObservationMaterials(input.materials);
    return {
      messages,
      maxTokens,
      estimatedInputTokens: estimateMessagesTokens(messages),
      contextWindow,
      safetyMargin: 0,
      softInputLimit: Number.MAX_SAFE_INTEGER,
      burstInputLimit: Number.MAX_SAFE_INTEGER,
      hardInputLimit: Number.MAX_SAFE_INTEGER,
      capabilityKnown,
      fullPrompt: true,
      strategy: 'full_prompt',
      reason: '',
      includedModuleIds: input.materials.modules.map(module => module.id),
      droppedModuleIds: [],
    };
  }

  const safetyMargin = deriveDefaultSafetyMargin(contextWindow);
  const demands = input.materials.modules.map(observationModuleToDemand);
  const allocation = allocateElasticStageContextBudget({
    contextWindow,
    reservedOutputTokens: maxTokens,
    safetyMargin,
    demands,
  });
  const trace = allocation.trace;
  if (!allocation.ok) {
    return {
      messages: [],
      maxTokens,
      estimatedInputTokens: trace.finalEstimatedInputTokens,
      contextWindow,
      safetyMargin,
      softInputLimit: trace.softInputLimit,
      burstInputLimit: trace.burstInputLimit,
      hardInputLimit: trace.hardInputLimit,
      capabilityKnown,
      fullPrompt: false,
      strategy: input.batchSize > 1 ? 'preflight_split' : 'infeasible',
      reason: `Protocol V2 Mandatory 材料约 ${trace.mandatoryTokens} tokens，超过当前模型单批可用输入上限 ${trace.hardInputLimit}（context_window=${contextWindow}，output reservation=${maxTokens}）。`,
      includedModuleIds: [],
      droppedModuleIds: input.materials.modules.map(module => module.id),
    };
  }

  const fullByAllocation = input.materials.modules.filter(module => {
    const allocated = allocation.allocations.get(module.id) || 0;
    const full = estimateTokens(module.text);
    return module.tier === 'mandatory' || allocated >= full;
  });
  const mandatory = fullByAllocation.filter(module => module.tier === 'mandatory');
  const optionalCandidates = sortWholeItemCandidates(
    fullByAllocation.filter(module => module.tier !== 'mandatory'),
  );
  const mandatoryTokens = mandatory.reduce(
    (sum, module) => sum + estimateTokens(module.text),
    0,
  );
  const packed = packWholeItems(
    optionalCandidates,
    Math.max(0, trace.burstInputLimit - mandatoryTokens),
    module => module.text,
  );
  const included = new Set([...mandatory, ...packed].map(module => module.id));
  let messages = buildMessagesFromObservationMaterials(input.materials, included);
  let estimatedInputTokens = estimateMessagesTokens(messages);

  const dropTier = (tier: StoryMemoryObservationPromptModule['tier']) => {
    input.materials.modules
      .filter(module => included.has(module.id) && module.tier === tier)
      .sort(
        (left, right) =>
          left.shrinkPriority - right.shrinkPriority ||
          left.id.localeCompare(right.id),
      )
      .forEach(module => {
        if (estimatedInputTokens <= trace.burstInputLimit) return;
        included.delete(module.id);
        messages = buildMessagesFromObservationMaterials(input.materials, included);
        estimatedInputTokens = estimateMessagesTokens(messages);
      });
  };
  if (estimatedInputTokens > trace.burstInputLimit) {
    dropTier('optional');
    dropTier('preferred_low');
  }
  const overBurst = estimatedInputTokens > trace.burstInputLimit;
  const overHard = estimatedInputTokens > trace.hardInputLimit;
  const strategy: StoryMemoryRequestPlanStrategy =
    overBurst || overHard
      ? input.batchSize > 1
        ? 'preflight_split'
        : 'infeasible'
      : 'full_prompt';
  return {
    messages: strategy === 'full_prompt' ? messages : [],
    maxTokens,
    estimatedInputTokens,
    contextWindow,
    safetyMargin,
    softInputLimit: trace.softInputLimit,
    burstInputLimit: trace.burstInputLimit,
    hardInputLimit: trace.hardInputLimit,
    capabilityKnown,
    fullPrompt: included.size === input.materials.modules.length,
    strategy,
    reason:
      strategy === 'full_prompt'
        ? included.size < input.materials.modules.length
          ? '已按 whole-item 规则丢弃低优先级材料。'
          : ''
        : `Protocol V2 最终输入约 ${estimatedInputTokens} tokens，超过 burst/hard 输入边界，需在发送前拆分。`,
    includedModuleIds: [...included],
    droppedModuleIds: input.materials.modules
      .filter(module => !included.has(module.id))
      .map(module => module.id),
  };
}

/** Plan Formatter/Fresh messages with the same V2 bounded output reservation. */
export function planStoryMemoryObservationMessages(input: {
  config: FrozenStoryMemoryLLMConfig;
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  batchSize: number;
}): StoryMemoryObservationRequestPlan {
  const contextWindow = Math.max(0, Math.floor(input.config.contextWindow || 0));
  const maxTokens = resolveStoryMemoryV2OutputBudget({
    batchSize: input.batchSize,
    modelMaxOutputTokens: input.config.maxOutputTokens,
  });
  const minimumOutput =
    STORY_MEMORY_V2_OUTPUT_MIN_PER_CHAPTER * Math.max(1, input.batchSize);
  const estimatedInputTokens = estimateMessagesTokens(input.messages);
  const safetyMargin = deriveDefaultSafetyMargin(contextWindow);
  const hardInputLimit =
    contextWindow > 0
      ? Math.max(0, contextWindow - maxTokens - safetyMargin)
      : Number.MAX_SAFE_INTEGER;
  const burstInputLimit =
    contextWindow > 0 ? Math.floor(hardInputLimit * 0.95) : Number.MAX_SAFE_INTEGER;
  const softInputLimit =
    contextWindow > 0 ? Math.floor(hardInputLimit * 0.8) : Number.MAX_SAFE_INTEGER;
  if (
    input.config.maxOutputTokens > 0 &&
    input.config.maxOutputTokens < minimumOutput
  ) {
    const strategy = input.batchSize > 1 ? 'preflight_split' : 'infeasible';
    return {
      messages: [],
      maxTokens,
      estimatedInputTokens,
      contextWindow,
      safetyMargin,
      softInputLimit,
      burstInputLimit,
      hardInputLimit,
      capabilityKnown:
        input.config.contextWindow > 0 || input.config.maxOutputTokens > 0,
      fullPrompt: false,
      strategy,
      reason: `当前模型 max_output_tokens=${input.config.maxOutputTokens}，低于 Protocol V2 单批最低输出能力 ${minimumOutput}（context_window=${contextWindow}）。`,
      includedModuleIds: [],
      droppedModuleIds: [],
    };
  }
  const fits = estimatedInputTokens <= burstInputLimit;
  const strategy: StoryMemoryRequestPlanStrategy = fits
    ? 'full_prompt'
    : input.batchSize > 1
      ? 'preflight_split'
      : 'infeasible';
  return {
    messages: fits ? input.messages : [],
    maxTokens,
    estimatedInputTokens,
    contextWindow,
    safetyMargin,
    softInputLimit,
    burstInputLimit,
    hardInputLimit,
    capabilityKnown:
      input.config.contextWindow > 0 || input.config.maxOutputTokens > 0,
    fullPrompt: true,
    strategy,
    reason: fits
      ? ''
      : `Protocol V2 Formatter/Fresh 输入约 ${estimatedInputTokens} tokens，超过发送前 burst 边界 ${burstInputLimit}。`,
    includedModuleIds: [],
    droppedModuleIds: [],
  };
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

// ---------------------------------------------------------------------------
// Elastic allocator path (governance plan §5)
// ---------------------------------------------------------------------------

/**
 * Map one prompt module to an elastic demand. Mandatory modules are never
 * reclaimable and never clipped; preferred/optional participate in the
 * 80% soft / 95% burst pool. `targetTokens` is the full text size so the
 * allocator hands back the full amount whenever the budget allows (fast path).
 */
function moduleToDemand(module: StoryMemoryPromptModule): ElasticContextDemand {
  const availableTokens = Math.max(0, estimateTokens(module.text));
  const requirement: ElasticDemandRequirement =
    module.tier === 'mandatory'
      ? 'mandatory'
      : module.tier === 'preferred_high' || module.tier === 'preferred_low'
        ? 'preferred'
        : 'optional';
  return {
    id: module.id,
    availableTokens,
    minTokens: requirement === 'mandatory' ? availableTokens : 0,
    targetTokens: availableTokens,
    maxTokens: availableTokens,
    priority: module.priority,
    relevance: module.relevance,
    requirement,
    reclaimable: requirement !== 'mandatory',
    shrinkPriority: module.shrinkPriority,
    burstPriority: module.burstPriority,
  };
}

export interface StoryMemoryElasticRequestPlan {
  /** Final messages to send (full prompt on fast path, compacted on shrink). */
  messages: ChatMessage[];
  maxTokens: number;
  estimatedInputTokens: number;
  contextWindow: number;
  safetyMargin: number;
  softInputLimit: number;
  burstInputLimit: number;
  hardInputLimit: number;
  capabilityKnown: boolean;
  /** true = full prompt fits the soft pool (no module clipped). */
  fullPrompt: boolean;
  strategy: StoryMemoryRequestPlanStrategy;
  reason: string;
  /** Module ids whose text was clipped (compact path diagnostics only). */
  clippedModuleIds: string[];
}

/**
 * Plan a Story Memory checkpoint request through the project's elastic
 * allocator. This is the primary input planner whenever a model capability is
 * known. On the fast path the assembled messages preserve the legacy
 * `buildStoryMemoryCheckpointMessages` semantics; only when the budget is
 * genuinely tight do Optional / Preferred-Low modules get clipped in
 * priority order, and the final messages are re-estimated before a send /
 * split decision.
 *
 * Never string-slices JSON; never clips the current-batch chapter bodies
 * (they are Mandatory).
 */
export function planStoryMemoryElasticRequest(input: {
  config: FrozenStoryMemoryLLMConfig;
  materials: StoryMemoryCheckpointMaterials;
  batchSize: number;
  legacyOutputTokens?: number;
}): StoryMemoryElasticRequestPlan {
  const contextWindow = Math.max(0, Math.floor(input.config.contextWindow || 0));
  const maxTokens = resolveStoryMemoryOutputBudget({
    contextWindow: input.config.contextWindow,
    maxOutputTokens: input.config.maxOutputTokens,
    legacyOutputTokens: input.legacyOutputTokens ?? 0,
    batchSize: input.batchSize,
  });
  const safetyMargin = deriveDefaultSafetyMargin(contextWindow);
  const capabilityKnown =
    input.config.contextWindow > 0 || input.config.maxOutputTokens > 0;

  const demands = input.materials.modules.map(moduleToDemand);
  const result = allocateElasticStageContextBudget({
    contextWindow,
    reservedOutputTokens: maxTokens,
    safetyMargin,
    demands,
  });
  const trace = result.trace;

  // Mandatory overflow → split (multi-chapter) or infeasible (single chapter).
  // No HTTP is consumed: caller splits before fetch().
  if (!result.ok) {
    const strategy: StoryMemoryRequestPlanStrategy =
      input.batchSize > 1 ? 'preflight_split' : 'infeasible';
    return {
      messages: [],
      maxTokens,
      estimatedInputTokens: trace.finalEstimatedInputTokens,
      contextWindow,
      safetyMargin,
      softInputLimit: trace.softInputLimit,
      burstInputLimit: trace.burstInputLimit,
      hardInputLimit: trace.hardInputLimit,
      capabilityKnown,
      fullPrompt: false,
      strategy,
      reason:
        result.reason === 'mandatory_overflow'
          ? `Mandatory Story Memory 材料（协议/Schema/当前章节正文）需要约 ${trace.mandatoryTokens} 词元，已超过模型硬上限 ${trace.hardInputLimit}（context_window=${contextWindow}，输出 reservation=${maxTokens}）。`
          : '模型上下文容量无效，无法规划 Story Memory 请求。',
      clippedModuleIds: [],
    };
  }

  // Build clipped module texts from allocations. Mandatory verbatim; preferred
  // / optional clipped to their allocation when below availableTokens.
  const clipped = new Map<string, string>();
  const clippedModuleIds: string[] = [];
  for (const module of input.materials.modules) {
    const allocated = result.allocations.get(module.id) || 0;
    if (module.tier === 'mandatory') {
      clipped.set(module.id, module.text);
    } else if (allocated <= 0) {
      clipped.set(module.id, '');
      if (module.text) clippedModuleIds.push(module.id);
    } else {
      const text = clipTextToTokenBudget(module.text, allocated);
      clipped.set(module.id, text);
      if (estimateTokens(text) < estimateTokens(module.text)) {
        clippedModuleIds.push(module.id);
      }
    }
  }

  const messages = buildMessagesFromMaterials(input.materials, clipped);
  const estimatedInputTokens = estimateMessagesTokens(messages);
  const fullPrompt = clippedModuleIds.length === 0;

  // Final re-estimate gate (§5.9): the allocator keeps us ≤95% in theory, but
  // wrapping overhead can nudge the rebuilt messages past the hard limit. If
  // after clipping we still exceed the burst band, multi-chapter batches must
  // split; single-chapter is infeasible (do NOT silently clip Mandatory).
  const overHard = estimatedInputTokens > trace.hardInputLimit;
  const overBurst = estimatedInputTokens > trace.burstInputLimit;
  let strategy: StoryMemoryRequestPlanStrategy = 'full_prompt';
  let reason = '';
  if (overHard) {
    strategy = input.batchSize > 1 ? 'preflight_split' : 'infeasible';
    reason = `最终 Story Memory 请求需要约 ${estimatedInputTokens} 词元输入，已超过模型硬上限 ${trace.hardInputLimit}（context_window=${contextWindow}，输出 reservation=${maxTokens}）。`;
  } else if (overBurst && input.batchSize > 1) {
    // Above burst band but within hard: keep, but flag for awareness. Auto
    // tasks aim to stay ≤ burst; the outer coordinator may still send if it
    // is the final attempt of a logical batch.
    strategy = 'full_prompt';
    reason = `Story Memory 请求约 ${estimatedInputTokens} 词元输入，略高于建议 burst 限额 ${trace.burstInputLimit}，仍在硬上限内。`;
  } else if (clippedModuleIds.length > 0) {
    reason = `已按弹性预算压缩 ${clippedModuleIds.length} 个非必需模块（Optional / Preferred Low）。`;
  }

  return {
    messages,
    maxTokens,
    estimatedInputTokens,
    contextWindow,
    safetyMargin,
    softInputLimit: trace.softInputLimit,
    burstInputLimit: trace.burstInputLimit,
    hardInputLimit: trace.hardInputLimit,
    capabilityKnown,
    fullPrompt,
    strategy,
    reason,
    clippedModuleIds,
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
