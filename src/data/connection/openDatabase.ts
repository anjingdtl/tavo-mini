import SQLite from 'react-native-sqlite-storage';
import { initializeDatabase } from '../schema/initializeDatabase';
import type { StartupPhase } from '../../services/startupProgress';

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

export interface OpenDatabaseOptions {
  /** CL-04: real startup-phase callback (initializeDatabase steps). */
  onPhase?: (phase: StartupPhase) => void;
}

export async function openDatabase(
  options?: OpenDatabaseOptions,
): Promise<SQLite.SQLiteDatabase> {
  if (db) return db;
  if (opening) return opening;

  opening = (async () => {
    const database = await SQLite.openDatabase({
      name: DB_NAME,
      location: 'default',
    });
    await initializeDatabase(database, options);
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
