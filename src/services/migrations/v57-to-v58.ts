/**
 * Schema 57 → 58: remove legacy model-capability defaults.
 *
 * Older installations seeded an empty LLM row with context_window=4096 and
 * max_output_tokens=4000. Those numbers were never a model declaration, but
 * they became indistinguishable from one after persistence. Convert only rows
 * that are still completely unconfigured; configured models keep their saved
 * capabilities byte-for-byte. Zero is the current AUTO/unknown sentinel and
 * the runtime derives output from the model's own context window.
 */
import type SQLite from 'react-native-sqlite-storage';
import { executeTransaction } from '../database/transaction';

export const LEGACY_EMPTY_LLM_CAPABILITY_DEFAULTS = {
  contextWindow: 4096,
  maxOutputTokens: 4000,
} as const;

export async function migrateV57ToV58(
  db: SQLite.SQLiteDatabase,
): Promise<void> {
  // Some migration tests intentionally start from a partial schema. A
  // capability cleanup has nothing to do when the table does not exist yet;
  // normal schema bootstrap creates it with AUTO sentinels.
  const [tableResult] = await db.executeSql(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name = ?`,
    ['llm_config'],
  );
  if (!tableResult.rows || tableResult.rows.length === 0) {
    return;
  }

  await executeTransaction(
    db,
    [
      {
        sql: `UPDATE llm_config
          SET context_window = 0, max_output_tokens = 0
          WHERE COALESCE(TRIM(base_url), '') = ''
            AND COALESCE(TRIM(model_name), '') = ''
            AND COALESCE(TRIM(api_key), '') = ''
            AND context_window = ?
            AND max_output_tokens = ?`,
        params: [
          LEGACY_EMPTY_LLM_CAPABILITY_DEFAULTS.contextWindow,
          LEGACY_EMPTY_LLM_CAPABILITY_DEFAULTS.maxOutputTokens,
        ],
      },
    ],
    { faultDomain: 'migration' },
  );
}
