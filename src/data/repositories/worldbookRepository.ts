import { estimateTokens } from '../../utils/tokenEstimator';
import { execute } from '../connection/execute';
import { all, one } from '../connection/query';
import { executeTransaction } from '../connection/transaction';
import { openDatabase } from '../connection/openDatabase';
import {
  linkResourceToProject,
  deleteProjectResourceLinks,
  setProjectResourceEnabled,
  usageJoin,
} from './projectRepository';
import { now, updateColumns, type ResourceType, type Row } from './shared';

export async function getAllWorldbookEntries(
  projectId?: number,
): Promise<Row[]> {
  return all<Row>(
    `SELECT w.*, wc.name AS collection_name, wc.enabled AS collection_enabled, wc.max_tokens AS collection_max_tokens, ${usageJoin(
      'worldbook',
      'w',
      projectId,
    )}
     FROM worldbook_entries w
     LEFT JOIN worldbook_collections wc ON wc.id = w.collection_id
     ORDER BY wc.id DESC, w.position ASC, w.id DESC`,
  );
}

export async function setAllProjectResourcesEnabled(
  projectId: number,
  resourceType: ResourceType,
  enabled: boolean,
): Promise<void> {
  const idColumnSql: Record<ResourceType, string> = {
    character: 'SELECT id FROM characters',
    worldbook: 'SELECT id FROM worldbook_entries',
    note: 'SELECT id FROM notes',
    preset: 'SELECT id FROM presets',
  };
  const rows = await all<{ id: number }>(idColumnSql[resourceType]);
  for (const row of rows) {
    await setProjectResourceEnabled(projectId, resourceType, row.id, enabled);
  }
}

export async function setWorldbookCollectionEnabledForProject(
  projectId: number,
  collectionId: number,
  enabled: boolean,
): Promise<void> {
  const database = await openDatabase();
  // V2.2.2 修复：改用 runInTransactionSafe。先做必要的 async 读（entry id 列表），
  // 再把所有写入合并到一次同步 push 的事务里。
  const stmts: Array<{ sql: string; params: any[] }> = [];
  const rows = await all<{ id: number }>(
    'SELECT id FROM worldbook_entries WHERE collection_id = ?',
    [collectionId],
  );
  for (const row of rows) {
    stmts.push({
      sql: 'INSERT OR REPLACE INTO project_resources (project_id, resource_type, resource_id, enabled) VALUES (?, ?, ?, ?)',
      params: [projectId, 'worldbook', row.id, enabled ? 1 : 0],
    });
  }
  await executeTransaction(database, stmts);
}

export async function getWorldbookEntriesByProject(
  projectId: number,
): Promise<Row[]> {
  return all<Row>(
    `SELECT w.*, wc.name AS collection_name, wc.enabled AS collection_enabled, wc.max_tokens AS collection_max_tokens FROM worldbook_entries w
     JOIN project_resources pr ON pr.resource_id = w.id AND pr.resource_type = 'worldbook'
     LEFT JOIN worldbook_collections wc ON wc.id = w.collection_id
     WHERE pr.project_id = ? AND pr.enabled = 1 AND w.enabled = 1
     ORDER BY w.position ASC, w.id ASC`,
    [projectId],
  );
}

export async function getWorldbookCollections(
  projectId?: number,
): Promise<Row[]> {
  if (!projectId) {
    return all<Row>('SELECT * FROM worldbook_collections ORDER BY id DESC');
  }
  return all<Row>(
    `SELECT wc.*, COUNT(w.id) AS entry_count,
            CASE WHEN COUNT(w.id) = 0 THEN 1
                 WHEN SUM(CASE WHEN pr.enabled = 1 THEN 1 ELSE 0 END) > 0 THEN 1
                 ELSE 0 END AS enabled_for_project
     FROM worldbook_collections wc
     LEFT JOIN worldbook_entries w ON w.collection_id = wc.id
     LEFT JOIN project_resources pr ON pr.resource_id = w.id AND pr.resource_type = 'worldbook' AND pr.project_id = ?
     GROUP BY wc.id
     ORDER BY wc.id DESC`,
    [projectId],
  );
}

export async function createWorldbookCollection(
  projectId: number,
  name: string,
  extra: Partial<Row> = {},
): Promise<number> {
  const result = await execute(
    await openDatabase(),
    'INSERT INTO worldbook_collections (project_id, name, enabled, max_tokens, estimated_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [
      0,
      name,
      extra.enabled === 0 ? 0 : 1,
      Number(extra.max_tokens || 50000),
      Number(extra.estimated_tokens || 0),
      now(),
    ],
  );
  return result.insertId!;
}

export async function updateWorldbookCollection(
  id: number,
  fields: Row,
): Promise<void> {
  await updateColumns(
    'worldbook_collections',
    id,
    new Set(['name', 'enabled', 'max_tokens', 'estimated_tokens']),
    fields,
  );
}

export async function updateWorldbookCollectionTokenEstimate(
  id: number,
): Promise<void> {
  const rows = await all<{ content: string }>(
    'SELECT content FROM worldbook_entries WHERE collection_id = ?',
    [id],
  );
  const estimatedTokens = rows.reduce(
    (total, row) => total + estimateTokens(row.content),
    0,
  );
  await updateWorldbookCollection(id, { estimated_tokens: estimatedTokens });
}

export async function deleteWorldbookCollection(id: number): Promise<void> {
  const database = await openDatabase();
  const entries = await all<{ id: number }>(
    'SELECT id FROM worldbook_entries WHERE collection_id = ?',
    [id],
  );
  // V2.2.2 修复：改用 runInTransactionSafe。先 async 读 entry id，再合并到一次同步 push 事务。
  const stmts: Array<{ sql: string; params: any[] }> = [];
  for (const entry of entries) {
    stmts.push({
      sql: 'DELETE FROM project_resources WHERE resource_type = ? AND resource_id = ?',
      params: ['worldbook', entry.id],
    });
  }
  stmts.push({
    sql: 'DELETE FROM worldbook_entries WHERE collection_id = ?',
    params: [id],
  });
  stmts.push({
    sql: 'DELETE FROM worldbook_collections WHERE id = ?',
    params: [id],
  });
  await executeTransaction(database, stmts);
}

export async function getWorldbookEntryById(id: number): Promise<Row | null> {
  return one<Row>('SELECT * FROM worldbook_entries WHERE id = ?', [id]);
}

export async function getWorldbookEntriesByCollection(
  collectionId: number,
): Promise<Row[]> {
  return all<Row>(
    'SELECT * FROM worldbook_entries WHERE collection_id = ? ORDER BY position ASC, id ASC',
    [collectionId],
  );
}

export async function createWorldbookEntry(
  projectId: number,
  keywordPrimary: string,
  content: string,
  enabled: number,
  extra: Partial<Row> = {},
): Promise<number> {
  const estimatedTokens = estimateTokens(content);
  const result = await execute(
    await openDatabase(),
    'INSERT INTO worldbook_entries (project_id, collection_id, keyword_primary, keyword_secondary, content, comment, enabled, constant, max_tokens, estimated_tokens, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      0,
      Number(extra.collection_id || 0),
      keywordPrimary,
      extra.keyword_secondary || '',
      content,
      extra.comment || '',
      enabled,
      Number(extra.constant || 0),
      Number(extra.max_tokens || 2000),
      estimatedTokens,
      Number(extra.position || 0),
      now(),
    ],
  );
  const id = result.insertId!;
  await linkResourceToProject(projectId, 'worldbook', id);
  if (extra.collection_id)
    await updateWorldbookCollectionTokenEstimate(Number(extra.collection_id));
  return id;
}

const WB_COLUMNS = new Set([
  'collection_id',
  'keyword_primary',
  'keyword_secondary',
  'content',
  'comment',
  'enabled',
  'constant',
  'max_tokens',
  'estimated_tokens',
  'position',
]);

export async function updateWorldbookEntry(
  id: number,
  fields: Row,
): Promise<void> {
  if (typeof fields.content === 'string' && fields.estimated_tokens == null) {
    fields.estimated_tokens = estimateTokens(fields.content);
  }
  await updateColumns('worldbook_entries', id, WB_COLUMNS, fields);
  const entry = await getWorldbookEntryById(id);
  if (entry?.collection_id)
    await updateWorldbookCollectionTokenEstimate(Number(entry.collection_id));
}

export async function deleteWorldbookEntry(id: number): Promise<void> {
  const entry = await getWorldbookEntryById(id);
  await deleteProjectResourceLinks('worldbook', id);
  await execute(
    await openDatabase(),
    'DELETE FROM worldbook_entries WHERE id = ?',
    [id],
  );
  if (entry?.collection_id)
    await updateWorldbookCollectionTokenEstimate(Number(entry.collection_id));
}

export async function setAllWorldbookEntriesEnabledByCollection(
  collectionId: number,
  enabled: boolean,
): Promise<void> {
  await execute(
    await openDatabase(),
    'UPDATE worldbook_entries SET enabled = ? WHERE collection_id = ?',
    [enabled ? 1 : 0, collectionId],
  );
}
