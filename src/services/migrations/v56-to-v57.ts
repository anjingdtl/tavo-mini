/**
 * Schema 56 → 57: preserve exact Final bodies across artifact stages.
 *
 * The historical UNIQUE(run_id, content_hash) constraint treated a repeated
 * body in another producing stage as a collision. The artifact repository
 * then had to append an invisible salt to the Final body, which changed its
 * SHA-256 and made Final-Body state-proposal binding impossible. The
 * uniqueness boundary is stage-local instead: retries within one stage still
 * deduplicate, while Draft/Revision/Final may each retain the exact same
 * body and hash.
 */
import type SQLite from 'react-native-sqlite-storage';
import { applyMigration } from './helpers';
import type { SqlStatement } from '../database/transaction';

export const ARTIFACT_CONTENT_UNIQUE_V57 =
  'UNIQUE(run_id, content_hash, stage)';

const ARTIFACT_COLUMNS = [
  'id',
  'run_id',
  'stage',
  'repair_round',
  'parent_artifact_id',
  'content',
  'content_hash',
  'eligibility_status',
  'rejection_code',
  'created_at',
] as const;

const ARTIFACT_COLUMN_LIST = ARTIFACT_COLUMNS.join(', ');

export function buildSchema57ArtifactsCreateSql(): string {
  return `CREATE TABLE IF NOT EXISTS continuation_generation_artifacts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    repair_round INTEGER NOT NULL DEFAULT 0,
    parent_artifact_id TEXT,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    eligibility_status TEXT NOT NULL DEFAULT 'eligible',
    rejection_code TEXT,
    created_at TEXT NOT NULL,
    CHECK(stage IN (
      'writer', 'repair', 'user_edit',
      'draft', 'revision_1', 'final'
    )),
    CHECK(eligibility_status IN ('eligible', 'rejected', 'intermediate')),
    CHECK(repair_round >= 0),
    ${ARTIFACT_CONTENT_UNIQUE_V57},
    FOREIGN KEY(run_id) REFERENCES continuation_generation_runs(id) ON DELETE CASCADE,
    FOREIGN KEY(parent_artifact_id) REFERENCES continuation_generation_artifacts(id) ON DELETE SET NULL
  )`;
}

export function buildV56ToV57Statements(): SqlStatement[] {
  return [
    {
      sql: `ALTER TABLE continuation_generation_artifacts
        RENAME TO continuation_generation_artifacts__v57`,
    },
    { sql: buildSchema57ArtifactsCreateSql() },
    {
      sql: `INSERT INTO continuation_generation_artifacts (${ARTIFACT_COLUMN_LIST})
        SELECT ${ARTIFACT_COLUMN_LIST}
        FROM continuation_generation_artifacts__v57`,
    },
    { sql: 'DROP TABLE continuation_generation_artifacts__v57' },
    {
      sql: `CREATE INDEX IF NOT EXISTS idx_continuation_artifacts_run_created
        ON continuation_generation_artifacts(run_id, created_at)`,
    },
  ];
}

/** Idempotent upgrade for databases whose artifact table still has the old constraint. */
export async function migrateV56ToV57(
  database: SQLite.SQLiteDatabase,
): Promise<void> {
  const [probe] = await database.executeSql(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='continuation_generation_artifacts'",
    [],
  );
  const sql =
    probe && probe.rows && probe.rows.length > 0
      ? String(probe.rows.item(0).sql)
      : '';
  if (!sql || sql.includes(ARTIFACT_CONTENT_UNIQUE_V57)) return;

  await database.executeSql('PRAGMA foreign_keys = OFF');
  await database.executeSql('PRAGMA legacy_alter_table = ON');
  try {
    await applyMigration(database, buildV56ToV57Statements());
  } finally {
    await database.executeSql('PRAGMA legacy_alter_table = OFF');
    await database.executeSql('PRAGMA foreign_keys = ON');
  }

  const [foreignKeyCheck] = await database.executeSql(
    'PRAGMA foreign_key_check',
  );
  if (foreignKeyCheck.rows.length > 0) {
    throw new Error(
      `Schema 57 迁移后发现 ${foreignKeyCheck.rows.length} 条外键孤儿记录`,
    );
  }
}
