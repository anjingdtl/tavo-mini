import { execute } from '../connection/execute';
import { all, one } from '../connection/query';
import { executeTransaction } from '../connection/transaction';
import { openDatabase } from '../connection/openDatabase';
import { now, touchProject } from './shared';

export async function getFreeformDocument(projectId: number): Promise<string> {
  const row = await one<{ content: string }>(
    'SELECT content FROM freeform_documents WHERE project_id = ?',
    [projectId],
  );
  return row?.content || '';
}

export async function setFreeformDocument(
  projectId: number,
  content: string,
): Promise<void> {
  await execute(
    await openDatabase(),
    'INSERT OR REPLACE INTO freeform_documents (project_id, content, updated_at) VALUES (?, ?, ?)',
    [projectId, content, now()],
  );
  await touchProject(projectId);
}

// ---------------------------------------------------------------------------
// Content Revisions
// ---------------------------------------------------------------------------

export async function createContentRevision(fields: {
  projectId: number;
  targetType: string;
  targetId: number;
  title: string;
  content: string;
  source: string;
  sourceRef?: string | null;
}): Promise<number> {
  const createdAt = new Date().toISOString();
  const result = await execute(
    await openDatabase(),
    `INSERT INTO content_revisions (project_id, target_type, target_id, title, content, source, source_ref, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fields.projectId,
      fields.targetType,
      fields.targetId,
      fields.title,
      fields.content,
      fields.source,
      fields.sourceRef ?? null,
      createdAt,
    ],
  );
  return result.insertId;
}

export async function getContentRevisions(
  targetType: string,
  targetId: number,
): Promise<any[]> {
  return all(
    `SELECT * FROM content_revisions WHERE target_type = ? AND target_id = ? ORDER BY created_at DESC`,
    [targetType, targetId],
  );
}

export async function getLatestContentRevision(
  targetType: string,
  targetId: number,
): Promise<any | null> {
  return one(
    `SELECT * FROM content_revisions WHERE target_type = ? AND target_id = ? ORDER BY created_at DESC LIMIT 1`,
    [targetType, targetId],
  );
}

export async function deleteContentRevision(id: number): Promise<void> {
  await execute(
    await openDatabase(),
    'DELETE FROM content_revisions WHERE id = ?',
    [id],
  );
}

export async function trimContentRevisions(
  targetType: string,
  targetId: number,
  maxAuto = 50,
  maxManual = 20,
): Promise<void> {
  const database = await openDatabase();
  // V2.2.2 修复：原 transaction callback 内部多次 await → InvalidStateError。
  // 改成：先 async 收集要删的 id，再合并到一次同步 push 事务。
  const autoRows = await all<{ id: number }>(
    `SELECT id FROM content_revisions
     WHERE target_type = ? AND target_id = ? AND source != 'manual_checkpoint'
     ORDER BY created_at DESC`,
    [targetType, targetId],
  );
  const manualRows = await all<{ id: number }>(
    `SELECT id FROM content_revisions
     WHERE target_type = ? AND target_id = ? AND source = 'manual_checkpoint'
     ORDER BY created_at DESC`,
    [targetType, targetId],
  );
  const toDeleteAuto = autoRows.map(r => r.id).slice(maxAuto);
  const toDeleteManual = manualRows.map(r => r.id).slice(maxManual);
  const stmts: Array<{ sql: string; params: any[] }> = [];
  for (const id of toDeleteAuto) {
    stmts.push({
      sql: 'DELETE FROM content_revisions WHERE id = ?',
      params: [id],
    });
  }
  for (const id of toDeleteManual) {
    stmts.push({
      sql: 'DELETE FROM content_revisions WHERE id = ?',
      params: [id],
    });
  }
  await executeTransaction(database, stmts);
}

// ---------------------------------------------------------------------------
// Generation Drafts
// ---------------------------------------------------------------------------

export async function createGenerationDraft(fields: {
  projectId: number;
  targetType: string;
  targetId: number;
  content: string;
  source: string;
  pipelineTaskId?: string | null;
  tokenCount: number;
}): Promise<number> {
  const createdAt = new Date().toISOString();
  const result = await execute(
    await openDatabase(),
    `INSERT INTO generation_drafts (project_id, target_type, target_id, content, source, pipeline_task_id, token_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fields.projectId,
      fields.targetType,
      fields.targetId,
      fields.content,
      fields.source,
      fields.pipelineTaskId ?? null,
      fields.tokenCount,
      createdAt,
    ],
  );
  return result.insertId;
}

export async function getGenerationDrafts(
  targetType: string,
  targetId: number,
): Promise<any[]> {
  return all(
    `SELECT * FROM generation_drafts WHERE target_type = ? AND target_id = ? ORDER BY created_at DESC`,
    [targetType, targetId],
  );
}

export async function getGenerationDraft(id: number): Promise<any | null> {
  return one(`SELECT * FROM generation_drafts WHERE id = ?`, [id]);
}

export async function deleteGenerationDraft(id: number): Promise<void> {
  await execute(
    await openDatabase(),
    'DELETE FROM generation_drafts WHERE id = ?',
    [id],
  );
}

export async function deleteGenerationDraftsByTarget(
  targetType: string,
  targetId: number,
): Promise<void> {
  await execute(
    await openDatabase(),
    'DELETE FROM generation_drafts WHERE target_type = ? AND target_id = ?',
    [targetType, targetId],
  );
}
