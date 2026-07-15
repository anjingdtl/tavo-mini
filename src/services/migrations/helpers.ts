import type SQLite from 'react-native-sqlite-storage';
import { executeTransaction, type SqlStatement } from '../database/transaction';

export async function tableColumns(
  database: SQLite.SQLiteDatabase,
  table: string,
): Promise<Set<string>> {
  const [result] = await database.executeSql(`PRAGMA table_info(${table})`);
  const columns = new Set<string>();
  for (let index = 0; index < result.rows.length; index += 1) {
    columns.add(result.rows.item(index).name);
  }
  return columns;
}

export async function applyMigration(
  database: SQLite.SQLiteDatabase,
  statements: readonly SqlStatement[],
): Promise<void> {
  await executeTransaction(database, statements);
}
