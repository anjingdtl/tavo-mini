/**
 * Atomic activation of a Canon snapshot together with its style profile
 * (Spec §6.3).
 *
 * This replaces the tail of the legacy `activateSnapshot`: instead of
 * activating Canon and the active style pointer in separate writes, everything
 * that must hold together is committed in ONE `executeTransaction`. If the
 * transaction fails there is NO half-activated state — Canon is not ready and
 * the active style pointer is unchanged (Spec §4, §6.3).
 *
 * Contract:
 *  - `styleProfileId` is required → that profile becomes ready and active.
 *  - `allowStyleSkip` is retained only to deserialize legacy callers; skipping
 *    original style is no longer permitted.
 *  - Old active style profiles whose source/boundary no longer match are
 *    marked outdated IN THE SAME transaction.
 */
import type SQLite from 'react-native-sqlite-storage';
import { openDatabase } from '../../../data/connection/openDatabase';
import { executeTransaction } from '../../../data/connection/transaction';
import type { SqlStatement } from '../../../data/connection/transaction';
import { now } from '../../../data/repositories/shared';
import { continuationSourceReader } from '../continuationSourceReader';
import { ContinuationSnapshotOutdatedError } from '../types';
import {
  getSnapshotById,
  countFutureEvidence,
  countOrphanEvidence,
  getRunById,
} from './canonRepository';
import { buildDefaultCanonAdoptionStatements } from './canonAnalysisService';
import {
  getStyleProfileById,
  type ContinuationStyleProfileRow,
} from '../styleProfile/styleProfileRepository';
import { computeStyleProfileHash } from '../styleProfile/styleProfileHash';

export interface ActivateSnapshotAndStyleProfileInput {
  projectId: number;
  analysisRunId: string;
  canonSnapshotId: string;
  /** The style profile to activate alongside Canon. */
  styleProfileId: string | null;
  /** @deprecated Legacy field; a missing style profile is always rejected. */
  allowStyleSkip: boolean;
}

/**
 * Atomically activate a Canon snapshot and (optionally) its style profile.
 *
 * Performs source/boundary re-verification, default Canon adoption, snapshot
 * status transitions, style profile invalidation + activation, settings
 * pointer updates, run completion, and generation-run invalidation — all in a
 * single transaction so a failure leaves no half-activated state.
 */
export async function activateSnapshotAndStyleProfile(
  input: ActivateSnapshotAndStyleProfileInput,
): Promise<void> {
  if (!input.styleProfileId) {
    throw new Error(
      '缺少可用的原著风格画像，无法激活。请先完成或重试原著风格分析。',
    );
  }

  const db = await openDatabase();
  const snap = await getSnapshotById(input.canonSnapshotId);
  if (!snap || snap.projectId !== input.projectId) {
    throw new Error('快照不存在');
  }
  if (snap.profile === 'quick') {
    throw new Error('旧版 Quick 离线预览不能激活，请重新发起 LLM 原著分析。');
  }
  if (snap.status !== 'awaiting_review' && snap.status !== 'ready') {
    throw new Error(`快照状态 ${snap.status} 不可激活`);
  }

  const analysisRun = await getRunById(input.analysisRunId);
  if (
    !analysisRun ||
    analysisRun.projectId !== input.projectId ||
    analysisRun.canonSnapshotId !== input.canonSnapshotId ||
    // A retry may add the missing style profile after an older Canon run was
    // already completed (or failed at style analysis). Re-applying this same
    // source-bound snapshot is safe and atomically refreshes the active style
    // pointer; every other identity/source guard below still applies.
    !['running', 'awaiting_review', 'completed', 'failed'].includes(
      analysisRun.state,
    )
  ) {
    throw new Error('分析任务不存在、已变更或当前状态不可激活');
  }

  // Re-verify Phase 1 source binding (must match the live active source).
  const live = await continuationSourceReader.getSnapshot(input.projectId);
  if (
    live.sourceId !== snap.sourceId ||
    live.sourceVersion !== snap.sourceVersion ||
    live.normalizedSha256 !== snap.sourceSha256 ||
    live.parserVersion !== snap.parserVersion ||
    live.normalizationVersion !== snap.normalizationVersion ||
    live.boundary.chapterId !== snap.boundaryChapterId ||
    live.boundary.charOffsetExclusive !== snap.boundaryCharOffsetExclusive
  ) {
    // Mark the snapshot outdated OUTSIDE the activation transaction; this is a
    // best-effort single statement and a failure here must not corrupt the
    // atomic activation (there is nothing to activate anyway).
    await markSnapshotOutdated(db, input.canonSnapshotId);
    throw new ContinuationSnapshotOutdatedError('源或边界已变化，无法激活。');
  }

  const future = await countFutureEvidence(
    input.canonSnapshotId,
    snap.boundaryCharOffsetExclusive,
  );
  if (future > 0) {
    throw new Error(`存在 ${future} 条未来证据，禁止激活`);
  }
  const orphans = await countOrphanEvidence(input.canonSnapshotId);
  if (orphans > 0) {
    throw new Error(`存在 ${orphans} 条孤儿证据，禁止激活`);
  }

  let styleProfile: ContinuationStyleProfileRow | null = null;
  if (input.styleProfileId) {
    styleProfile = await getStyleProfileById(input.styleProfileId);
    if (!styleProfile) throw new Error('风格画像不存在');
    if (
      styleProfile.projectId !== input.projectId ||
      styleProfile.canonSnapshotId !== input.canonSnapshotId ||
      styleProfile.analysisRunId !== input.analysisRunId ||
      styleProfile.state !== 'ready' ||
      styleProfile.reviewStatus === 'ignored' ||
      styleProfile.sourceId !== live.sourceId ||
      styleProfile.sourceVersion !== live.sourceVersion ||
      styleProfile.sourceSha256 !== live.normalizedSha256 ||
      styleProfile.parserVersion !== live.parserVersion ||
      styleProfile.normalizationVersion !== live.normalizationVersion ||
      styleProfile.boundaryChapterId !== live.boundary.chapterId ||
      styleProfile.boundaryPosition !== live.boundary.chapterPosition ||
      styleProfile.boundaryCharOffsetExclusive !==
        live.boundary.charOffsetExclusive
    ) {
      throw new Error('风格画像与本次 Canon 分析的 source/boundary 不匹配');
    }
    const recalculatedHash = computeStyleProfileHash({
      profile: styleProfile.profileJson,
      metrics: styleProfile.metricsJson,
      sampleRefs: styleProfile.sampleRefsJson,
      profileSchemaVersion: styleProfile.profileSchemaVersion,
      analyzerVersion: styleProfile.analyzerVersion,
      userOverrides: styleProfile.userOverridesJson,
    });
    if (recalculatedHash !== styleProfile.profileHash) {
      throw new Error('风格画像哈希校验失败，请重新运行风格分析');
    }
  }

  const ts = now();
  const statements: SqlStatement[] = [
    // 1. Default Canon adoption: confirm pending AI records for this snapshot.
    ...buildDefaultCanonAdoptionStatements(input.canonSnapshotId, ts),
    // 2. Old ready Canon snapshots → outdated.
    {
      sql: `UPDATE continuation_canon_snapshots
        SET status = 'outdated', updated_at = ?
        WHERE project_id = ? AND status = 'ready' AND id != ?`,
      params: [ts, input.projectId, input.canonSnapshotId],
    },
    // 3. New Canon snapshot → ready.
    {
      sql: `UPDATE continuation_canon_snapshots
        SET status = 'ready', activated_at = ?, updated_at = ?
        WHERE id = ?`,
      params: [ts, ts, input.canonSnapshotId],
    },
  ];

  // 4. Style invalidation + activation, inside the SAME transaction.
  //    Old active style profiles whose source/boundary no longer matches the
  //    live snapshot are marked outdated. This mirrors
  //    `invalidateStyleProfilesForProject` but inlined so it commits atomically
  //    with the Canon activation (Spec §6.3).
  statements.push({
    sql: `UPDATE continuation_style_profiles
      SET state = 'outdated', updated_at = ?
      WHERE project_id = ?
        AND state NOT IN ('outdated', 'cancelled')
        AND NOT (
          source_id = ? AND source_version = ? AND source_sha256 = ?
          AND boundary_chapter_id = ? AND boundary_position = ?
          AND boundary_char_offset_exclusive = ?
        )`,
    params: [
      ts,
      input.projectId,
      live.sourceId,
      live.sourceVersion,
      live.normalizedSha256,
      live.boundary.chapterId,
      live.boundary.chapterPosition,
      live.boundary.charOffsetExclusive,
    ],
  });

  if (input.styleProfileId) {
    // The supplied profile must match the live fingerprint to be activated.
    statements.push({
      sql: `UPDATE continuation_style_profiles
        SET state = 'ready', error_code = NULL, error_message = NULL,
            completed_at = COALESCE(completed_at, ?), updated_at = ?
        WHERE id = ? AND project_id = ?
          AND source_id = ? AND source_version = ? AND source_sha256 = ?
          AND boundary_chapter_id = ? AND boundary_position = ?
          AND boundary_char_offset_exclusive = ?`,
      params: [
        ts,
        ts,
        input.styleProfileId,
        input.projectId,
        live.sourceId,
        live.sourceVersion,
        live.normalizedSha256,
        live.boundary.chapterId,
        live.boundary.chapterPosition,
        live.boundary.charOffsetExclusive,
      ],
    });
  }

  // 5. Update continuation_settings: active Canon + active style + analysis
  //    status, together.
  statements.push({
    sql: `UPDATE continuation_settings SET
        active_canon_snapshot_id = ?,
        active_style_profile_id = ?,
        analysis_status = 'ready',
        updated_at = ?
      WHERE project_id = ?`,
    params: [input.canonSnapshotId, input.styleProfileId, ts, input.projectId],
  });

  // 6. Complete the explicitly supplied analysis run bound to this snapshot.
  statements.push({
    sql: `UPDATE continuation_analysis_runs SET state = 'completed', updated_at = ?
      WHERE id = ? AND project_id = ? AND canon_snapshot_id = ?
        AND state IN ('running', 'awaiting_review', 'completed', 'failed')`,
    params: [ts, input.analysisRunId, input.projectId, input.canonSnapshotId],
  });

  // 7. In-progress generation runs compiled against the previous Canon → outdated.
  statements.push({
    sql: `UPDATE continuation_generation_runs
      SET state = 'outdated', error_code = 'outdated',
          error_message = ?, updated_at = ?
      WHERE project_id = ?
        AND state IN ('queued', 'running', 'awaiting_user', 'interrupted')`,
    params: ['active_canon_changed', ts, input.projectId],
  });

  // executeTransaction is atomic: either all statements commit or none do.
  const criticalStatementIndexes = new Set<number>();
  statements.forEach((statement, index) => {
    if (
      /SET status = 'ready'/.test(statement.sql) ||
      /SET state = 'ready'/.test(statement.sql) ||
      /UPDATE continuation_settings SET/.test(statement.sql) ||
      /UPDATE continuation_analysis_runs SET state = 'completed'/.test(
        statement.sql,
      )
    ) {
      criticalStatementIndexes.add(index + 1);
    }
  });
  await executeTransaction(db, statements, {
    onStatementComplete: (oneBasedIndex, rowsAffected) => {
      if (criticalStatementIndexes.has(oneBasedIndex) && rowsAffected !== 1) {
        throw new Error(
          `激活事务关键更新未命中 1 行：statement ${oneBasedIndex}`,
        );
      }
    },
  });

  // Post-commit invariant check: the snapshot really is ready now.
  const activated = await getSnapshotById(input.canonSnapshotId);
  if (!activated || activated.status !== 'ready') {
    throw new Error('激活失败');
  }
}

/** Best-effort single-statement snapshot invalidation (pre-activation guard). */
async function markSnapshotOutdated(
  db: SQLite.SQLiteDatabase,
  snapshotId: string,
): Promise<void> {
  const ts = now();
  try {
    await executeTransaction(db, [
      {
        sql: `UPDATE continuation_canon_snapshots
          SET status = 'outdated', updated_at = ?
          WHERE id = ?`,
        params: [ts, snapshotId],
      },
    ]);
  } catch {
    // Swallow: the caller is about to throw the real outdated error anyway.
  }
}
