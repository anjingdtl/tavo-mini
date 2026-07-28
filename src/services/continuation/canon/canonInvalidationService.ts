/**
 * Canon invalidation when source / boundary / extraction changes (Spec §14).
 */
import { openDatabase } from '../../../data/connection/openDatabase';
import { markAnalysisOutdated } from '../continuationSourceRepository';

/** Invalidate all active Canon for a project in one transaction path. */
export async function invalidateProjectCanon(projectId: number): Promise<void> {
  const db = await openDatabase();
  await markAnalysisOutdated(db, projectId);
}

/** Whether Phase 3 may call CanonQueryService for this project. */
export async function isCanonReadyForGeneration(
  projectId: number,
): Promise<boolean> {
  const db = await openDatabase();
  const [r] = await db.executeSql(
    `SELECT s.active_canon_snapshot_id AS sid, snap.status AS status, snap.profile AS profile
      FROM continuation_settings s
      LEFT JOIN continuation_canon_snapshots snap
        ON snap.id = s.active_canon_snapshot_id
      WHERE s.project_id = ?`,
    [projectId],
  );
  if (r.rows.length === 0) return false;
  const row = r.rows.item(0);
  return !!row.sid && row.status === 'ready' && row.profile !== 'quick';
}
