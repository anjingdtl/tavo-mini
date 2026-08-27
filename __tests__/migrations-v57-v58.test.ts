import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import {
  LEGACY_EMPTY_LLM_CAPABILITY_DEFAULTS,
  migrateV57ToV58,
} from '../src/services/migrations/v57-to-v58';

describe('Schema 57 → 58 model capability sentinel migration', () => {
  it('converts only the untouched legacy empty row to AUTO/unknown', async () => {
    const db = await createCanonInMemoryDb();
    try {
      await db.executeSql(
        `INSERT INTO llm_config
          (name, base_url, api_key, model_name, is_active, context_window, max_output_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          'legacy empty',
          '',
          '',
          '',
          1,
          LEGACY_EMPTY_LLM_CAPABILITY_DEFAULTS.contextWindow,
          LEGACY_EMPTY_LLM_CAPABILITY_DEFAULTS.maxOutputTokens,
        ],
      );
      await db.executeSql(
        `INSERT INTO llm_config
          (name, base_url, api_key, model_name, is_active, context_window, max_output_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          'configured model',
          'https://example.test/v1',
          '',
          'model-a',
          0,
          LEGACY_EMPTY_LLM_CAPABILITY_DEFAULTS.contextWindow,
          LEGACY_EMPTY_LLM_CAPABILITY_DEFAULTS.maxOutputTokens,
        ],
      );
      await db.executeSql(
        `INSERT INTO llm_config
          (name, base_url, api_key, model_name, is_active, context_window, max_output_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ['custom capability', '', '', '', 0, 32768, 0],
      );

      await migrateV57ToV58(db as any);

      const result = await db.executeSql(
        'SELECT name, base_url, model_name, context_window, max_output_tokens FROM llm_config ORDER BY id',
      );
      expect(result[0].rows.raw()).toEqual([
        {
          name: 'legacy empty',
          base_url: '',
          model_name: '',
          context_window: 0,
          max_output_tokens: 0,
        },
        {
          name: 'configured model',
          base_url: 'https://example.test/v1',
          model_name: 'model-a',
          context_window: 4096,
          max_output_tokens: 4000,
        },
        {
          name: 'custom capability',
          base_url: '',
          model_name: '',
          context_window: 32768,
          max_output_tokens: 0,
        },
      ]);
    } finally {
      db.close();
    }
  });

  it('is idempotent after the sentinel has been written', async () => {
    const db = await createCanonInMemoryDb();
    try {
      await db.executeSql(
        `INSERT INTO llm_config
          (name, base_url, api_key, model_name, is_active, context_window, max_output_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ['empty', '', '', '', 1, 0, 0],
      );
      await migrateV57ToV58(db as any);
      await migrateV57ToV58(db as any);
      const result = await db.executeSql(
        'SELECT context_window, max_output_tokens FROM llm_config ORDER BY id',
      );
      expect(result[0].rows.raw()).toEqual([
        { context_window: 0, max_output_tokens: 0 },
      ]);
    } finally {
      db.close();
    }
  });
});
