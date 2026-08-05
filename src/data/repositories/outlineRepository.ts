/**
 * Outline repository (大纲创作模式升级, Schema 36).
 *
 * Outlines are a project-level first-class resource stored in the dedicated
 * `outlines` table. They do NOT go through the polymorphic `project_resources`
 * link table and are NOT part of the `ResourceType` union, so the existing
 * character/worldbook/note/preset switch and Record mappings stay untouched.
 *
 * Deterministic ordering: every list query sorts by `position ASC, id ASC`, so
 * the context builder stitches outlines in a stable, user-controlled order.
 */
import type {
  Outline,
  OutlineSourceType,
  OutlineUpdatePatch,
} from '../../types/outline';
import { estimateTokens } from '../../utils/tokenEstimator';
import { sha256Hex } from '../../services/continuation/hashUtils';
import { execute } from '../connection/execute';
import { all, one } from '../connection/query';
import { executeTransaction } from '../connection/transaction';
import { openDatabase } from '../connection/openDatabase';
import type { SqlStatement } from '../../services/database/transaction';

/** Map a raw DB row (snake_case, 0/1 booleans) to the Outline domain type. */
function mapRow(row: Record<string, any>): Outline {
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    title: String(row.title ?? ''),
    content: String(row.content ?? ''),
    sourceType: (row.source_type === 'txt' ? 'txt' : 'manual') as OutlineSourceType,
    sourceFileName: row.source_file_name ?? undefined,
    enabled: Number(row.enabled) === 1,
    position: Number(row.position ?? 0),
    estimatedTokens: Number(row.estimated_tokens ?? 0),
    contentHash: String(row.content_hash ?? ''),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

const SELECT_COLUMNS = `
  id, project_id, title, content, source_type, source_file_name,
  enabled, position, estimated_tokens, content_hash, created_at, updated_at
`;

/**
 * All outlines for a project, ordered by position then id (deterministic).
 * Use this for the management UI which must show disabled outlines too.
 */
export async function getOutlinesByProject(projectId: number): Promise<Outline[]> {
  const rows = await all<Record<string, any>>(
    `SELECT ${SELECT_COLUMNS} FROM outlines WHERE project_id = ? ORDER BY position ASC, id ASC`,
    [projectId],
  );
  return rows.map(mapRow);
}

/**
 * Only enabled outlines for a project, in deterministic order. Used by the
 * context builder so disabled outlines are never injected.
 */
export async function getEnabledOutlinesByProject(
  projectId: number,
): Promise<Outline[]> {
  const rows = await all<Record<string, any>>(
    `SELECT ${SELECT_COLUMNS} FROM outlines WHERE project_id = ? AND enabled = 1 ORDER BY position ASC, id ASC`,
    [projectId],
  );
  return rows.map(mapRow);
}

/** Single outline by id (across projects; id is globally unique). */
export async function getOutlineById(id: number): Promise<Outline | null> {
  const row = await one<Record<string, any>>(
    `SELECT ${SELECT_COLUMNS} FROM outlines WHERE id = ?`,
    [id],
  );
  return row ? mapRow(row) : null;
}

export interface CreateOutlineInput {
  title: string;
  content: string;
  sourceType?: OutlineSourceType;
  sourceFileName?: string;
  /** Override the default position (max+1). Used by import to preserve order. */
  position?: number;
}

/**
 * Create a new outline. Defaults to `enabled = 0` (off) so newly created or
 * imported outlines never silently alter the next generation. Position auto-
 * increments to the project's current max + 1 unless explicitly provided.
 */
export async function createOutline(
  projectId: number,
  input: CreateOutlineInput,
): Promise<number> {
  const database = await openDatabase();
  const timestamp = Date.now();
  const content = input.content ?? '';
  const title = input.title ?? '';
  const sourceType: OutlineSourceType = input.sourceType === 'txt' ? 'txt' : 'manual';
  const position =
    input.position ??
    (await nextPosition(projectId));
  const result = await execute(
    database,
    `INSERT INTO outlines
      (project_id, title, content, source_type, source_file_name, enabled, position, estimated_tokens, content_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    [
      projectId,
      title,
      content,
      sourceType,
      input.sourceFileName ?? null,
      position,
      estimateTokens(content),
      sha256Hex(content),
      timestamp,
      timestamp,
    ],
  );
  return result.insertId!;
}

async function nextPosition(projectId: number): Promise<number> {
  const row = await one<{ max_pos: number | null }>(
    `SELECT MAX(position) AS max_pos FROM outlines WHERE project_id = ?`,
    [projectId],
  );
  return (row?.max_pos ?? -1) + 1;
}

/**
 * Update an outline's title and/or content. Recomputes token estimate and
 * content hash when the content changes. Bumps updated_at.
 */
export async function updateOutline(
  id: number,
  patch: OutlineUpdatePatch,
): Promise<void> {
  const sets: string[] = [];
  const values: any[] = [];
  if (patch.title !== undefined) {
    sets.push('title = ?');
    values.push(patch.title);
  }
  if (patch.content !== undefined) {
    sets.push('content = ?');
    values.push(patch.content);
    sets.push('estimated_tokens = ?');
    values.push(estimateTokens(patch.content));
    sets.push('content_hash = ?');
    values.push(sha256Hex(patch.content));
  }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  values.push(Date.now());
  values.push(id);
  await execute(
    await openDatabase(),
    `UPDATE outlines SET ${sets.join(', ')} WHERE id = ?`,
    values,
  );
}

/** Permanently delete an outline. */
export async function deleteOutline(id: number): Promise<void> {
  await execute(await openDatabase(), 'DELETE FROM outlines WHERE id = ?', [id]);
}

/**
 * Enable or disable a single outline. Scoped by projectId so a stale id from
 * another project cannot be toggled.
 */
export async function setOutlineEnabled(
  projectId: number,
  outlineId: number,
  enabled: boolean,
): Promise<void> {
  await execute(
    await openDatabase(),
    'UPDATE outlines SET enabled = ?, updated_at = ? WHERE id = ? AND project_id = ?',
    [enabled ? 1 : 0, Date.now(), outlineId, projectId],
  );
}

/**
 * Rewrite the position of every outline in a project to match the provided
 * id order. Runs in one transaction so the order is never half-applied.
 *
 * Strict validation before any write:
 *  - no duplicate ids
 *  - every id belongs to the project
 *  - count and set of ids must exactly match the project's outlines
 */
export async function reorderOutlines(
  projectId: number,
  orderedIds: number[],
): Promise<void> {
  if (new Set(orderedIds).size !== orderedIds.length) {
    throw new Error('大纲排序失败：存在重复的大纲 ID');
  }
  const existing = await getOutlinesByProject(projectId);
  const existingIds = existing.map(o => o.id).sort((a, b) => a - b);
  const incomingIds = [...orderedIds].sort((a, b) => a - b);
  if (existingIds.length !== incomingIds.length) {
    throw new Error(
      `大纲排序失败：传入 ${incomingIds.length} 个 ID，项目实际有 ${existingIds.length} 份大纲`,
    );
  }
  for (let i = 0; i < existingIds.length; i += 1) {
    if (existingIds[i] !== incomingIds[i]) {
      throw new Error('大纲排序失败：传入的 ID 集合与项目大纲不一致');
    }
  }
  const database = await openDatabase();
  const statements: SqlStatement[] = [];
  const now = Date.now();
  orderedIds.forEach((id, index) => {
    statements.push({
      sql: 'UPDATE outlines SET position = ?, updated_at = ? WHERE id = ? AND project_id = ?',
      params: [index, now, id, projectId],
    });
  });
  if (statements.length === 0) return;
  await executeTransaction(database, statements);
}

/**
 * Compact position gaps left after deletions so future auto-positions stay
 * tight. Optional hygiene; ordering remains correct without it because every
 * list query sorts by position then id.
 */
export async function recalculateOutlinePositions(
  projectId: number,
): Promise<void> {
  const outlines = await getOutlinesByProject(projectId);
  const database = await openDatabase();
  const statements: SqlStatement[] = outlines.map((outline, index) => ({
    sql: 'UPDATE outlines SET position = ? WHERE id = ?',
    params: [index, outline.id],
  }));
  if (statements.length === 0) return;
  await executeTransaction(database, statements);
}
