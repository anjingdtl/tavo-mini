import type SQLite from 'react-native-sqlite-storage';
import type { Migration, MigrationResult } from './types';
import { migrateV3toV4 } from './v3-to-v4';
import { migrateV4toV5 } from './v4-to-v5';

export const SCHEMA_VERSION = 5;
export const MIN_COMPATIBLE_SCHEMA_VERSION = 3;

const MIGRATIONS: Migration[] = [
  { from: 2, to: 3, breaking: true, migrate: async () => {} },
  { from: 3, to: 4, breaking: false, migrate: migrateV3toV4 },
  { from: 4, to: 5, breaking: false, migrate: migrateV4toV5 },
];

async function execute(db: SQLite.SQLiteDatabase, sql: string, params: any[] = []) {
  const [result] = await db.executeSql(sql, params);
  return result;
}

export async function runMigrations(
  db: SQLite.SQLiteDatabase,
  fromVersion: number,
  onBackup?: () => Promise<string | null>,
): Promise<MigrationResult> {
  const needed = MIGRATIONS.filter(m => m.from >= fromVersion && m.to <= SCHEMA_VERSION);
  const hasBreaking = needed.some(m => m.breaking);

  let backupPath: string | null = null;
  if (hasBreaking && onBackup) {
    backupPath = await onBackup();
  }

  for (const migration of needed) {
    await db.transaction(async (tx) => {
      await migration.migrate(tx as unknown as SQLite.SQLiteDatabase);
      await execute(
        tx as unknown as SQLite.SQLiteDatabase,
        'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
        ['schema_version', String(migration.to)],
      );
    });
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
  return MIGRATIONS.some(m => m.from >= fromVersion && m.to <= SCHEMA_VERSION && m.breaking);
}

export function isIncompatibleUpgrade(fromVersion: number): boolean {
  return fromVersion < MIN_COMPATIBLE_SCHEMA_VERSION;
}
