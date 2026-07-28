export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMResult {
  /** Official model output (message.content). Never filled from reasoning. */
  text: string | null;
  /** Optional chain-of-thought (message.reasoning_content). Must not enter business text. */
  reasoningText?: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  metrics?: LLMRequestMetrics;
  errorCode?: string;
  finishReason?: string | null;
  /**
   * Categorical reason for a null `text` (Spec §1 / S1). Present only when the
   * provider could not produce business text. Lets Canon analysis distinguish
   * "model does not support JSON" (a dead end) from "reasoning burned the
   * output budget" (retryable with more tokens) from "gateway returned an
   * error inside a 200 body" (a real provider error). Optional so every
   * existing caller stays unaffected.
   */
  emptyReason?:
    | 'length'
    | 'content_filter'
    | 'reasoning_only'
    | 'no_choices'
    | 'empty';
  rawUsage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface LLMGenerateOptions {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  responseFormat?: 'json_object';
  scenario?: string;
  projectId?: number;
  taskId?: string;
  queueClass?: LLMQueueClass;
  queuePriority?: LLMQueuePriority;
  onQueueState?: (state: LLMQueueState) => void;
  onProgress?: (metrics: LLMRequestMetrics) => void;
  requestConfig?: LLMRequestConfig;
}

export type LLMQueueClass =
  | 'normal'
  | 'pipeline'
  | 'background'
  | 'canon_analysis'
  | 'connection'
  | 'local';
export type LLMQueuePriority = 'manual' | 'normal' | 'background';
export type LLMQueueState = 'queued' | 'running' | 'cancelled';

export interface LLMRequestMetrics {
  taskId?: string;
  startedAt: number;
  firstTokenAt?: number;
  lastProgressAt: number;
}

export type LLMProviderType = 'openai_compatible' | 'llama_cpp';

export interface LLMRequestConfig {
  id?: number;
  name?: string;
  provider_type: LLMProviderType;
  api_key: string;
  model_name: string;
  url: string;
  local_model_id?: string;
  local_model_path?: string;
  local_backend?: 'auto' | 'gpu' | 'cpu';
  context_window?: number;
  max_output_tokens?: number;
  allow_insecure_lan_http?: boolean;
}
