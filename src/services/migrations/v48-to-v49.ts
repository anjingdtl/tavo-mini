/**
 * Schema 48 → 49: V3.2 structured-stage candidate scratch/diagnostics.
 *
 * The migration is deliberately idempotent. Some installed databases have a
 * recorded schema version ahead of their physical columns, so every column is
 * checked before issuing ALTER TABLE.
 */
import type SQLite from 'react-native-sqlite-storage';
import type { SqlStatement } from '../database/transaction';
import { executeTransaction } from '../database/transaction';
import { tableColumns } from './helpers';

export const V49_ATTEMPT_COLUMNS = [
  {
    name: 'response_candidate_temp',
    ddl: 'ALTER TABLE pipeline_stage_attempts ADD COLUMN response_candidate_temp TEXT',
  },
  {
    name: 'response_candidate_channel',
    ddl: 'ALTER TABLE pipeline_stage_attempts ADD COLUMN response_candidate_channel TEXT',
  },
  {
    name: 'validation_details_json',
    ddl: 'ALTER TABLE pipeline_stage_attempts ADD COLUMN validation_details_json TEXT',
  },
] as const;

/** Fresh-install helper: Schema 41 DDL already creates the table. */
export function buildSchema49CreateSqls(): string[] {
  return V49_ATTEMPT_COLUMNS.map(column => column.ddl);
}

export async function migrateV48ToV49(
  db: SQLite.SQLiteDatabase,
): Promise<void> {
  const columns = await tableColumns(db, 'pipeline_stage_attempts');
  const statements: SqlStatement[] = V49_ATTEMPT_COLUMNS
    .filter(column => !columns.has(column.name))
    .map(column => ({ sql: column.ddl }));
  if (statements.length > 0) {
    await executeTransaction(db, statements, { faultDomain: 'migration' });
  }
}
