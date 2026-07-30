import type { SqlStatement } from '../database/transaction';

/**
 * Schema 26 → 27: remove the on-device GGUF runtime and its persisted model
 * inventory. Local configurations become inactive, blank online placeholders
 * so users can enter an API endpoint without losing their configuration name.
 */
export function buildV26toV27Statements(): SqlStatement[] {
  return [
    {
      sql: `CREATE TABLE llm_config_v27 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL DEFAULT '',
        base_url TEXT NOT NULL DEFAULT '',
        api_key TEXT NOT NULL DEFAULT '',
        model_name TEXT NOT NULL DEFAULT '',
        is_active INTEGER NOT NULL DEFAULT 0,
        provider_type TEXT NOT NULL DEFAULT 'openai_compatible',
        context_window INTEGER NOT NULL DEFAULT 4096,
        max_output_tokens INTEGER NOT NULL DEFAULT 4000
      )`,
    },
    {
      sql: `INSERT INTO llm_config_v27 (
        id, name, base_url, api_key, model_name, is_active, provider_type,
        context_window, max_output_tokens
      )
      SELECT id, name,
        CASE WHEN provider_type = 'llama_cpp' THEN '' ELSE base_url END,
        api_key,
        CASE WHEN provider_type = 'llama_cpp' THEN '' ELSE model_name END,
        CASE WHEN provider_type = 'llama_cpp' THEN 0 ELSE is_active END,
        'openai_compatible', context_window, max_output_tokens
      FROM llm_config`,
    },
    { sql: 'DROP TABLE llm_config' },
    { sql: 'ALTER TABLE llm_config_v27 RENAME TO llm_config' },
    { sql: 'DROP TABLE IF EXISTS local_llm_models' },
  ];
}
