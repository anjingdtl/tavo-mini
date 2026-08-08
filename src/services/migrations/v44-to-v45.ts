/**
 * Schema 44 → 45: official hidden reasoning token observability.
 *
 * `pipeline_stage_attempts` already stores input/output/total usage. The
 * nullable column records DeepSeek's completion_tokens_details.reasoning_tokens
 * when present; older gateways and historical attempts remain NULL.
 */
import type SQLite from 'react-native-sqlite-storage';
import type { SqlStatement } from '../database/transaction';
import { executeTransaction } from '../database/transaction';
import { tableColumns } from './helpers';

export const REASONING_TOKENS_COLUMN = 'reasoning_tokens';

export function buildV44toV45Statements(): SqlStatement[] {
  return [
    {
      sql: `ALTER TABLE pipeline_stage_attempts ADD COLUMN ${REASONING_TOKENS_COLUMN} INTEGER`,
    },
  ];
}

/** Idempotent migration for recorded-44 databases with or without drift. */
export async function migrateV44ToV45(
  db: SQLite.SQLiteDatabase,
): Promise<void> {
  const columns = await tableColumns(db, 'pipeline_stage_attempts');
  if (columns.has(REASONING_TOKENS_COLUMN)) return;
  await executeTransaction(db, buildV44toV45Statements(), {
    faultDomain: 'migration',
  });
}
