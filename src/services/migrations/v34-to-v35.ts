/**
 * Schema 34 → 35: Canon analysis round-2 reliability (partial batches + segments).
 *
 * Note: Schema 34 is Continuation V5 generation CHECK rebuilds (see v33-to-v34).
 * This migration extends analysis batches for partial/retry_tail persistence.
 *
 * 1. Rebuild `continuation_analysis_batches` so CHECK allows `partial`, and
 *    persist parent/segment fields for dynamic tail sub-batches.
 * 2. Best-effort repair after Schema 33 historical dedup:
 *    rebind remaining duplicate facts' evidence links to keepers, then clean
 *    dangling links and orphan evidence.
 * 3. Scheduler indexes for DB-driven batch pickup.
 */
import type { SqlStatement } from '../database/transaction';

/** Fresh-install CREATE for analysis batches (Schema 35 shape). */
export function buildAnalysisBatchesCreateSqlV35(): string {
  return `CREATE TABLE IF NOT EXISTS continuation_analysis_batches (
    run_id TEXT NOT NULL,
    canon_snapshot_id TEXT NOT NULL,
    batch_index INTEGER NOT NULL,
    start_position INTEGER NOT NULL,
    end_position INTEGER NOT NULL,
    input_hash TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL DEFAULT 'queued',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    result_json TEXT,
    error_code TEXT,
    error_message TEXT,
    parent_batch_index INTEGER,
    material_type TEXT,
    chapter_id INTEGER,
    source_char_start INTEGER,
    source_char_end INTEGER,
    coverage_kind TEXT NOT NULL DEFAULT 'full',
    had_partial_coverage INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    PRIMARY KEY(run_id, batch_index),
    CHECK(batch_index >= 0),
    CHECK(start_position >= 0 AND end_position > start_position),
    CHECK(state IN ('queued', 'running', 'partial', 'completed', 'failed', 'cancelled')),
    CHECK(attempt_count >= 0),
    CHECK(coverage_kind IN ('full', 'chunk', 'retry_tail', 'rescan')),
    CHECK(had_partial_coverage IN (0, 1)),
    CHECK(
      (source_char_start IS NULL AND source_char_end IS NULL)
      OR (
        source_char_start IS NOT NULL
        AND source_char_end IS NOT NULL
        AND source_char_start >= 0
        AND source_char_end > source_char_start
      )
    ),
    FOREIGN KEY(run_id) REFERENCES continuation_analysis_runs(id) ON DELETE CASCADE,
    FOREIGN KEY(canon_snapshot_id)
      REFERENCES continuation_canon_snapshots(id) ON DELETE CASCADE
  )`;
}

export function buildSchema35CreateSqls(): string[] {
  return [
    `CREATE INDEX IF NOT EXISTS idx_continuation_analysis_batches_state
      ON continuation_analysis_batches(run_id, state, batch_index)`,
    `CREATE INDEX IF NOT EXISTS idx_analysis_batches_next
      ON continuation_analysis_batches(run_id, state, batch_index)`,
    `CREATE INDEX IF NOT EXISTS idx_analysis_batches_parent
      ON continuation_analysis_batches(run_id, parent_batch_index)`,
    `CREATE INDEX IF NOT EXISTS idx_analysis_batches_segment
      ON continuation_analysis_batches(
        run_id, material_type, chapter_id, source_char_start, source_char_end
      )`,
  ];
}

function getWorkItemsCreateSqls(): [string, string] {
  const create = `CREATE TABLE IF NOT EXISTS continuation_analysis_work_items (
    run_id TEXT NOT NULL,
    batch_index INTEGER NOT NULL,
    material_type TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    result_json TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    PRIMARY KEY (run_id, batch_index, material_type),
    CHECK(material_type IN (
      'world_rules', 'characters', 'relationships', 'plot_threads', 'experiences',
      'character_state', 'world_plot', 'full_extraction'
    )),
    CHECK(state IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
    CHECK(attempt_count >= 0),
    FOREIGN KEY(run_id, batch_index)
      REFERENCES continuation_analysis_batches(run_id, batch_index) ON DELETE CASCADE
  )`;
  const index = `CREATE INDEX IF NOT EXISTS idx_continuation_analysis_work_items_state
    ON continuation_analysis_work_items(run_id, state, batch_index, material_type)`;
  return [create, index];
}

function rebuildAnalysisBatchesStatements(): SqlStatement[] {
  const [workItemsCreateSql, workItemsIndexSql] = getWorkItemsCreateSqls();
  return [
    {
      sql: 'ALTER TABLE continuation_analysis_work_items RENAME TO continuation_analysis_work_items_v34',
    },
    {
      sql: 'ALTER TABLE continuation_analysis_batches RENAME TO continuation_analysis_batches_v34',
    },
    { sql: buildAnalysisBatchesCreateSqlV35() },
    { sql: workItemsCreateSql },
    {
      sql: `INSERT INTO continuation_analysis_batches (
        run_id, canon_snapshot_id, batch_index, start_position, end_position,
        input_hash, idempotency_key, state, attempt_count, result_json,
        error_code, error_message,
        parent_batch_index, material_type, chapter_id,
        source_char_start, source_char_end, coverage_kind, had_partial_coverage,
        created_at, updated_at, completed_at
      ) SELECT
        run_id, canon_snapshot_id, batch_index, start_position, end_position,
        input_hash, idempotency_key, state, attempt_count, result_json,
        error_code, error_message,
        NULL, NULL, NULL,
        NULL, NULL, 'full', 0,
        created_at, updated_at, completed_at
      FROM continuation_analysis_batches_v34`,
    },
    {
      sql: `INSERT INTO continuation_analysis_work_items (
        run_id, batch_index, material_type, state, attempt_count, result_json,
        error_code, error_message, created_at, updated_at, completed_at
      ) SELECT
        run_id, batch_index, material_type, state, attempt_count, result_json,
        error_code, error_message, created_at, updated_at, completed_at
      FROM continuation_analysis_work_items_v34`,
    },
    { sql: 'DROP TABLE continuation_analysis_work_items_v34' },
    { sql: 'DROP TABLE continuation_analysis_batches_v34' },
    { sql: workItemsIndexSql },
    ...buildSchema35CreateSqls().map(sql => ({ sql })),
  ];
}

/**
 * Rebind evidence links from non-keeper duplicates to the highest-id keeper
 * (among non-superseded rows sharing the business key), then delete duplicates.
 *
 * Schema 33 already collapsed most duplicates by max id without rebinding.
 * This pass is idempotent: if no duplicates remain, statements affect 0 rows.
 * Keeper = MAX(id) for simplicity and compatibility with Schema 33's choice;
 * evidence is preserved by rebinding before delete.
 */
function rebindAndDedupByMaxId(
  table: string,
  ownerType: string,
  keyColumns: string[],
): SqlStatement[] {
  const keyEq = keyColumns.map(c => `d.${c} = k.${c}`).join(' AND ');
  const keyList = keyColumns.join(', ');
  return [
    {
      // Point every link that targets a non-max duplicate at the max id for
      // the same business key.
      sql: `UPDATE canon_evidence_links
        SET owner_id = (
          SELECT MAX(k.id) FROM ${table} k
          INNER JOIN ${table} d ON ${keyEq}
          WHERE d.id = canon_evidence_links.owner_id
            AND k.review_status != 'superseded'
            AND d.review_status != 'superseded'
        )
        WHERE owner_type = ?
          AND owner_id IN (
            SELECT d.id FROM ${table} d
            WHERE d.review_status != 'superseded'
              AND d.id NOT IN (
                SELECT MAX(id) FROM ${table}
                WHERE review_status != 'superseded'
                GROUP BY ${keyList}
              )
              AND (${keyList}) IN (
                SELECT ${keyList} FROM ${table}
                WHERE review_status != 'superseded'
                GROUP BY ${keyList}
                HAVING COUNT(*) > 1
              )
          )`,
      params: [ownerType],
    },
    {
      // Collapse duplicate link rows after rebind.
      sql: `DELETE FROM canon_evidence_links
        WHERE rowid NOT IN (
          SELECT MIN(rowid) FROM canon_evidence_links
          GROUP BY evidence_id, snapshot_id, owner_type, owner_id
        )`,
    },
    {
      sql: `DELETE FROM ${table}
        WHERE review_status != 'superseded'
          AND id NOT IN (
            SELECT MAX(id) FROM ${table}
            WHERE review_status != 'superseded'
            GROUP BY ${keyList}
          )
          AND (${keyList}) IN (
            SELECT ${keyList} FROM ${table}
            WHERE review_status != 'superseded'
            GROUP BY ${keyList}
            HAVING COUNT(*) > 1
          )`,
    },
  ];
}

function cleanupDanglingLinksAndOrphans(): SqlStatement[] {
  const ownerTables: Array<{ ownerType: string; table: string }> = [
    { ownerType: 'world_rule', table: 'canon_world_rules' },
    { ownerType: 'character', table: 'canon_characters' },
    { ownerType: 'relationship', table: 'canon_relationships' },
    { ownerType: 'plot_thread', table: 'canon_plot_threads' },
    { ownerType: 'experience', table: 'canon_character_experiences' },
    { ownerType: 'knowledge', table: 'canon_character_knowledge' },
    {
      ownerType: 'character_state',
      table: 'canon_character_state_snapshots',
    },
    { ownerType: 'timeline_event', table: 'canon_timeline_events' },
    { ownerType: 'alias', table: 'canon_character_aliases' },
  ];
  const statements: SqlStatement[] = ownerTables.map(({ ownerType, table }) => ({
    sql: `DELETE FROM canon_evidence_links
      WHERE owner_type = ?
        AND owner_id NOT IN (SELECT id FROM ${table})`,
    params: [ownerType],
  }));
  statements.push({
    sql: `DELETE FROM canon_evidence
      WHERE id NOT IN (SELECT evidence_id FROM canon_evidence_links)`,
  });
  return statements;
}

export function buildV34toV35Statements(): SqlStatement[] {
  return [
    ...rebuildAnalysisBatchesStatements(),
    ...rebindAndDedupByMaxId('canon_world_rules', 'world_rule', [
      'snapshot_id',
      'title',
    ]),
    ...rebindAndDedupByMaxId('canon_characters', 'character', [
      'snapshot_id',
      'canonical_name',
    ]),
    ...rebindAndDedupByMaxId('canon_plot_threads', 'plot_thread', [
      'snapshot_id',
      'title',
    ]),
    ...rebindAndDedupByMaxId('canon_relationships', 'relationship', [
      'snapshot_id',
      'source_character_id',
      'target_character_id',
      'relation_type',
    ]),
    ...rebindAndDedupByMaxId('canon_character_experiences', 'experience', [
      'snapshot_id',
      'character_id',
      'event_type',
      'title',
    ]),
    ...cleanupDanglingLinksAndOrphans(),
  ];
}
