import type SQLite from 'react-native-sqlite-storage';
import { applyMigration } from './helpers';
import {
  buildCanonAnalysisForeignKeyRepairStatements,
} from './canonAnalysisForeignKeyRepair';
import type { SqlStatement } from '../database/transaction';

/**
 * Schema 30 → 31: repair Canon FKs left pointing at the temporary Schema 29
 * analysis-run table. Schema 30 rebuilt continuation_analysis_runs but missed
 * the Canon fact tables, so SQLite rewrote their foreign keys to
 * continuation_analysis_runs_v29 and later DELETE source failed with
 * "no such table". Rebuild the Canon graph without deleting source data.
 */
export function buildV30toV31Statements(): SqlStatement[] {
  return buildCanonAnalysisForeignKeyRepairStatements('v30');
}

export async function migrateV30ToV31(
  database: SQLite.SQLiteDatabase,
): Promise<void> {
  await applyMigration(database, buildV30toV31Statements());
  const [foreignKeyCheck] = await database.executeSql(
    'PRAGMA foreign_key_check',
  );
  if (foreignKeyCheck.rows.length > 0) {
    throw new Error(
      `Schema 31 迁移后发现 ${foreignKeyCheck.rows.length} 条外键孤儿记录`,
    );
  }
}
