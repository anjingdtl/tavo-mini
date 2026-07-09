export type LocalModelStatus =
  | 'importing'
  | 'validating'
  | 'ready'
  | 'incompatible'
  | 'corrupted'
  | 'missing'
  | 'error'
  | 'unavailable';

export type LocalModelBackend = 'auto' | 'gpu' | 'cpu' | 'npu';

export type PromptTemplate = 'chatml' | 'llama3' | 'alpaca' | 'qwen' | 'phi' | 'mistral' | 'custom';

export type LocalModelProviderEngine = 'llama_cpp';

export interface LocalModel {
  id: string;
  display_name: string;
  original_filename: string;
  relative_path: string;
  file_size: number;
  sha256: string;
  status: LocalModelStatus;
  backend_preference: LocalModelBackend;
  validated_backend: 'gpu' | 'cpu' | null;
  context_length: number | null;
  max_output_tokens: number | null;
  load_time_ms: number | null;
  first_token_ms: number | null;
  tokens_per_second: number | null;
  imported_at: string;
  last_used_at: string | null;
  last_validated_at: string | null;
  error_code: string | null;
  error_message: string | null;
  prompt_template: PromptTemplate;
  actual_backend: string | null;
}
