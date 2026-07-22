import type SQLite from 'react-native-sqlite-storage';
import type { Note } from '../../types/novel';
import { estimateTokens } from '../../utils/tokenEstimator';
import { getNoteChapters } from '../../utils/noteChapters';
import { execute } from '../connection/execute';
import { all, one } from '../connection/query';
import { executeTransaction } from '../connection/transaction';
import { openDatabase } from '../connection/openDatabase';
import { NOTE_LIST_PREVIEW_CHARS, NOTE_TEXT_CHUNK_CHARS, now } from './shared';
import {
  deleteProjectResourceLinks,
  linkResourceToProject,
  usageJoin,
} from './projectRepository';

export function splitNoteTextIntoChunks(
  text: string,
  chunkSize = NOTE_TEXT_CHUNK_CHARS,
): string[] {
  if (!text) return [''];
  if (text.length <= chunkSize) return [text];

  const chapters = getNoteChapters(text);
  if (chapters.length > 1) {
    const chunkStarts =
      chapters[0].offset > 0
        ? [{ title: '', offset: 0 }, ...chapters]
        : chapters;
    return packChaptersIntoNoteChunks(
      chunkStarts.map((chapter, index) =>
        text.slice(
          chapter.offset,
          chunkStarts[index + 1]?.offset ?? text.length,
        ),
      ),
      chunkSize,
    );
  }
  return splitOversizedNoteText(text, chunkSize);
}

function packChaptersIntoNoteChunks(
  chapters: string[],
  chunkSize: number,
): string[] {
  const chunks: string[] = [];
  let current = '';

  const flush = () => {
    if (current) chunks.push(current);
    current = '';
  };

  for (const chapter of chapters) {
    if (chapter.length > chunkSize) {
      flush();
      chunks.push(...splitOversizedNoteText(chapter, chunkSize));
    } else if (current.length + chapter.length <= chunkSize) {
      current += chapter;
    } else {
      flush();
      current = chapter;
    }
  }
  flush();
  return chunks;
}

function splitOversizedNoteText(text: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + chunkSize, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end);
      if (newline > start + Math.floor(chunkSize * 0.5)) {
        end = newline + 1;
      }
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

async function insertNoteRow(
  database: SQLite.SQLiteDatabase,
  title: string,
  content: string,
  collectionId = 0,
): Promise<number> {
  const timestamp = now();
  const result = await execute(
    database,
    'INSERT INTO notes (project_id, collection_id, title, content, max_tokens, estimated_tokens, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      0,
      collectionId,
      title,
      content,
      30000,
      estimateTokens(content),
      timestamp,
      timestamp,
    ],
  );
  return result.insertId!;
}

export async function createNotesFromTextChunks(
  projectId: number,
  title: string,
  content: string,
): Promise<{ firstId: number; createdCount: number; collectionId?: number }> {
  const database = await openDatabase();
  const chunks = splitNoteTextIntoChunks(content);
  const collectionId =
    chunks.length > 1
      ? await createNoteCollection(projectId, title, {
          estimated_tokens: estimateTokens(content),
        })
      : 0;
  let firstId = 0;
  for (let i = 0; i < chunks.length; i++) {
    const noteTitle =
      chunks.length === 1 ? title : `${title} (${i + 1}/${chunks.length})`;
    const id = await insertNoteRow(
      database,
      noteTitle,
      chunks[i],
      collectionId,
    );
    if (!firstId) firstId = id;
    await linkResourceToProject(projectId, 'note', id);
  }
  return {
    firstId,
    createdCount: chunks.length,
    ...(collectionId ? { collectionId } : {}),
  };
}

async function getNoteContentByIdFromDatabase(
  database: SQLite.SQLiteDatabase,
  id: number,
): Promise<string> {
  const meta = await execute(
    database,
    'SELECT length(content) AS length FROM notes WHERE id = ?',
    [id],
  );
  if (meta.rows.length === 0) return '';
  const totalLength = Number(meta.rows.item(0).length || 0);
  let content = '';
  for (let offset = 1; offset <= totalLength; offset += NOTE_TEXT_CHUNK_CHARS) {
    const result = await execute(
      database,
      'SELECT substr(content, ?, ?) AS chunk FROM notes WHERE id = ?',
      [offset, NOTE_TEXT_CHUNK_CHARS, id],
    );
    content += result.rows.item(0)?.chunk || '';
  }
  return content;
}

export async function getNoteContentById(id: number): Promise<string> {
  return getNoteContentByIdFromDatabase(await openDatabase(), id);
}

/**
 * V2.2.0：批量读取笔记内容，返回 id → content 映射。
 *
 * 单条实现 getNoteContentById 在 60 条笔记时是 60 次 round-trip（每条还会按 120k 分块多次 fetch）。
 * 这里一次性把所有 chunk 拉回来按 id 聚合，1 次 round-trip。
 *
 * ids 为空直接返回空 Map；不抛错。ids 中不存在的 id 不会出现在结果中（调用方按需 fallback）。
 */
export async function getNotesContentByIds(
  ids: number[],
): Promise<Record<number, string>> {
  const out: Record<number, string> = {};
  if (!ids?.length) return out;
  const idList = ids.filter(n => Number.isFinite(n) && n > 0);
  if (idList.length === 0) return out;
  const placeholders = idList.map(() => '?').join(',');
  const rows = await all<{ id: number; chunk: string }>(
    `SELECT id, substr(content, ?, ?) AS chunk
     FROM notes
     WHERE id IN (${placeholders})`,
    [1, NOTE_TEXT_CHUNK_CHARS, ...idList],
  );
  // 同 id 的多个 chunk 按顺序追加（SQLite substr 配合 OFFSET 即可保证顺序）
  for (const row of rows) {
    const id = Number(row.id);
    out[id] = (out[id] || '') + (row.chunk || '');
  }
  // 大小超过 NOTE_TEXT_CHUNK_CHARS 的笔记续拉：
  // 用第二次查询拿到每个 id 的总长度，然后追加（NOTE_TEXT_CHUNK_CHARS 截断的尾巴）
  const idsNeedingMore: Array<{ id: number; offset: number }> = [];
  const lengthRows = await all<{ id: number; length: number }>(
    `SELECT id, length(content) AS length FROM notes WHERE id IN (${placeholders})`,
    idList,
  );
  for (const lr of lengthRows) {
    let off = NOTE_TEXT_CHUNK_CHARS + 1;
    while (off <= Number(lr.length || 0)) {
      idsNeedingMore.push({ id: Number(lr.id), offset: off });
      off += NOTE_TEXT_CHUNK_CHARS;
    }
  }
  if (idsNeedingMore.length > 0) {
    // 仍然批量：按 offset 分组批量查
    const groupedByOffset = new Map<number, number[]>();
    for (const r of idsNeedingMore) {
      if (!groupedByOffset.has(r.offset)) groupedByOffset.set(r.offset, []);
      groupedByOffset.get(r.offset)!.push(r.id);
    }
    for (const [offset, subIds] of groupedByOffset.entries()) {
      const ph = subIds.map(() => '?').join(',');
      const moreRows = await all<{ id: number; chunk: string }>(
        `SELECT id, substr(content, ?, ?) AS chunk FROM notes WHERE id IN (${ph})`,
        [offset, NOTE_TEXT_CHUNK_CHARS, ...subIds],
      );
      for (const row of moreRows) {
        const id = Number(row.id);
        out[id] = (out[id] || '') + (row.chunk || '');
      }
    }
  }
  return out;
}

export async function repairOversizedNotes(
  database: SQLite.SQLiteDatabase,
): Promise<void> {
  try {
    const oversized = await execute(
      database,
      'SELECT id, title FROM notes WHERE length(content) > ? ORDER BY id ASC',
      [NOTE_TEXT_CHUNK_CHARS],
    );
    for (let i = 0; i < oversized.rows.length; i++) {
      const note = oversized.rows.item(i);
      const content = await getNoteContentByIdFromDatabase(database, note.id);
      const chunks = splitNoteTextIntoChunks(content);
      if (chunks.length <= 1) continue;
      const collectionResult = await execute(
        database,
        'INSERT INTO note_collections (project_id, name, enabled, max_tokens, estimated_tokens, created_at) VALUES (?, ?, 1, 50000, ?, ?)',
        [0, note.title, estimateTokens(content), now()],
      );
      const collectionId = collectionResult.insertId!;
      const links = await execute(
        database,
        'SELECT project_id, enabled FROM project_resources WHERE resource_type = ? AND resource_id = ?',
        ['note', note.id],
      );
      // V2.2.2 修复：改用统一 transaction executor，避免异步 callback 在 await 处触发 InvalidStateError。
      // 修法：先在事务外 async 收集数据（chunks/links 已经在上层异步读好），
      // 把所有 INSERT/DELETE 推入一次同步的事务执行。
      const timestamp = now();
      // 先 INSERT 新 chunk 拿 id。SQLite 在事务外自增 id 是稳定的（auto-increment counter 单调递增），
      // 但要注意：mock 模式下 insertId 都返回 100；真机下 SQLite 库会分配真实 id。
      // 由于 chunk 数和资源链接数都是已知的，我们直接用占位：原代码用 tx.executeSql 拿 insertId，
      // 现在改为分两步：第一步非事务 INSERT 取 id，第二步再事务化迁移链接 + 删旧。
      // 这是为了彻底绕开"async 拿 insertId"的需要。
      const newIds: number[] = [];
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        const insertResult = await execute(
          database,
          'INSERT INTO notes (project_id, collection_id, title, content, max_tokens, estimated_tokens, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [
            0,
            collectionId,
            `${note.title} (${chunkIndex + 1}/${chunks.length})`,
            chunks[chunkIndex],
            30000,
            estimateTokens(chunks[chunkIndex]),
            timestamp,
            timestamp,
          ],
        );
        newIds.push(insertResult.insertId!);
      }
      const linkRows: Array<{ project_id: number; enabled: number }> = [];
      for (let linkIndex = 0; linkIndex < links.rows.length; linkIndex++) {
        const link = links.rows.item(linkIndex);
        linkRows.push({
          project_id: Number(link.project_id),
          enabled: Number(link.enabled),
        });
      }
      const migrationStmts: Array<{ sql: string; params: any[] }> = [];
      for (const newId of newIds) {
        for (const link of linkRows) {
          migrationStmts.push({
            sql: 'INSERT OR REPLACE INTO project_resources (project_id, resource_type, resource_id, enabled) VALUES (?, ?, ?, ?)',
            params: [link.project_id, 'note', newId, link.enabled],
          });
        }
      }
      migrationStmts.push({
        sql: 'DELETE FROM project_resources WHERE resource_type = ? AND resource_id = ?',
        params: ['note', note.id],
      });
      migrationStmts.push({
        sql: 'DELETE FROM notes WHERE id = ?',
        params: [note.id],
      });
      await executeTransaction(database, migrationStmts);
    }
  } catch (error) {
    console.warn('[database] repairOversizedNotes failed:', error);
  }
}

export async function getAllNotes(projectId?: number): Promise<Note[]> {
  return all<Note>(
    `SELECT n.id, n.project_id, n.title, substr(n.content, 1, ${NOTE_LIST_PREVIEW_CHARS}) AS content,
            n.collection_id, nc.name AS collection_name, nc.enabled AS collection_enabled,
            n.max_tokens, n.estimated_tokens, n.created_at, n.updated_at, ${usageJoin(
              'note',
              'n',
              projectId,
            )}
     FROM notes n
     LEFT JOIN note_collections nc ON nc.id = n.collection_id
     ORDER BY nc.id DESC, n.id ASC`,
  );
}

export async function getNotesByProject(projectId: number): Promise<Note[]> {
  return all<Note>(
    `SELECT n.id, n.project_id, n.title, substr(n.content, 1, ${NOTE_LIST_PREVIEW_CHARS}) AS content,
            n.collection_id, n.max_tokens, n.estimated_tokens, n.created_at, n.updated_at
     FROM notes n
     JOIN project_resources pr ON pr.resource_id = n.id AND pr.resource_type = 'note'
     LEFT JOIN note_collections nc ON nc.id = n.collection_id
     WHERE pr.project_id = ? AND pr.enabled = 1
     ORDER BY n.updated_at DESC`,
    [projectId],
  );
}

export async function createNote(
  projectId: number,
  title: string,
  content = '',
): Promise<number> {
  const id = await insertNoteRow(await openDatabase(), title, content);
  await linkResourceToProject(projectId, 'note', id);
  return id;
}

export async function updateNote(
  id: number,
  title: string,
  content: string,
): Promise<void> {
  const note = await one<{ collection_id: number }>(
    'SELECT collection_id FROM notes WHERE id = ?',
    [id],
  );
  await execute(
    await openDatabase(),
    'UPDATE notes SET title = ?, content = ?, estimated_tokens = ?, updated_at = ? WHERE id = ?',
    [title, content, estimateTokens(content), now(), id],
  );
  if (note?.collection_id) {
    await updateNoteCollectionTokenEstimate(Number(note.collection_id));
  }
}

export async function updateNoteTokenBudget(
  id: number,
  maxTokens: number,
): Promise<void> {
  await execute(
    await openDatabase(),
    'UPDATE notes SET max_tokens = ? WHERE id = ?',
    [maxTokens, id],
  );
}

export async function deleteNote(id: number): Promise<void> {
  const note = await one<{ collection_id: number }>(
    'SELECT collection_id FROM notes WHERE id = ?',
    [id],
  );
  await deleteProjectResourceLinks('note', id);
  await execute(await openDatabase(), 'DELETE FROM notes WHERE id = ?', [id]);
  if (note?.collection_id) {
    await updateNoteCollectionTokenEstimate(Number(note.collection_id));
  }
}

export async function getNoteCollections(projectId?: number): Promise<any[]> {
  if (!projectId) {
    return all(
      `SELECT nc.*, COUNT(n.id) AS note_count
       FROM note_collections nc
       LEFT JOIN notes n ON n.collection_id = nc.id
       GROUP BY nc.id
       ORDER BY nc.id DESC`,
    );
  }
  return all(
    `SELECT nc.*, COUNT(n.id) AS note_count,
            CASE WHEN COUNT(n.id) = 0 THEN 1
                 WHEN SUM(CASE WHEN pr.enabled = 1 THEN 1 ELSE 0 END) > 0 THEN 1
                 ELSE 0 END AS enabled_for_project
     FROM note_collections nc
     LEFT JOIN notes n ON n.collection_id = nc.id
     LEFT JOIN project_resources pr ON pr.resource_id = n.id AND pr.resource_type = 'note' AND pr.project_id = ?
     GROUP BY nc.id
     ORDER BY nc.id DESC`,
    [projectId],
  );
}

export async function createNoteCollection(
  _projectId: number,
  name: string,
  extra: Record<string, any> = {},
): Promise<number> {
  const result = await execute(
    await openDatabase(),
    'INSERT INTO note_collections (project_id, name, enabled, max_tokens, estimated_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?)',
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

export async function updateNoteCollection(
  id: number,
  fields: Record<string, any>,
): Promise<void> {
  const allowed = new Set([
    'name',
    'enabled',
    'max_tokens',
    'estimated_tokens',
  ]);
  const sets: string[] = [];
  const values: any[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.has(key)) continue;
    sets.push(`${key} = ?`);
    values.push(value);
  }
  if (!sets.length) return;
  values.push(id);
  await execute(
    await openDatabase(),
    `UPDATE note_collections SET ${sets.join(', ')} WHERE id = ?`,
    values,
  );
}

export async function updateNoteCollectionTokenEstimate(
  id: number,
): Promise<void> {
  const rows = await all<{ estimated_tokens: number }>(
    'SELECT estimated_tokens FROM notes WHERE collection_id = ?',
    [id],
  );
  await updateNoteCollection(id, {
    estimated_tokens: rows.reduce(
      (total, row) => total + Number(row.estimated_tokens || 0),
      0,
    ),
  });
}

export async function setNoteCollectionEnabledForProject(
  projectId: number,
  collectionId: number,
  enabled: boolean,
): Promise<void> {
  const database = await openDatabase();
  const notes = await all<{ id: number }>(
    'SELECT id FROM notes WHERE collection_id = ?',
    [collectionId],
  );
  await executeTransaction(
    database,
    notes.map(note => ({
      sql: 'INSERT OR REPLACE INTO project_resources (project_id, resource_type, resource_id, enabled) VALUES (?, ?, ?, ?)',
      params: [projectId, 'note', note.id, enabled ? 1 : 0],
    })),
  );
}

export async function deleteNoteCollection(id: number): Promise<void> {
  const database = await openDatabase();
  const notes = await all<{ id: number }>(
    'SELECT id FROM notes WHERE collection_id = ?',
    [id],
  );
  const statements: Array<{ sql: string; params: any[] }> = notes.map(note => ({
    sql: 'DELETE FROM project_resources WHERE resource_type = ? AND resource_id = ?',
    params: ['note', note.id],
  }));
  statements.push(
    { sql: 'DELETE FROM notes WHERE collection_id = ?', params: [id] },
    { sql: 'DELETE FROM note_collections WHERE id = ?', params: [id] },
  );
  await executeTransaction(database, statements);
}
