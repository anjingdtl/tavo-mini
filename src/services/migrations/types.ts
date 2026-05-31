import type SQLite from 'react-native-sqlite-storage';

export interface Migration {
  from: number;
  to: number;
  breaking: boolean;
  migrate: (db: SQLite.SQLiteDatabase) => Promise<void>;
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
