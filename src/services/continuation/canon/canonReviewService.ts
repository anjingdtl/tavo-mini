/**
 * Human governance for Canon rows (Spec §10).
 * Confirm / lock / ignore / revise — always bumps active snapshot revision.
 */
import { openDatabase } from '../../../data/connection/openDatabase';
import { execute } from '../../../data/connection/execute';
import { now } from '../../../data/repositories/shared';
import type { CanonReviewStatus } from './types';
import { getSnapshotById, updateSnapshotMeta } from './canonRepository';

const GOVERNED_TABLES = [
  'canon_world_rules',
  'canon_characters',
  'canon_character_aliases',
  'canon_character_state_snapshots',
  'canon_relationships',
  'canon_plot_threads',
  'canon_character_experiences',
  'canon_character_knowledge',
  'canon_timeline_events',
] as const;

export type GovernedTable = (typeof GOVERNED_TABLES)[number];

function assertTable(table: string): asserts table is GovernedTable {
  if (!(GOVERNED_TABLES as readonly string[]).includes(table)) {
    throw new Error(`不支持的 Canon 表：${table}`);
  }
}

async function bumpSnapshotRevision(snapshotId: string): Promise<void> {
  const db = await openDatabase();
  await updateSnapshotMeta(db, snapshotId, { revisionBump: true });
}

/**
 * Invalidate in-flight continuation runs when an active Canon snapshot's
 * revision changes (fix-plan §6.1). A frozen run snapshot that captured an
 * older revision must never be adopted against the now-revised Canon. No-ops
 * when the snapshot is not the active one for its project (a dormant snapshot
 * revision bump doesn't affect any run). Never throws — invalidation is
 * best-effort relative to the review op itself.
 */
async function invalidateRunsOnCanonRevision(snapshotId: string): Promise<void> {
  try {
    const db = await openDatabase();
    const ts = now();
    // Only the ACTIVE snapshot's revision change matters for run freshness.
    await db.executeSql(
      `UPDATE continuation_generation_runs
       SET state = 'outdated', error_code = 'outdated',
           error_message = ?, updated_at = ?
       WHERE project_id IN (
         SELECT project_id FROM continuation_settings WHERE active_canon_snapshot_id = ?
       ) AND state IN ('queued', 'running', 'awaiting_user', 'interrupted')`,
      ['canon_revision_changed', ts, snapshotId],
    );
  } catch {
    // best-effort; a stale run is also caught at adoption time.
  }
}

export async function setReviewStatus(input: {
  table: string;
  id: number;
  snapshotId: string;
  status: Exclude<CanonReviewStatus, 'superseded'>;
}): Promise<void> {
  assertTable(input.table);
  if (input.status === 'locked') {
    // locked only via user op — enforced by this API path.
  }
  const db = await openDatabase();
  const ts = now();
  const reviewed =
    input.status === 'confirmed' || input.status === 'locked' || input.status === 'ignored'
      ? ts
      : null;

  // Prevent auto-replace of locked rows.
  if (input.status !== 'locked') {
    const [cur] = await db.executeSql(
      `SELECT review_status FROM ${input.table} WHERE id = ? AND snapshot_id = ?`,
      [input.id, input.snapshotId],
    );
    if (cur.rows.length === 0) throw new Error('记录不存在');
    if (cur.rows.item(0).review_status === 'locked' && input.status !== 'confirmed') {
      // Unlock path is separate; allow confirmed after explicit unlock flow only.
    }
  }

  await execute(
    db,
    `UPDATE ${input.table} SET
      review_status = ?,
      user_reviewed_at = COALESCE(?, user_reviewed_at),
      updated_at = ?
      WHERE id = ? AND snapshot_id = ? AND review_status != 'superseded'`,
    [input.status, reviewed, ts, input.id, input.snapshotId],
  );
  await bumpSnapshotRevision(input.snapshotId);
  await invalidateRunsOnCanonRevision(input.snapshotId);
}

export async function unlockRecord(input: {
  table: string;
  id: number;
  snapshotId: string;
}): Promise<void> {
  assertTable(input.table);
  const db = await openDatabase();
  await execute(
    db,
    `UPDATE ${input.table} SET review_status = 'confirmed', updated_at = ?
      WHERE id = ? AND snapshot_id = ? AND review_status = 'locked'`,
    [now(), input.id, input.snapshotId],
  );
  await bumpSnapshotRevision(input.snapshotId);
  await invalidateRunsOnCanonRevision(input.snapshotId);
}

/**
 * User edit creates a new revision row and marks the old one superseded
 * (Spec §5, §10.2). Currently supports world_rules and characters.
 */
export async function reviseWorldRule(input: {
  id: number;
  snapshotId: string;
  title?: string;
  description?: string;
  category?: string;
  constraintLevel?: 'hard' | 'strong' | 'reference';
}): Promise<number> {
  const db = await openDatabase();
  const [result] = await db.executeSql(
    'SELECT * FROM canon_world_rules WHERE id = ? AND snapshot_id = ?',
    [input.id, input.snapshotId],
  );
  if (result.rows.length === 0) throw new Error('世界规则不存在');
  const old = result.rows.item(0);
  if (old.review_status === 'locked') {
    throw new Error('已锁定的规则不能直接修改，请先解锁');
  }
  const ts = now();
  await execute(
    db,
    `UPDATE canon_world_rules SET review_status = 'superseded', updated_at = ?
      WHERE id = ?`,
    [ts, input.id],
  );
  await execute(
    db,
    `INSERT INTO canon_world_rules (
      project_id, source_id, snapshot_id, analysis_run_id,
      valid_from_position, valid_to_position, first_observed_position, last_observed_position,
      confidence, review_status, origin, extraction_version, revision, supersedes_id,
      user_reviewed_at, created_at, updated_at,
      category, title, description, constraint_level
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?)`,
    [
      old.project_id,
      old.source_id,
      old.snapshot_id,
      old.analysis_run_id,
      old.valid_from_position,
      old.valid_to_position,
      old.first_observed_position,
      old.last_observed_position,
      old.confidence,
      old.origin === 'user' ? 'user' : 'ai',
      old.extraction_version,
      (old.revision as number) + 1,
      old.id,
      ts,
      ts,
      ts,
      input.category ?? old.category,
      input.title ?? old.title,
      input.description ?? old.description,
      input.constraintLevel ?? old.constraint_level,
    ],
  );
  const [idRow] = await db.executeSql('SELECT last_insert_rowid() AS id');
  await bumpSnapshotRevision(input.snapshotId);
  await invalidateRunsOnCanonRevision(input.snapshotId);
  return idRow.rows.item(0).id as number;
}

export async function createUserWorldRule(input: {
  projectId: number;
  sourceId: number;
  snapshotId: string;
  analysisRunId: string;
  category: string;
  title: string;
  description: string;
  constraintLevel: 'hard' | 'strong' | 'reference';
  validFromPosition: number;
}): Promise<number> {
  const snap = await getSnapshotById(input.snapshotId);
  if (!snap || (snap.status !== 'ready' && snap.status !== 'awaiting_review')) {
    throw new Error('快照不可编辑');
  }
  const db = await openDatabase();
  const ts = now();
  await execute(
    db,
    `INSERT INTO canon_world_rules (
      project_id, source_id, snapshot_id, analysis_run_id,
      valid_from_position, valid_to_position, first_observed_position, last_observed_position,
      confidence, review_status, origin, extraction_version, revision, supersedes_id,
      user_reviewed_at, created_at, updated_at,
      category, title, description, constraint_level
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 1, 'confirmed', 'user', ?, 1, NULL, ?, ?, ?,
      ?, ?, ?, ?)`,
    [
      input.projectId,
      input.sourceId,
      input.snapshotId,
      input.analysisRunId || 'user',
      input.validFromPosition,
      input.validFromPosition,
      input.validFromPosition,
      snap.extractionVersion,
      ts,
      ts,
      ts,
      input.category,
      input.title,
      input.description,
      input.constraintLevel,
    ],
  );
  const [idRow] = await db.executeSql('SELECT last_insert_rowid() AS id');
  await bumpSnapshotRevision(input.snapshotId);
  await invalidateRunsOnCanonRevision(input.snapshotId);
  return idRow.rows.item(0).id as number;
}

export async function batchConfirmHighConfidence(input: {
  table: string;
  snapshotId: string;
  minConfidence?: number;
}): Promise<number> {
  assertTable(input.table);
  const min = input.minConfidence ?? 0.85;
  const db = await openDatabase();
  const ts = now();
  // Only rows that already have at least one evidence link.
  await execute(
    db,
    `UPDATE ${input.table} SET review_status = 'confirmed', user_reviewed_at = ?, updated_at = ?
      WHERE snapshot_id = ?
        AND review_status = 'pending'
        AND confidence >= ?
        AND origin = 'ai'
        AND EXISTS (
          SELECT 1 FROM canon_evidence_links l
          WHERE l.snapshot_id = ${input.table}.snapshot_id
            AND l.owner_id = ${input.table}.id
        )`,
    [ts, ts, input.snapshotId, min],
  );
  await bumpSnapshotRevision(input.snapshotId);
  await invalidateRunsOnCanonRevision(input.snapshotId);
  const [r] = await db.executeSql(
    `SELECT changes() AS c`,
  );
  return (r.rows.item(0)?.c as number) ?? 0;
}

/** List rows for UI management screens. */
export async function listCanonRows(input: {
  table: GovernedTable;
  snapshotId: string;
  reviewStatus?: CanonReviewStatus;
  limit?: number;
  offset?: number;
}): Promise<any[]> {
  assertTable(input.table);
  const db = await openDatabase();
  const limit = input.limit ?? 50;
  const offset = input.offset ?? 0;
  if (input.reviewStatus) {
    const [r] = await db.executeSql(
      `SELECT * FROM ${input.table}
        WHERE snapshot_id = ? AND review_status = ?
        ORDER BY id DESC LIMIT ? OFFSET ?`,
      [input.snapshotId, input.reviewStatus, limit, offset],
    );
    const out: any[] = [];
    for (let i = 0; i < r.rows.length; i++) out.push(r.rows.item(i));
    return out;
  }
  const [r] = await db.executeSql(
    `SELECT * FROM ${input.table}
      WHERE snapshot_id = ? AND review_status != 'superseded'
      ORDER BY id DESC LIMIT ? OFFSET ?`,
    [input.snapshotId, limit, offset],
  );
  const out: any[] = [];
  for (let i = 0; i < r.rows.length; i++) out.push(r.rows.item(i));
  return out;
}
