import type SQLite from 'react-native-sqlite-storage';
import { executeTransaction } from '../database/transaction';
import { tableColumns } from './helpers';

/** Schema 61 → 62: persist the explicit image-input capability preference. */
export async function migrateV61ToV62(
  db: SQLite.SQLiteDatabase,
): Promise<void> {
  const columns = await tableColumns(db, 'llm_config');
  if (columns.size === 0 || columns.has('vision_support')) return;
  await executeTransaction(
    db,
    [
      {
        sql: `ALTER TABLE llm_config
          ADD COLUMN vision_support TEXT NOT NULL DEFAULT 'auto'`,
      },
    ],
    { faultDomain: 'migration' },
  );
}
