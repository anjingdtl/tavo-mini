import type SQLite from 'react-native-sqlite-storage';
import type { SqlStatement } from '../database/transaction';

/**
 * The highest data-safety boundary a migration can cross.
 *
 * This is deliberately independent from `breaking`: a migration may preserve
 * compatibility while still rewriting derived/user-owned values and therefore
 * requiring a different startup protection level.
 */
export type MigrationRisk =
  | 'schema_only'
  | 'derived_data'
  | 'content_transform'
  | 'destructive';

export interface Migration {
  from: number;
  to: number;
  breaking: boolean;
  risk: MigrationRisk;
  affectedTables: readonly string[];
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
  risk: MigrationRisk;
  affectedTables: readonly string[];
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
