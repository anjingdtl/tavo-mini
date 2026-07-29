import { all, one } from '../connection/query';
import { execute } from '../connection/execute';
import { executeTransaction } from '../connection/transaction';
import { openDatabase } from '../connection/openDatabase';
import { now } from './shared';

export type ContinuationResourceKind = 'character' | 'worldbook' | 'note' | 'preset';
export type ContinuationResourceUsage =
  | 'unclassified'
  | 'external_supplement'
  | 'original_mirror'
  | 'excluded';

export interface ContinuationResourceBinding {
  id: number;
  project_id: number;
  resource_kind: ContinuationResourceKind;
  resource_id: number;
  continuation_usage: ContinuationResourceUsage;
  enabled_for_continuation: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

const TABLE_FOR_KIND: Record<ContinuationResourceKind, string> = {
  character: 'characters', worldbook: 'worldbook_entries', note: 'notes', preset: 'presets',
};

async function assertOwned(projectId: number, kind: ContinuationResourceKind, resourceId: number) {
  const row = await one<{ id: number }>(
    `SELECT r.id FROM ${TABLE_FOR_KIND[kind]} r
     JOIN project_resources pr ON pr.resource_id = r.id AND pr.resource_type = ?
     WHERE r.id = ? AND pr.project_id = ? AND pr.enabled = 1 LIMIT 1`,
    [kind, resourceId, projectId],
  );
  if (!row) throw new Error('资料不存在，或不属于当前项目。');
}

export async function listContinuationResourceBindings(projectId: number): Promise<ContinuationResourceBinding[]> {
  return all<ContinuationResourceBinding>(
    'SELECT * FROM continuation_resource_bindings WHERE project_id = ? ORDER BY resource_kind, sort_order, id', [projectId],
  );
}

export async function setContinuationResourceUsage(input: {
  projectId: number; resourceKind: ContinuationResourceKind; resourceId: number;
  usage: ContinuationResourceUsage; sortOrder?: number;
}): Promise<void> {
  await assertOwned(input.projectId, input.resourceKind, input.resourceId);
  const enabled = input.usage === 'external_supplement' ? 1 : 0;
  const timestamp = now();
  const db = await openDatabase();
  const statements = [] as Array<{ sql: string; params: unknown[] }>;
  if (input.resourceKind === 'preset' && enabled) {
    statements.push({ sql: `UPDATE continuation_resource_bindings
      SET continuation_usage = 'excluded', enabled_for_continuation = 0, updated_at = ?
      WHERE project_id = ? AND resource_kind = 'preset' AND enabled_for_continuation = 1`, params: [timestamp, input.projectId] });
  }
  statements.push({ sql: `INSERT INTO continuation_resource_bindings
    (project_id, resource_kind, resource_id, continuation_usage, enabled_for_continuation, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, resource_kind, resource_id) DO UPDATE SET
      continuation_usage = excluded.continuation_usage,
      enabled_for_continuation = excluded.enabled_for_continuation,
      sort_order = excluded.sort_order,
      updated_at = excluded.updated_at`, params: [input.projectId, input.resourceKind, input.resourceId, input.usage, enabled, input.sortOrder ?? 0, timestamp, timestamp] });
  await executeTransaction(db, statements);
}

export async function deleteContinuationResourceBindings(kind: ContinuationResourceKind, resourceId: number): Promise<void> {
  await execute(await openDatabase(), 'DELETE FROM continuation_resource_bindings WHERE resource_kind = ? AND resource_id = ?', [kind, resourceId]);
}

export async function getContinuationSupplementPreset(projectId: number): Promise<any | null> {
  return one(`SELECT p.* FROM presets p JOIN continuation_resource_bindings b
    ON b.resource_id = p.id AND b.resource_kind = 'preset'
    WHERE b.project_id = ? AND b.continuation_usage = 'external_supplement'
      AND b.enabled_for_continuation = 1 LIMIT 1`, [projectId]);
}
