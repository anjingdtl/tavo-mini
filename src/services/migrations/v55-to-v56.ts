/**
 * Schema 55 → 56: Continuation Stage Result CHECK constraint extension
 * (二 Phase §7.2 ONE QA).
 *
 * The compact Standard writes its unified QA report to a new ledger node
 * `unified_qa` (replaces the legacy trio narrative_architect +
 * adversarial_auditor + any historical fact_check). Both
 * `continuation_generation_runs.stage` and
 * `continuation_generation_stage_results.stage` carry CHECK constraints
 * listing allowed ledger nodes — adding the new node means the existing
 * CHECK constraint has to be rewritten. SQLite does not allow
 * `ALTER TABLE ... DROP CONSTRAINT`, so the only safe migration path is
 * to create a new table with the new CHECK, copy rows, drop the old one
 * and rename.
 *
 * The continuation-driver writes a `'unified_qa'` ledger row whenever the
 * task's frozen stagePolicy is compact_standard; legacy tasks continue to
 * use narrative_architect / adversarial_auditor. No data backfill is
 * required — the column is a free-text ledger name, and no historical row
 * is in scope.
 *
 * Idempotent: re-running this migration is a no-op because every CREATE /
 * ALTER uses IF NOT EXISTS semantics on the source shape.
 */
import type SQLite from 'react-native-sqlite-storage';
import type { SqlStatement } from '../database/transaction';
import { executeTransaction } from '../database/transaction';

export const UNIFIED_QA_NODE = 'unified_qa';

/**
 * The two CHECK lists that must enumerate `unified_qa`. Both lists are kept
 * here as the single source of truth so future stages land in lockstep.
 */
export const CONTINUATION_RUN_STAGE_CHECK = [
  'context',
  'planner',
  'writer',
  'checker',
  'auditing',
  'repair',
  'local_verify',
  'awaiting_user',
  'draft_writer',
  'narrative_architect',
  'revision_writer',
  'adversarial_auditor',
  UNIFIED_QA_NODE,
  'final_reviser',
  'final_validate',
  'round1',
  'round2',
  'round3',
] as const;

export const CONTINUATION_STAGE_RESULTS_STAGE_CHECK = [
  'writer',
  'checker',
  'control',
  'repair',
  'local_verify',
  'draft_writer',
  'narrative_architect',
  'revision_writer',
  'adversarial_auditor',
  UNIFIED_QA_NODE,
  'final_reviser',
  'final_validate',
] as const;

/**
 * Rebuild `continuation_generation_stage_results` with the extended CHECK.
 *
 * SQLite has no `DROP CONSTRAINT`; we copy rows to a temp table, drop the
 * original, and rename the temp table back. UNIQUE(run_id, stage) and the
 * existing FK declarations are preserved verbatim.
 */
export function buildV55ToV56Statements(): SqlStatement[] {
  return [
    {
      sql: `CREATE TABLE IF NOT EXISTS continuation_generation_stage_results__v56 (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        status TEXT NOT NULL,
        request_reserved INTEGER NOT NULL DEFAULT 0,
        request_count INTEGER NOT NULL DEFAULT 0,
        model_config_id INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        min_output_tokens INTEGER,
        max_output_tokens INTEGER,
        output_json TEXT,
        artifact_id TEXT,
        error_code TEXT,
        error_message TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(stage IN (${CONTINUATION_STAGE_RESULTS_STAGE_CHECK.map(s => `'${s}'`).join(', ')})),
        CHECK(status IN ('queued', 'running', 'success', 'failed', 'interrupted', 'skipped')),
        CHECK(request_reserved IN (0, 1)),
        CHECK(request_count BETWEEN 0 AND 1),
        CHECK(input_tokens IS NULL OR input_tokens >= 0),
        CHECK(output_tokens IS NULL OR output_tokens >= 0),
        CHECK(min_output_tokens IS NULL OR min_output_tokens >= 0),
        CHECK(max_output_tokens IS NULL OR max_output_tokens >= 0),
        UNIQUE(run_id, stage),
        FOREIGN KEY(run_id) REFERENCES continuation_generation_runs(id) ON DELETE CASCADE,
        FOREIGN KEY(model_config_id) REFERENCES llm_config(id) ON DELETE SET NULL,
        FOREIGN KEY(artifact_id) REFERENCES continuation_generation_artifacts(id) ON DELETE SET NULL
      )`,
    },
    {
      sql: `INSERT INTO continuation_generation_stage_results__v56
        SELECT * FROM continuation_generation_stage_results`,
    },
    { sql: 'DROP TABLE continuation_generation_stage_results' },
    {
      sql: 'ALTER TABLE continuation_generation_stage_results__v56 RENAME TO continuation_generation_stage_results',
    },
    {
      sql: 'CREATE INDEX IF NOT EXISTS idx_continuation_stage_results_run_state ON continuation_generation_stage_results(run_id, stage)',
    },
    // continuation_generation_runs.stage also has a CHECK constraint listing
    // allowed round labels; the round label list ('round1'/'round2'/'round3')
    // is unaffected — only ledger-node labels are added. Since we only add
    // `unified_qa` to the stage_results table and never write that value to
    // runs.stage, no change to the runs CHECK is required.
  ];
}

/**
 * Idempotent logic migration: detect the legacy CHECK on stage_results.stage
 * and rebuild the table only when `unified_qa` is missing. This protects
 * fresh-install DDL (which already carries the extended CHECK) and re-runs.
 */
export async function migrateV55ToV56(
  db: SQLite.SQLiteDatabase,
): Promise<void> {
  // sql.js probe via raw exec on the open db handle (transaction API).
  const [probe] = await db.executeSql(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='continuation_generation_stage_results'",
    [],
  );
  const sql =
    probe && probe.rows && probe.rows.length > 0
      ? String(probe.rows.item(0).sql)
      : '';
  // Drifted/partial database without the continuation V5 tables: skip the
  // CHECK rebuild rather than crash (same discipline as Schema 50→51 — the
  // manifest-based schemaValidator still flags a truly-missing table, and a
  // fresh install already carries the extended CHECK through
  // createCurrentSchemaStatements).
  if (!sql) return;
  if (sql.includes(`'${UNIFIED_QA_NODE}'`)) return;
  // Rebuild via the transaction-aware plan.
  await executeTransaction(db, buildV55ToV56Statements(), {
    faultDomain: 'migration',
  });
}