import type SQLite from 'react-native-sqlite-storage';
import type { Migration, MigrationResult } from './types';
import { executeTransaction } from '../database/transaction';
import { buildV3toV4Statements } from './v3-to-v4';
import { buildV4toV5Statements } from './v4-to-v5';
import { buildV5toV6Statements } from './v5-to-v6';
import { buildV6toV7Statements } from './v6-to-v7';
import { buildV7toV8Statements } from './v7-to-v8';
import { buildV8toV9Statements } from './v8-to-v9';
import { buildV9toV10Statements } from './v9-to-v10';
import { buildV10toV11Statements } from './v10-to-v11';
import { buildV11toV12Statements } from './v11-to-v12';
import { buildV12toV13Statements } from './v12-to-v13';
import { buildV13toV14Statements } from './v13-to-v14';
import { buildV14toV15Statements } from './v14-to-v15';
import { buildV15toV16Statements } from './v15-to-v16';
import { buildV16toV17Statements } from './v16-to-v17';
import { buildV17toV18Statements } from './v17-to-v18';
import { buildV18toV19Statements } from './v18-to-v19';
import { buildV19toV20Statements } from './v19-to-v20';
import { buildV20toV21Statements } from './v20-to-v21';
import { buildV21toV22Statements } from './v21-to-v22';
import { buildV22toV23Statements } from './v22-to-v23';
import { buildV23toV24Statements } from './v23-to-v24';
import { buildV24toV25Statements } from './v24-to-v25';
import { buildV25toV26Statements, migrateV25ToV26 } from './v25-to-v26';

export const SCHEMA_VERSION = 26;
export const MIN_COMPATIBLE_SCHEMA_VERSION = 3;

const MIGRATIONS: Migration[] = [
  { from: 2, to: 3, breaking: true, buildStatements: async () => [] },
  { from: 3, to: 4, breaking: false, buildStatements: async () => buildV3toV4Statements() },
  { from: 4, to: 5, breaking: false, buildStatements: async () => buildV4toV5Statements() },
  { from: 5, to: 6, breaking: false, buildStatements: async () => buildV5toV6Statements() },
  { from: 6, to: 7, breaking: false, buildStatements: async () => buildV6toV7Statements() },
  { from: 7, to: 8, breaking: false, buildStatements: buildV7toV8Statements },
  { from: 8, to: 9, breaking: false, buildStatements: async () => buildV8toV9Statements() },
  { from: 9, to: 10, breaking: false, buildStatements: buildV9toV10Statements },
  { from: 10, to: 11, breaking: false, buildStatements: buildV10toV11Statements },
  { from: 11, to: 12, breaking: false, buildStatements: buildV11toV12Statements },
  { from: 12, to: 13, breaking: false, buildStatements: buildV12toV13Statements },
  { from: 13, to: 14, breaking: false, buildStatements: buildV13toV14Statements },
  { from: 14, to: 15, breaking: false, buildStatements: async () => buildV14toV15Statements() },
  { from: 15, to: 16, breaking: false, buildStatements: async () => buildV15toV16Statements() },
  { from: 16, to: 17, breaking: false, buildStatements: async () => buildV16toV17Statements() },
  { from: 17, to: 18, breaking: false, buildStatements: async () => buildV17toV18Statements() },
  { from: 18, to: 19, breaking: false, buildStatements: async () => buildV18toV19Statements() },
  { from: 19, to: 20, breaking: false, buildStatements: async () => buildV19toV20Statements() },
  { from: 20, to: 21, breaking: false, buildStatements: async () => buildV20toV21Statements() },
  { from: 21, to: 22, breaking: false, buildStatements: async () => buildV21toV22Statements() },
  { from: 22, to: 23, breaking: false, buildStatements: async () => buildV22toV23Statements() },
  { from: 23, to: 24, breaking: false, buildStatements: async () => buildV23toV24Statements() },
  { from: 24, to: 25, breaking: false, buildStatements: async () => buildV24toV25Statements() },
  { from: 25, to: 26, breaking: false, buildStatements: async () => buildV25toV26Statements() },
];

export async function runMigrations(
  db: SQLite.SQLiteDatabase,
  fromVersion: number,
  onBackup?: () => Promise<string | null>,
): Promise<MigrationResult> {
  const needed = MIGRATIONS.filter(
    m => m.from >= fromVersion && m.to <= SCHEMA_VERSION,
  );
  const hasBreaking = needed.some(m => m.breaking);

  let backupPath: string | null = null;
  if (hasBreaking && onBackup) {
    backupPath = await onBackup();
  }

  for (const migration of needed) {
    if (migration.from === 25 && migration.to === 26) {
      await migrateV25ToV26(db);
    } else {
      const statements = await migration.buildStatements(db);
      await executeTransaction(db, statements, { faultDomain: 'migration' });
    }
    await executeTransaction(db, [
      {
        sql: 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
        params: ['schema_version', String(migration.to)],
      },
    ], { faultDomain: 'migration' });
  }

  return {
    fromVersion,
    toVersion: SCHEMA_VERSION,
    migrationsRun: needed.length,
    hadBreaking: hasBreaking,
    backupPath,
  };
}

export function hasBreakingMigration(fromVersion: number): boolean {
  return MIGRATIONS.some(
    m => m.from >= fromVersion && m.to <= SCHEMA_VERSION && m.breaking,
  );
}

export function isIncompatibleUpgrade(fromVersion: number): boolean {
  return fromVersion < MIN_COMPATIBLE_SCHEMA_VERSION;
}
