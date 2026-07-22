import { estimateTokens } from '../../utils/tokenEstimator';
import { execute } from '../connection/execute';
import { all, one } from '../connection/query';
import { executeTransaction } from '../connection/transaction';
import { openDatabase } from '../connection/openDatabase';
import {
  linkResourceToProject,
  deleteProjectResourceLinks,
  usageJoin,
} from './projectRepository';
import { now, updateColumns, type Row } from './shared';

export async function getAllCharacters(projectId?: number): Promise<Row[]> {
  return all<Row>(
    `SELECT c.*, cc.name AS collection_name, cc.enabled AS collection_enabled, cc.max_tokens AS collection_max_tokens, ${usageJoin(
      'character',
      'c',
      projectId,
    )}
     FROM characters c
     LEFT JOIN character_collections cc ON cc.id = c.collection_id
     ORDER BY cc.id DESC, c.id DESC`,
  );
}

export async function getCharactersByProject(
  projectId: number,
): Promise<Row[]> {
  return all<Row>(
    `SELECT c.*, cc.name AS collection_name, cc.enabled AS collection_enabled, cc.max_tokens AS collection_max_tokens
     FROM characters c
     JOIN project_resources pr ON pr.resource_id = c.id AND pr.resource_type = 'character'
     LEFT JOIN character_collections cc ON cc.id = c.collection_id
     WHERE pr.project_id = ? AND pr.enabled = 1
     ORDER BY c.id ASC`,
    [projectId],
  );
}

export async function getCharacterById(id: number): Promise<Row | null> {
  return one<Row>(
    `SELECT c.*, cc.name AS collection_name, cc.enabled AS collection_enabled, cc.max_tokens AS collection_max_tokens
     FROM characters c
     LEFT JOIN character_collections cc ON cc.id = c.collection_id
     WHERE c.id = ?`,
    [id],
  );
}

export async function getCharacterCollections(
  projectId?: number,
): Promise<Row[]> {
  if (!projectId) {
    return all<Row>('SELECT * FROM character_collections ORDER BY id DESC');
  }
  return all<Row>(
    `SELECT cc.*, COUNT(c.id) AS character_count,
            CASE WHEN COUNT(c.id) = 0 THEN 1
                 WHEN SUM(CASE WHEN pr.enabled = 1 THEN 1 ELSE 0 END) > 0 THEN 1
                 ELSE 0 END AS enabled_for_project
     FROM character_collections cc
     LEFT JOIN characters c ON c.collection_id = cc.id
     LEFT JOIN project_resources pr ON pr.resource_id = c.id AND pr.resource_type = 'character' AND pr.project_id = ?
     GROUP BY cc.id
     ORDER BY cc.id DESC`,
    [projectId],
  );
}

export async function createCharacterCollection(
  _projectId: number,
  name: string,
  extra: Partial<Row> = {},
): Promise<number> {
  const result = await execute(
    await openDatabase(),
    'INSERT INTO character_collections (project_id, name, enabled, max_tokens, estimated_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?)',
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

export async function updateCharacterCollection(
  id: number,
  fields: Row,
): Promise<void> {
  await updateColumns(
    'character_collections',
    id,
    new Set(['name', 'enabled', 'max_tokens', 'estimated_tokens']),
    fields,
  );
}

export async function updateCharacterCollectionTokenEstimate(
  id: number,
): Promise<void> {
  const rows = await all<{ estimated_tokens: number }>(
    'SELECT estimated_tokens FROM characters WHERE collection_id = ?',
    [id],
  );
  const estimatedTokens = rows.reduce(
    (total, row) => total + Number(row.estimated_tokens || 0),
    0,
  );
  await updateCharacterCollection(id, { estimated_tokens: estimatedTokens });
}

export async function ensureDefaultCharacterCollection(
  projectId: number,
  name = '未分组角色',
): Promise<number> {
  const existing = await one<{ id: number }>(
    'SELECT id FROM character_collections ORDER BY id ASC LIMIT 1',
  );
  if (existing?.id) return existing.id;
  return createCharacterCollection(projectId, name, { enabled: 1 });
}

export async function getCharactersByCollection(
  collectionId: number,
  projectId?: number,
): Promise<Row[]> {
  return all<Row>(
    `SELECT c.*, cc.name AS collection_name, cc.enabled AS collection_enabled, ${usageJoin(
      'character',
      'c',
      projectId,
    )}
     FROM characters c
     LEFT JOIN character_collections cc ON cc.id = c.collection_id
     WHERE c.collection_id = ?
     ORDER BY c.id DESC`,
    [collectionId],
  );
}

export async function setCharacterCollectionEnabledForProject(
  projectId: number,
  collectionId: number,
  enabled: boolean,
): Promise<void> {
  const database = await openDatabase();
  const rows = await all<{ id: number }>(
    'SELECT id FROM characters WHERE collection_id = ?',
    [collectionId],
  );
  const stmts: Array<{ sql: string; params: any[] }> = [];
  // 合集属于全局资料库；“当前项目使用”必须只改 project_resources，不能把
  // 另一个项目的角色上下文一并关闭。
  if (projectId > 0) {
    for (const row of rows) {
      stmts.push({
        sql: 'INSERT OR REPLACE INTO project_resources (project_id, resource_type, resource_id, enabled) VALUES (?, ?, ?, ?)',
        params: [projectId, 'character', row.id, enabled ? 1 : 0],
      });
    }
  }
  await executeTransaction(database, stmts);
}

export async function setAllCharactersCollectionId(
  projectId: number,
  collectionId: number,
): Promise<void> {
  await execute(
    await openDatabase(),
    'UPDATE characters SET collection_id = ? WHERE collection_id = 0',
    [collectionId],
  );
  await updateCharacterCollectionTokenEstimate(collectionId);
  const rows = await all<{ id: number }>(
    'SELECT id FROM characters WHERE collection_id = ?',
    [collectionId],
  );
  for (const row of rows) {
    await linkResourceToProject(projectId, 'character', row.id);
  }
}

export async function deleteCharacterCollection(id: number): Promise<void> {
  const database = await openDatabase();
  const characters = await all<{ id: number }>(
    'SELECT id FROM characters WHERE collection_id = ?',
    [id],
  );
  const stmts: Array<{ sql: string; params: any[] }> = [];
  for (const character of characters) {
    stmts.push({
      sql: 'DELETE FROM project_resources WHERE resource_type = ? AND resource_id = ?',
      params: ['character', character.id],
    });
  }
  stmts.push({
    sql: 'DELETE FROM characters WHERE collection_id = ?',
    params: [id],
  });
  stmts.push({
    sql: 'DELETE FROM character_collections WHERE id = ?',
    params: [id],
  });
  await executeTransaction(database, stmts);
}

export async function createCharacter(
  projectId: number,
  name: string,
  sourceType: string,
  dataJson: string,
  extra: Partial<Row> = {},
): Promise<number> {
  const estimatedTokens = estimateTokens(dataJson);
  const collectionId = Number(extra.collectionId ?? extra.collection_id ?? 0);
  const result = await execute(
    await openDatabase(),
    'INSERT INTO characters (project_id, collection_id, name, source_type, data_json, max_tokens, estimated_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      0,
      collectionId,
      name,
      sourceType,
      dataJson,
      Number(extra.max_tokens || 50000),
      estimatedTokens,
      now(),
    ],
  );
  const id = result.insertId!;
  await linkResourceToProject(projectId, 'character', id);
  if (collectionId) await updateCharacterCollectionTokenEstimate(collectionId);
  return id;
}

export async function updateCharacter(
  id: number,
  name: string,
  dataJson: string,
): Promise<void> {
  const existing = await getCharacterById(id);
  await execute(
    await openDatabase(),
    'UPDATE characters SET name = ?, data_json = ?, estimated_tokens = ? WHERE id = ?',
    [name, dataJson, estimateTokens(dataJson), id],
  );
  if (existing?.collection_id)
    await updateCharacterCollectionTokenEstimate(
      Number(existing.collection_id),
    );
}

export async function updateCharacterTokenBudget(
  id: number,
  maxTokens: number,
): Promise<void> {
  const existing = await getCharacterById(id);
  await execute(
    await openDatabase(),
    'UPDATE characters SET max_tokens = ? WHERE id = ?',
    [maxTokens, id],
  );
  if (existing?.collection_id)
    await updateCharacterCollectionTokenEstimate(
      Number(existing.collection_id),
    );
}

export async function deleteCharacter(id: number): Promise<void> {
  const existing = await getCharacterById(id);
  await deleteProjectResourceLinks('character', id);
  await execute(await openDatabase(), 'DELETE FROM characters WHERE id = ?', [
    id,
  ]);
  if (existing?.collection_id)
    await updateCharacterCollectionTokenEstimate(
      Number(existing.collection_id),
    );
}
