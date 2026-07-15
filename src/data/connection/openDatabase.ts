import SQLite from 'react-native-sqlite-storage';
import { initializeDatabase } from '../schema/initializeDatabase';

SQLite.enablePromise(true);

const DB_NAME = 'shine_writer.db';
let db: SQLite.SQLiteDatabase | null = null;
let opening: Promise<SQLite.SQLiteDatabase> | null = null;

export function __resetForTest(): void {
  db = null;
  opening = null;
}

export function __setDatabaseForTest(
  database: SQLite.SQLiteDatabase | null,
): void {
  db = database;
  opening = null;
}

export async function openDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (db) return db;
  if (opening) return opening;

  opening = (async () => {
    const database = await SQLite.openDatabase({
      name: DB_NAME,
      location: 'default',
    });
    await initializeDatabase(database);
    db = database;
    opening = null;
    return database;
  })().catch(error => {
    db = null;
    opening = null;
    throw error;
  });

  return opening;
}
