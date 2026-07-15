export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMResult {
  text: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  metrics?: LLMRequestMetrics;
  errorCode?: string;
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
