import type SQLite from 'react-native-sqlite-storage';
import type { SqlStatement } from '../database/transaction';

export interface Migration {
  from: number;
  to: number;
  breaking: boolean;
  buildStatements: (
    database: SQLite.SQLiteDatabase,
  ) => Promise<SqlStatement[]>;
  /** Optional logic migration run after the statement batch (idempotent). */
  migrate?: (database: SQLite.SQLiteDatabase) => Promise<void>;
}

export interface MigrationResult {
  fromVersion: number;
  toVersion: number;
  migrationsRun: number;
  hadBreaking: boolean;
  backupPath: string | null;
}

export type InstallType = 'fresh' | 'upgrade' | 'same';

export interface InstallInfo {
  installType: InstallType;
  currentVersion: string;
  previousVersion: string | null;
  firstInstallVersion: string;
  schemaVersion: number;
}
