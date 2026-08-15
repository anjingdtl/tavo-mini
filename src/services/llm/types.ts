export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Optional transport lifecycle hooks used by callers that need to account for
 * every real HTTP dispatch.  The hooks deliberately expose only request kind,
 * response status and provider request id; they never receive headers,
 * credentials, prompt text or response bodies.
 */
export interface LLMPhysicalRequestBeforeEvent {
  kind: string;
}

export interface LLMPhysicalRequestAfterEvent {
  kind: string;
  outcome: 'response' | 'transport_error';
  httpStatus?: number;
  providerRequestId?: string;
  error?: unknown;
}

export interface LLMPhysicalRequestHooks {
  beforeRequest?: (
    event: LLMPhysicalRequestBeforeEvent,
  ) => void | Promise<void>;
  afterRequest?: (
    event: LLMPhysicalRequestAfterEvent,
  ) => void | Promise<void>;
}

export interface LLMResult {
  /** Official model output (message.content). Never filled from reasoning. */
  text: string | null;
  /** Optional chain-of-thought (message.reasoning_content). Must not enter business text. */
  reasoningText?: string | null;
  /** Official hidden reasoning token count, when the provider reports it. */
  reasoningTokens?: number | null;
  /** Visible output token count derived from official usage, when available. */
  visibleOutputTokens?: number | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /**
   * Provider-reported prompt cache hit token count (DeepSeek
   * `prompt_cache_hit_tokens`). `null` when the provider did not report it;
   * never fabricated as 0. Observation-only metadata — must not influence
   * pipeline branching, retry decisions or budget gates.
   */
  promptCacheHitTokens?: number | null;
  /**
   * Provider-reported prompt cache miss token count (DeepSeek
   * `prompt_cache_miss_tokens`). Same contract as `promptCacheHitTokens`.
   */
  promptCacheMissTokens?: number | null;
  metrics?: LLMRequestMetrics;
  errorCode?: string;
  finishReason?: string | null;
  /**
   * Categorical reason for a null `text` (Spec §1 / S1). Present only when the
   * provider could not produce business text. Lets Canon analysis distinguish
   * "model does not support JSON" (a dead end) from "content is empty while
   * reasoning_content exists" (a structured-output failure whose cause still
   * needs finishReason) and from "gateway returned an error inside a 200
   * body" (a real provider error). `reasoning_only` does not by itself prove
   * that the output budget was exhausted. Optional so every existing caller
   * stays unaffected.
   */
  emptyReason?:
    | 'length'
    | 'content_filter'
    | 'reasoning_only'
    | 'no_choices'
    | 'empty';
  rawUsage?: {
    prompt_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
}

/** DeepSeek-style reasoning intensity. Thinking remains enabled separately. */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'max';

export interface LLMGenerateOptions {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  responseFormat?: 'json_object';
  /** Optional OpenAI-compatible extension; omitted for existing callers. */
  thinking?: { type: 'enabled' | 'disabled' };
  /** Sent only when the selected provider capability explicitly supports it. */
  reasoningEffort?: ReasoningEffort;
  scenario?: string;
  projectId?: number;
  taskId?: string;
  queueClass?: LLMQueueClass;
  queuePriority?: LLMQueuePriority;
  onQueueState?: (state: LLMQueueState) => void;
  onProgress?: (metrics: LLMRequestMetrics) => void;
  physicalRequestHooks?: LLMPhysicalRequestHooks;
  requestConfig?: LLMRequestConfig;
}

export type LLMQueueClass =
  | 'normal'
  | 'pipeline'
  | 'background'
  | 'canon_analysis'
  | 'continuation_style_analysis'
  | 'connection';
export type LLMQueuePriority = 'manual' | 'normal' | 'background';
export type LLMQueueState = 'queued' | 'running' | 'cancelled';

export interface LLMRequestMetrics {
  taskId?: string;
  startedAt: number;
  firstTokenAt?: number;
  lastProgressAt: number;
}

export type LLMProviderType = 'openai_compatible';

export interface LLMRequestConfig {
  id?: number;
  name?: string;
  provider_type: LLMProviderType;
  api_key: string;
  model_name: string;
  url: string;
  context_window?: number;
  max_output_tokens?: number;
  allow_insecure_lan_http?: boolean;
  /**
   * Fallback thinking control honored by the OpenAI-compatible provider when
   * the per-call options.thinking is absent. Defense-in-depth so a caller
   * that attaches thinking to the request config still has the intent reach
   * the wire; the per-call option remains the authoritative path.
   */
  thinking?: { type: 'enabled' | 'disabled' };
}
