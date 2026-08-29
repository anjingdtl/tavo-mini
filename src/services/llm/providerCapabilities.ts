import type {
  LLMCompletionUsageSemantics,
  LLMOutputBudgetTrace,
  LLMProviderCapabilitySupport,
  LLMProviderType,
  ReasoningEffort,
} from './types';

export type LLMReasoningEffortMapping = Readonly<
  Record<ReasoningEffort, ReasoningEffort>
>;

export interface LLMProviderReasoningCapability {
  supportsThinking: LLMProviderCapabilitySupport;
  supportsReasoningEffort: LLMProviderCapabilitySupport;
  reasoningEffortMapping: LLMReasoningEffortMapping | null;
  reportsReasoningTokens: LLMProviderCapabilitySupport;
  completionUsageSemantics: LLMCompletionUsageSemantics;
}

export interface LLMProviderCapability
  extends LLMProviderReasoningCapability {
  adapterId: string;
  providerWireMaxOutput: number | null;
}

/**
 * Provider capability adapters sit between the product budget and the wire
 * protocol.  `max_output_tokens` remains the user's configured logical
 * capability; an adapter is allowed to translate it to the value accepted by
 * the selected provider/model endpoint.  No writing stage is allowed to make
 * that decision independently.
 */
export interface LLMProviderCapabilityAdapter {
  readonly id: string;
  matches(config: ProviderCapabilityConfig): boolean;
  /**
   * Provider maximum for the `max_tokens` wire field. `null` means the
   * provider does not advertise a known maximum and the configured value is
   * preserved.
   */
  resolveMaxOutputTokens(config: ProviderCapabilityConfig): number | null;
  /** Resolve explicit reasoning/usage protocol capability for this adapter. */
  resolveReasoningCapability(
    config: ProviderCapabilityConfig,
  ): LLMProviderReasoningCapability;
}

export type ProviderCapabilityConfig = {
  provider_type: LLMProviderType;
  model_name: string;
  url: string;
  context_window?: number | null;
  max_output_tokens?: number | null;
  /** Optional explicit adapter selected by a future persisted configuration. */
  provider_adapter_id?: string | null;
};

export interface LLMOutputBudgetResolution {
  requestedMaxTokens: number;
  wireMaxTokens: number;
  providerLimit: number | null;
  adapterId: string;
  adapted: boolean;
  trace: LLMOutputBudgetTrace;
}

export type ModelOutputCapabilitySource =
  | 'configured'
  | 'elastic_context'
  | 'unknown';

export interface ModelOutputCapabilityResolution {
  /**
   * The logical model output capability. `null` means that neither the
   * persisted capability nor a usable context window was supplied.
   */
  maxOutputTokens: number | null;
  source: ModelOutputCapabilitySource;
}

/**
 * Only a missing logical output setting uses this ratio. It is an elastic
 * policy, not a fixed token ceiling: the result scales with the selected
 * model's declared context window and is still passed through the provider
 * capability adapter below.
 */
export const ELASTIC_OUTPUT_RESERVE_RATIO = 0.2;

/**
 * BigModel's OpenAI-compatible v4 endpoint rejects values above this external
 * API limit. This is provider contract data, deliberately isolated here from
 * all context allocators and writing stages. It is not a product/context cap.
 */
const BIGMODEL_V4_MAX_OUTPUT_TOKENS = 131_072;

const UNKNOWN_REASONING_CAPABILITY: LLMProviderReasoningCapability = {
  supportsThinking: 'unknown',
  supportsReasoningEffort: 'unknown',
  reasoningEffortMapping: null,
  reportsReasoningTokens: 'unknown',
  completionUsageSemantics: 'unknown',
};

const BIGMODEL_REASONING_EFFORT_MAPPING: LLMReasoningEffortMapping = {
  low: 'low',
  // BigModel's current GLM-5.3 contract exposes low/high/max. Keep the
  // product's historical medium tier explicit by mapping it to high; do not
  // claim that the provider accepts a fourth wire enum.
  medium: 'high',
  high: 'high',
  max: 'max',
};

const BIGMODEL_REASONING_CAPABILITY: LLMProviderReasoningCapability = {
  supportsThinking: 'supported',
  supportsReasoningEffort: 'supported',
  reasoningEffortMapping: BIGMODEL_REASONING_EFFORT_MAPPING,
  reportsReasoningTokens: 'supported',
  completionUsageSemantics: 'completion_tokens_includes_reasoning',
};

const DEEPSEEK_REASONING_CAPABILITY: LLMProviderReasoningCapability = {
  supportsThinking: 'supported',
  supportsReasoningEffort: 'supported',
  reasoningEffortMapping: {
    low: 'low',
    medium: 'medium',
    high: 'high',
    max: 'max',
  },
  reportsReasoningTokens: 'supported',
  completionUsageSemantics: 'completion_tokens_includes_reasoning',
};

/** Exact model registrations; model-name substrings never grant capability. */
const BIGMODEL_REASONING_MODELS = new Set([
  'glm-5.2',
  'glm-5.2-flash',
  'glm-5.3',
  'glm-5.3-flash',
]);

const DEEPSEEK_REASONING_MODELS = new Set(['deepseek-v4-flash']);

function normalizeModelName(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function isHost(urlValue: unknown, expectedHost: string): boolean {
  try {
    return new URL(String(urlValue ?? '')).hostname.toLowerCase() === expectedHost;
  } catch {
    return false;
  }
}

function resolveBigModelReasoningCapability(
  config: ProviderCapabilityConfig,
): LLMProviderReasoningCapability {
  return BIGMODEL_REASONING_MODELS.has(normalizeModelName(config.model_name))
    ? BIGMODEL_REASONING_CAPABILITY
    : UNKNOWN_REASONING_CAPABILITY;
}

const BIGMODEL_V4_ADAPTER: LLMProviderCapabilityAdapter = {
  id: 'open.bigmodel.cn-v4',
  matches: config => {
    if (config.provider_type !== 'openai_compatible') return false;
    try {
      const url = new URL(config.url);
      return (
        url.hostname.toLowerCase() === 'open.bigmodel.cn' &&
        /(?:^|\/)v4(?:\/|$)/i.test(url.pathname)
      );
    } catch {
      return false;
    }
  },
  resolveMaxOutputTokens: () => BIGMODEL_V4_MAX_OUTPUT_TOKENS,
  resolveReasoningCapability: resolveBigModelReasoningCapability,
};

const GENERIC_OPENAI_COMPATIBLE_ADAPTER: LLMProviderCapabilityAdapter = {
  id: 'openai-compatible-generic',
  matches: config => config.provider_type === 'openai_compatible',
  resolveMaxOutputTokens: () => null,
  resolveReasoningCapability: () => UNKNOWN_REASONING_CAPABILITY,
};

const ADAPTERS: readonly LLMProviderCapabilityAdapter[] = [
  BIGMODEL_V4_ADAPTER,
  GENERIC_OPENAI_COMPATIBLE_ADAPTER,
];

export function normalizePositiveCapability(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(1, Math.floor(parsed));
}

// Keep the private name local to this module so old callers cannot accidentally
// treat a zero/NaN capability as a real model limit.
const positiveInteger = normalizePositiveCapability;

/**
 * Resolve a model's logical output capability in one place.
 *
 * `configuredMaxOutputTokens` is an explicit provider/model capability when
 * it is positive. A blank/zero value is the documented AUTO sentinel: derive
 * the reservation from the same model's current context window. No product
 * default token count is allowed here; if the context is also unknown the
 * result stays unknown and callers must fail closed or ask for configuration.
 */
export function resolveModelOutputCapability(input: {
  contextWindow?: unknown;
  configuredMaxOutputTokens?: unknown;
}): ModelOutputCapabilityResolution {
  const configured = normalizePositiveCapability(
    input.configuredMaxOutputTokens,
  );
  if (configured != null) {
    return { maxOutputTokens: configured, source: 'configured' };
  }
  const derived = deriveElasticOutputReservation(input.contextWindow);
  return derived == null
    ? { maxOutputTokens: null, source: 'unknown' }
    : { maxOutputTokens: derived, source: 'elastic_context' };
}

export function requireModelContextWindow(
  value: unknown,
  label = 'context_window',
): number {
  const contextWindow = normalizePositiveCapability(value);
  if (contextWindow == null) {
    throw new Error(
      `${label} 未配置或无效；请填写模型文档声明的上下文窗口，禁止使用固定默认值。`,
    );
  }
  return contextWindow;
}

export function requireModelMaxOutputTokens(input: {
  contextWindow?: unknown;
  configuredMaxOutputTokens?: unknown;
  label?: string;
}): number {
  const resolved = resolveModelOutputCapability(input);
  if (resolved.maxOutputTokens == null) {
    throw new Error(
      `${input.label ?? 'max_output_tokens'} 未配置且无法从 context_window 弹性推导；请填写模型 context_window。`,
    );
  }
  return resolved.maxOutputTokens;
}

export function deriveElasticOutputReservation(
  contextWindow: unknown,
): number | null {
  const window = positiveInteger(contextWindow);
  if (window == null) return null;
  return Math.max(1, Math.floor(window * ELASTIC_OUTPUT_RESERVE_RATIO));
}

function resolveAdapter(
  config: ProviderCapabilityConfig,
): LLMProviderCapabilityAdapter {
  const explicitId = String(config.provider_adapter_id ?? '').trim();
  if (explicitId) {
    const explicit = ADAPTERS.find(adapter => adapter.id === explicitId);
    if (explicit) return explicit;
  }
  return (
    ADAPTERS.find(adapter => adapter.matches(config)) ??
    GENERIC_OPENAI_COMPATIBLE_ADAPTER
  );
}

/**
 * Resolve every provider capability used by one logical request. Capability
 * is explicit and exact: an unknown gateway/model remains unknown, while the
 * official DeepSeek endpoint is registered separately from generic gateways.
 */
export function resolveProviderCapability(
  config: ProviderCapabilityConfig,
): LLMProviderCapability {
  const adapter = resolveAdapter(config);
  const explicitAdapterId = String(config.provider_adapter_id ?? '').trim();
  const reasoningCapability =
    !explicitAdapterId &&
    config.provider_type === 'openai_compatible' &&
    DEEPSEEK_REASONING_MODELS.has(normalizeModelName(config.model_name)) &&
    isHost(config.url, 'api.deepseek.com')
      ? DEEPSEEK_REASONING_CAPABILITY
      : adapter.resolveReasoningCapability(config);
  return {
    adapterId: adapter.id,
    providerWireMaxOutput: positiveInteger(
      adapter.resolveMaxOutputTokens(config),
    ),
    ...reasoningCapability,
  };
}

export function resolveProviderReasoningEffort(input: {
  capability: Pick<
    LLMProviderCapability,
    'supportsReasoningEffort' | 'reasoningEffortMapping'
  >;
  thinking?: { type: 'enabled' | 'disabled' } | null;
  requestedEffort?: unknown;
}): ReasoningEffort | null {
  if (
    input.thinking?.type !== 'enabled' ||
    input.capability.supportsReasoningEffort !== 'supported' ||
    !isReasoningEffort(input.requestedEffort)
  ) {
    return null;
  }
  return input.capability.reasoningEffortMapping?.[input.requestedEffort] ?? null;
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    value === 'low' || value === 'medium' || value === 'high' || value === 'max'
  );
}

/** Resolve provider-specific wire capability for one logical request. */
export function resolveProviderOutputBudget(input: {
  config: ProviderCapabilityConfig;
  requestedMaxTokens?: number | null;
}): LLMOutputBudgetResolution {
  const adapter = resolveAdapter(input.config);
  const requested =
    positiveInteger(input.requestedMaxTokens) ??
    resolveModelOutputCapability({
      contextWindow: input.config.context_window,
      configuredMaxOutputTokens: input.config.max_output_tokens,
    }).maxOutputTokens;
  if (requested == null) {
    throw new Error(
      'LLM 输出预算未解析：请提供本次请求 max_tokens、模型 max_output_tokens 或 context_window。',
    );
  }
  const providerLimit = positiveInteger(
    adapter.resolveMaxOutputTokens(input.config),
  );
  const wireMaxTokens = Math.max(
    1,
    providerLimit == null ? requested : Math.min(requested, providerLimit),
  );
  const adapted = wireMaxTokens !== requested;
  return {
    requestedMaxTokens: requested,
    wireMaxTokens,
    providerLimit,
    adapterId: adapter.id,
    adapted,
    trace: {
      requestedMaxTokens: requested,
      wireMaxTokens,
      providerLimit,
      adapterId: adapter.id,
      adapted,
    },
  };
}

/**
 * Convenience for budget planners. It applies the same adapter as the
 * provider transport, so input packing reserves the actual wire output and
 * does not waste the entire window on an unsupported configured ceiling.
 */
export function resolveEffectiveMaxOutputTokens(input: {
  providerType?: LLMProviderType | string | null;
  modelName?: string | null;
  url?: string | null;
  contextWindow?: number | null;
  configuredMaxOutputTokens?: number | null;
  requestedMaxTokens?: number | null;
  providerAdapterId?: string | null;
}): number {
  return resolveProviderOutputBudget({
    config: {
      provider_type:
        (input.providerType as LLMProviderType | undefined) ??
        'openai_compatible',
      model_name: String(input.modelName ?? ''),
      url: String(input.url ?? ''),
      context_window: input.contextWindow,
      max_output_tokens: input.configuredMaxOutputTokens,
      provider_adapter_id: input.providerAdapterId,
    },
    requestedMaxTokens: input.requestedMaxTokens,
  }).wireMaxTokens;
}
