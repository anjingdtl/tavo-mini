import type SQLite from 'react-native-sqlite-storage';

export type Row = Record<string, any>;

export async function execute(
  database: SQLite.SQLiteDatabase,
  sql: string,
  params: any[] = [],
) {
  const [result] = await database.executeSql(sql, params);
  return result;
}
