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
import { migrateV25ToV26 } from './v25-to-v26';
import { buildV26toV27Statements } from './v26-to-v27';
import { buildV27toV28Statements } from './v27-to-v28';
import { migrateV28ToV29 } from './v28-to-v29';
import { buildV29toV30Statements } from './v29-to-v30';
import { buildV30toV31Statements } from './v30-to-v31';
import { migrateV31ToV32 } from './v31-to-v32';
import { migrateV32ToV33 } from './v32-to-v33';
import { migrateV33ToV34 } from './v33-to-v34';
import { buildV34toV35Statements } from './v34-to-v35';
import { buildV35toV36Statements } from './v35-to-v36';
import { buildV36toV37Statements } from './v36-to-v37';
import { buildV37toV38Statements } from './v37-to-v38';
import { migrateV38ToV39 } from './v38-to-v39';
import { migrateV39ToV40 } from './v39-to-v40';
import { migrateV40ToV41 } from './v40-to-v41';
import { migrateV41ToV42 } from './v41-to-v42';
import { migrateV42ToV43 } from './v42-to-v43';
import { migrateV43ToV44 } from './v43-to-v44';
import { migrateV44ToV45 } from './v44-to-v45';
import { migrateV45ToV46 } from './v45-to-v46';
import { migrateV46ToV47 } from './v46-to-v47';
import { migrateV47ToV48 } from './v47-to-v48';
import { migrateV48ToV49 } from './v48-to-v49';
import { migrateV49ToV50 } from './v49-to-v50';
import { migrateV50ToV51 } from './v50-to-v51';
import { migrateV51ToV52 } from './v51-to-v52';
import { migrateV52ToV53 } from './v52-to-v53';
import { migrateV53ToV54 } from './v53-to-v54';
import { migrateV54ToV55 } from './v54-to-v55';
import { migrateV55ToV56 } from './v55-to-v56';
import { migrateV56ToV57 } from './v56-to-v57';
import { migrateV57ToV58 } from './v57-to-v58';
import { migrateV58ToV59 } from './v58-to-v59';

export const SCHEMA_VERSION = 59;
export const MIN_COMPATIBLE_SCHEMA_VERSION = 3;

// Logic migrations own their idempotent statement plan. Keeping a shared
// no-op builder here avoids presenting an unreachable duplicate schema plan in
// the registry while preserving the Migration interface for statement-only
// migrations.
const noSchemaStatements = async () => [];

const MIGRATIONS: Migration[] = [
  { from: 2, to: 3, breaking: true, buildStatements: async () => [] },
  {
    from: 3,
    to: 4,
    breaking: false,
    buildStatements: async () => buildV3toV4Statements(),
  },
  {
    from: 4,
    to: 5,
    breaking: false,
    buildStatements: async () => buildV4toV5Statements(),
  },
  {
    from: 5,
    to: 6,
    breaking: false,
    buildStatements: async () => buildV5toV6Statements(),
  },
  {
    from: 6,
    to: 7,
    breaking: false,
    buildStatements: async () => buildV6toV7Statements(),
  },
  { from: 7, to: 8, breaking: false, buildStatements: buildV7toV8Statements },
  {
    from: 8,
    to: 9,
    breaking: false,
    buildStatements: async () => buildV8toV9Statements(),
  },
  { from: 9, to: 10, breaking: false, buildStatements: buildV9toV10Statements },
  {
    from: 10,
    to: 11,
    breaking: false,
    buildStatements: buildV10toV11Statements,
  },
  {
    from: 11,
    to: 12,
    breaking: false,
    buildStatements: buildV11toV12Statements,
  },
  {
    from: 12,
    to: 13,
    breaking: false,
    buildStatements: buildV12toV13Statements,
  },
  {
    from: 13,
    to: 14,
    breaking: false,
    buildStatements: buildV13toV14Statements,
  },
  {
    from: 14,
    to: 15,
    breaking: false,
    buildStatements: async () => buildV14toV15Statements(),
  },
  {
    from: 15,
    to: 16,
    breaking: false,
    buildStatements: async () => buildV15toV16Statements(),
  },
  {
    from: 16,
    to: 17,
    breaking: false,
    buildStatements: async () => buildV16toV17Statements(),
  },
  {
    from: 17,
    to: 18,
    breaking: false,
    buildStatements: async () => buildV17toV18Statements(),
  },
  {
    from: 18,
    to: 19,
    breaking: false,
    buildStatements: async () => buildV18toV19Statements(),
  },
  {
    from: 19,
    to: 20,
    breaking: false,
    buildStatements: async () => buildV19toV20Statements(),
  },
  {
    from: 20,
    to: 21,
    breaking: false,
    buildStatements: async () => buildV20toV21Statements(),
  },
  {
    from: 21,
    to: 22,
    breaking: false,
    buildStatements: async () => buildV21toV22Statements(),
  },
  {
    from: 22,
    to: 23,
    breaking: false,
    buildStatements: async () => buildV22toV23Statements(),
  },
  {
    from: 23,
    to: 24,
    breaking: false,
    buildStatements: async () => buildV23toV24Statements(),
  },
  {
    from: 24,
    to: 25,
    breaking: false,
    buildStatements: async () => buildV24toV25Statements(),
  },
  {
    from: 25,
    to: 26,
    breaking: false,
    buildStatements: noSchemaStatements,
  },
  {
    from: 26,
    to: 27,
    breaking: true,
    buildStatements: async () => buildV26toV27Statements(),
  },
  {
    from: 27,
    to: 28,
    breaking: false,
    buildStatements: async () => buildV27toV28Statements(),
  },
  {
    from: 28,
    to: 29,
    breaking: false,
    buildStatements: noSchemaStatements,
  },
  {
    from: 29,
    to: 30,
    breaking: false,
    buildStatements: async () => buildV29toV30Statements(),
  },
  {
    from: 30,
    to: 31,
    breaking: false,
    buildStatements: async () => buildV30toV31Statements(),
  },
  {
    from: 31,
    to: 32,
    breaking: false,
    buildStatements: noSchemaStatements,
  },
  {
    from: 32,
    to: 33,
    breaking: false,
    buildStatements: noSchemaStatements,
  },
  {
    from: 33,
    to: 34,
    breaking: false,
    buildStatements: noSchemaStatements,
  },
  {
    from: 34,
    to: 35,
    breaking: false,
    buildStatements: async () => buildV34toV35Statements(),
  },
  {
    from: 35,
    to: 36,
    breaking: false,
    buildStatements: async () => buildV35toV36Statements(),
  },
  {
    from: 36,
    to: 37,
    breaking: false,
    buildStatements: async () => buildV36toV37Statements(),
  },
  {
    from: 37,
    to: 38,
    breaking: false,
    buildStatements: async () => buildV37toV38Statements(),
  },
  {
    from: 38,
    to: 39,
    breaking: false,
    // Logic migration (JSON backfill) via migrateV38ToV39.
    buildStatements: noSchemaStatements,
  },
  {
    from: 39,
    to: 40,
    breaking: false,
    // Logic migration: idempotent canon_evidence provenance drift repair.
    buildStatements: noSchemaStatements,
  },
  {
    from: 40,
    to: 41,
    breaking: false,
    buildStatements: noSchemaStatements,
    migrate: migrateV40ToV41,
  },
  {
    from: 41,
    to: 42,
    breaking: false,
    buildStatements: noSchemaStatements,
    migrate: migrateV41ToV42,
  },
  {
    from: 42,
    to: 43,
    breaking: false,
    // Logic migration: one-time smart policy interval unification (42→43).
    buildStatements: noSchemaStatements,
    migrate: migrateV42ToV43,
  },
  {
    from: 43,
    to: 44,
    breaking: false,
    // Logic migration: idempotent pipeline task / batch version-freeze
    // columns (43→44). ALTERs run only when a column is missing.
    buildStatements: noSchemaStatements,
    migrate: migrateV43ToV44,
  },
  {
    from: 44,
    to: 45,
    breaking: false,
    buildStatements: noSchemaStatements,
    migrate: migrateV44ToV45,
  },
  {
    from: 45,
    to: 46,
    breaking: false,
    buildStatements: noSchemaStatements,
    migrate: migrateV45ToV46,
  },
  {
    from: 46,
    to: 47,
    // V3/profile2 execution chains are intentionally removed as a recovery
    // boundary. runMigrations therefore requests a schema-recovery backup
    // before invoking this migration.
    breaking: true,
    buildStatements: noSchemaStatements,
    migrate: migrateV46ToV47,
  },
  {
    from: 47,
    to: 48,
    breaking: false,
    buildStatements: noSchemaStatements,
    migrate: migrateV47ToV48,
  },
  {
    from: 48,
    to: 49,
    breaking: false,
    buildStatements: noSchemaStatements,
    migrate: migrateV48ToV49,
  },
  {
    from: 49,
    to: 50,
    breaking: false,
    buildStatements: noSchemaStatements,
    migrate: migrateV49ToV50,
  },
  {
    from: 50,
    to: 51,
    breaking: false,
    // Logic migration: idempotent nullable cache-telemetry columns (50→51).
    buildStatements: noSchemaStatements,
    migrate: migrateV50ToV51,
  },
  {
    from: 51,
    to: 52,
    breaking: false,
    buildStatements: noSchemaStatements,
    migrate: migrateV51ToV52,
  },
  {
    from: 52,
    to: 53,
    breaking: false,
    // Logic migration: idempotent continuation-batch columns (52→53).
    buildStatements: noSchemaStatements,
    migrate: migrateV52ToV53,
  },
  {
    from: 53,
    to: 54,
    breaking: false,
    // Logic migration: idempotent one-shot execution_profile column (53→54).
    buildStatements: noSchemaStatements,
    migrate: migrateV53ToV54,
  },
  {
    from: 54,
    to: 55,
    breaking: false,
    // Logic migration: idempotent pipeline-topology freeze columns (54→55).
    buildStatements: noSchemaStatements,
    migrate: migrateV54ToV55,
  },
  {
    from: 55,
    to: 56,
    breaking: false,
    // Logic migration: idempotent continuation stage_results CHECK rebuild
    // for Phase 4 §7.2 (compact Standard writes a `unified_qa` ledger row).
    buildStatements: noSchemaStatements,
    migrate: migrateV55ToV56,
  },
  {
    from: 56,
    to: 57,
    breaking: false,
    // Preserve byte-exact Final bodies when Draft/Revision/Final repeat the
    // same content; the old cross-stage hash constraint forced invisible
    // suffixes and broke Final-Body fingerprint binding.
    buildStatements: noSchemaStatements,
    migrate: migrateV56ToV57,
  },
  {
    from: 57,
    to: 58,
    breaking: false,
    // Empty legacy model rows lose only fake defaults; configured model
    // capability values are deliberately preserved by the migration.
    buildStatements: noSchemaStatements,
    migrate: migrateV57ToV58,
  },
  {
    from: 58,
    to: 59,
    breaking: false,
    // Derived project writing stats are rebuilt from the authoritative
    // projects/chapters rows in narrow batches.
    buildStatements: noSchemaStatements,
    migrate: migrateV58ToV59,
  },
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
    } else if (migration.from === 28 && migration.to === 29) {
      await migrateV28ToV29(db);
    } else if (migration.from === 31 && migration.to === 32) {
      await migrateV31ToV32(db);
    } else if (migration.from === 32 && migration.to === 33) {
      // Idempotent logic migration: ensure provenance columns + dedup + indexes.
      await migrateV32ToV33(db);
    } else if (migration.from === 33 && migration.to === 34) {
      await migrateV33ToV34(db);
    } else if (migration.from === 38 && migration.to === 39) {
      await migrateV38ToV39(db);
    } else if (migration.from === 39 && migration.to === 40) {
      // Idempotent logic migration: repair canon_evidence provenance drift.
      await migrateV39ToV40(db);
    } else if (migration.from === 40 && migration.to === 41) {
      await migrateV40ToV41(db);
    } else if (migration.from === 41 && migration.to === 42) {
      await migrateV41ToV42(db);
    } else if (migration.from === 42 && migration.to === 43) {
      // One-time data migration: unify legacy smart policy interval to 10.
      await migrateV42ToV43(db);
    } else if (migration.from === 46 && migration.to === 47) {
      await migrateV46ToV47(db);
    } else if (migration.from === 47 && migration.to === 48) {
      await migrateV47ToV48(db);
    } else if (migration.from === 49 && migration.to === 50) {
      await migrateV49ToV50(db);
    } else if (migration.from === 51 && migration.to === 52) {
      await migrateV51ToV52(db);
    } else if (migration.from === 52 && migration.to === 53) {
      await migrateV52ToV53(db);
    } else if (migration.from === 53 && migration.to === 54) {
      await migrateV53ToV54(db);
    } else if (migration.from === 54 && migration.to === 55) {
      await migrateV54ToV55(db);
    } else if (migration.from === 55 && migration.to === 56) {
      // Idempotent logic migration: continuation stage_results CHECK rebuild
      // for Phase 4 §7.2 (compact Standard writes a `unified_qa` ledger row).
      await migrateV55ToV56(db);
    } else if (migration.from === 56 && migration.to === 57) {
      // Idempotent logic migration: artifact content uniqueness is now
      // stage-local so the Final body hash remains exact.
      await migrateV56ToV57(db);
    } else if (migration.from === 57 && migration.to === 58) {
      await migrateV57ToV58(db);
    } else if (migration.migrate) {
      await migration.migrate(db);
    } else {
      const statements = await migration.buildStatements(db);
      await executeTransaction(db, statements, { faultDomain: 'migration' });
    }
    await executeTransaction(
      db,
      [
        {
          sql: 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
          params: ['schema_version', String(migration.to)],
        },
      ],
      { faultDomain: 'migration' },
    );
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
