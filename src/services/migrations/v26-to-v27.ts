import type { SqlStatement } from '../database/transaction';

/**
 * Schema 26 → 27: remove the on-device GGUF runtime and its persisted model
 * inventory. Local-only configurations are dropped entirely; online
 * configurations keep every field (including api_key so it can be migrated to
 * secure storage by the repository layer). Settings such as context automation
 * are untouched.
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
    // Keep only online configs. Their ids are preserved so secure-storage API
    // keys remain addressable after the migration.
    {
      sql: `INSERT INTO llm_config_v27 (
        id, name, base_url, api_key, model_name, is_active, provider_type,
        context_window, max_output_tokens
      )
      SELECT id, name, base_url, api_key, model_name, is_active,
        'openai_compatible', context_window, max_output_tokens
      FROM llm_config
      WHERE provider_type = 'openai_compatible'`,
    },
    // If every previous config was a local model, seed a blank default so the
    // user is never left without an active LLM configuration.
    {
      sql: `INSERT INTO llm_config_v27 (
        name, provider_type, base_url, api_key, model_name, is_active,
        context_window, max_output_tokens
      )
      SELECT '默认配置', 'openai_compatible', '', '', '', 1, 4096, 4000
      WHERE NOT EXISTS (SELECT 1 FROM llm_config_v27)`,
    },
    { sql: 'DROP TABLE llm_config' },
    { sql: 'ALTER TABLE llm_config_v27 RENAME TO llm_config' },
    { sql: 'DROP TABLE IF EXISTS local_llm_models' },
  ];
}
