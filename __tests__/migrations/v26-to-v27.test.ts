/* eslint-env jest */

import { SCHEMA_VERSION } from '../../src/services/migrations';
import { buildV26toV27Statements } from '../../src/services/migrations/v26-to-v27';

describe('schema 26 → 27 local LLM removal', () => {
  it('targets the current schema version', () => {
    expect(SCHEMA_VERSION).toBe(36);
  });

  it('keeps only online configs and preserves their fields', () => {
    const statements = buildV26toV27Statements();
    const sql = statements.map(s => s.sql).join('\n');

    // Local model configurations are dropped, not converted to blank placeholders.
    expect(sql).toContain("WHERE provider_type = 'openai_compatible'");
    expect(sql).not.toContain("provider_type = 'llama_cpp'");
    expect(sql).not.toContain("CASE WHEN provider_type = 'llama_cpp'");

    // Online config fields are copied unchanged, including api_key so the
    // repository layer can migrate any legacy table-stored key to secure storage.
    expect(sql).toContain('base_url, api_key, model_name, is_active');
    expect(sql).toContain('SELECT id, name, base_url, api_key, model_name, is_active');
  });

  it('seeds a blank default config when no online config exists', () => {
    const statements = buildV26toV27Statements();
    const sql = statements.map(s => s.sql).join('\n');

    expect(sql).toContain("SELECT '默认配置', 'openai_compatible', '', '', '', 1, 4096, 4000");
    expect(sql).toContain('WHERE NOT EXISTS (SELECT 1 FROM llm_config_v27)');
  });

  it('drops the local model inventory table', () => {
    const statements = buildV26toV27Statements();
    const sql = statements.map(s => s.sql).join('\n');

    expect(sql).toContain('DROP TABLE IF EXISTS local_llm_models');
    expect(sql).toContain('DROP TABLE llm_config');
    expect(sql).toContain('ALTER TABLE llm_config_v27 RENAME TO llm_config');
  });
});
