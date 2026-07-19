import type {
  Chapter,
  Fragment,
  FragmentType,
  Plotline,
  Project,
  ProjectMode,
} from '../../types/novel';
import { execute } from '../connection/execute';
import { all, one } from '../connection/query';
import { executeTransaction } from '../connection/transaction';
import { openDatabase } from '../connection/openDatabase';
import {
  now,
  parseChapter,
  touchProject,
  type ResourceType,
  type Row,
} from './shared';
import { ensureDefaultPreset } from './presetRepository';
import { markStoryMemoryDirtyIfCovered } from './storyMemoryRepository';
import { invalidateIdf } from '../../utils/idfCache';

export async function getAllProjects(): Promise<Project[]> {
  return all<Project>(
    'SELECT * FROM projects WHERE id > 0 ORDER BY updated_at DESC',
  );
}

export async function getProjectById(id: number): Promise<Project | null> {
  return one<Project>('SELECT * FROM projects WHERE id = ? AND id > 0', [id]);
}

export async function createProject(
  name: string,
  mode: ProjectMode | string,
): Promise<number> {
  const database = await openDatabase();
  const timestamp = now();
  // V2.2.2 修复：用统一 transaction executor 取代旧的异步 callback。
  // 原因：react-native-sqlite-storage 的 transaction 期望 callback **同步**执行所有 SQL，
  // 任何 await 都会让 transaction 被 finalize 触发 InvalidStateError (DOM Exception 11)。
  // 这里改成：先 INSERT projects → 拿 insertId → 再 ensureDefaultPreset → 绑预设 + 建首章 + touch。
  // 整个写入过程走同步 statement batch，原子性保留。
  const insertProjectResult = await execute(
    database,
    'INSERT INTO projects (name, mode, created_at, updated_at) VALUES (?, ?, ?, ?)',
    [name, mode, timestamp, timestamp],
  );
  const projectId = insertProjectResult.insertId!;
  // ensureDefaultPreset 自己有事务，不能嵌套。所以拆成两步：
  //   1) 先把 project 行 + 关联写入放进一个事务
  //   2) 再调用 ensureDefaultPreset（它内部可能有自己的事务）
  // 任何一步失败时，项目已建但不完整；UI 层可看到空项目并由用户决定删除/重试。
  await executeTransaction(database, [
    {
      sql: 'INSERT OR REPLACE INTO project_resources (project_id, resource_type, resource_id, enabled) VALUES (?, ?, ?, ?)',
      params: [projectId, 'preset', 0, 1], // 先占位：0 表示"未指定预设"，UI 上不会生效
    },
    {
      sql: 'INSERT INTO chapters (project_id, position, title, synopsis, content, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      params: [
        projectId,
        0,
        '第 1 章',
        '',
        '',
        'planned',
        timestamp,
        timestamp,
      ],
    },
  ]);
  // ensureDefaultPreset 不依赖当前事务，单独调用
  await ensureDefaultPreset(database);
  await execute(database, 'UPDATE projects SET updated_at = ? WHERE id = ?', [
    timestamp,
    projectId,
  ]);
  return projectId;
}

export async function updateProject(id: number, name: string): Promise<void> {
  await execute(
    await openDatabase(),
    'UPDATE projects SET name = ?, updated_at = ? WHERE id = ?',
    [name, now(), id],
  );
}

export async function deleteProject(id: number): Promise<void> {
  if (id <= 0) return; // 防止删除全局资源（project_id=0 的数据）
  await execute(await openDatabase(), 'DELETE FROM projects WHERE id = ?', [
    id,
  ]);
  invalidateIdf(id);
}

export async function getChaptersByProject(
  projectId: number,
): Promise<Chapter[]> {
  const rows = await all<Row>(
    'SELECT * FROM chapters WHERE project_id = ? ORDER BY position ASC',
    [projectId],
  );
  return rows.map(parseChapter);
}

export async function getChapterById(id: number): Promise<Chapter | null> {
  const row = await one<Row>('SELECT * FROM chapters WHERE id = ?', [id]);
  return row ? parseChapter(row) : null;
}

export type ChapterReadingRange = 'current' | 'fromCurrent' | 'all';

export async function buildChapterReadingText(
  projectId: number,
  chapterId: number,
  range: ChapterReadingRange,
): Promise<string> {
  const current = await getChapterById(chapterId);
  if (!current) return '';

  let rows: Row[];
  if (range === 'current') {
    rows = [current as unknown as Row];
  } else if (range === 'fromCurrent') {
    rows = await all<Row>(
      'SELECT * FROM chapters WHERE project_id = ? AND position >= ? ORDER BY position ASC, id ASC',
      [projectId, current.position],
    );
  } else {
    rows = await all<Row>(
      'SELECT * FROM chapters WHERE project_id = ? ORDER BY position ASC, id ASC',
      [projectId],
    );
  }

  return rows
    .map(parseChapter)
    .filter(chapter => chapter.content.trim())
    .map((chapter, index) => {
      const title = chapter.title.trim() || `第 ${index + 1} 章`;
      return `${title}\n\n${chapter.content.trim()}`;
    })
    .join('\n\n');
}

export async function createChapter(
  projectId: number,
  position: number,
  title?: string,
): Promise<number> {
  const timestamp = now();
  const result = await execute(
    await openDatabase(),
    'INSERT INTO chapters (project_id, position, title, synopsis, content, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      projectId,
      position,
      title || `第 ${position + 1} 章`,
      '',
      '',
      'planned',
      timestamp,
      timestamp,
    ],
  );
  await touchProject(projectId);
  return result.insertId!;
}

const CHAPTER_COLUMNS = new Set([
  'title',
  'synopsis',
  'content',
  'status',
  'summary_json',
  'memory_summary',
  'memory_summary_tokens',
  'finalized_at',
  'position',
]);

export async function updateChapter(
  id: number,
  fields: Partial<Chapter>,
): Promise<void> {
  const chapter = await getChapterById(id);
  const sets = ['updated_at = ?'];
  const values: any[] = [now()];
  for (const [key, value] of Object.entries(fields)) {
    if (!CHAPTER_COLUMNS.has(key)) continue;
    sets.push(`${key} = ?`);
    values.push(
      key === 'summary_json' && value !== null && typeof value !== 'string'
        ? JSON.stringify(value)
        : value,
    );
  }
  if (sets.length === 1) return;
  values.push(id);
  await execute(
    await openDatabase(),
    `UPDATE chapters SET ${sets.join(', ')} WHERE id = ?`,
    values,
  );
  if (chapter) await touchProject(chapter.project_id);
  const continuityFields = ['title', 'synopsis', 'content', 'position'];
  const changedContinuity = chapter && continuityFields.some(key => {
    if (!(key in fields)) return false;
    return fields[key as keyof Chapter] !== chapter[key as keyof Chapter];
  });
  if (
    chapter &&
    changedContinuity &&
    (chapter.finalized_at != null || Boolean(chapter.memory_summary?.trim()))
  ) {
    const affectedPosition =
      typeof fields.position === 'number'
        ? Math.min(chapter.position, fields.position)
        : chapter.position;
    await markStoryMemoryDirtyIfCovered(
      chapter.project_id,
      affectedPosition,
      '已定稿章节内容或顺序发生变化。',
    );
  }
}

export async function deleteChapter(id: number): Promise<void> {
  const chapter = await getChapterById(id);
  await execute(await openDatabase(), 'DELETE FROM chapters WHERE id = ?', [
    id,
  ]);
  if (chapter) await touchProject(chapter.project_id);
  if (
    chapter &&
    (chapter.finalized_at != null || Boolean(chapter.memory_summary?.trim()))
  ) {
    await markStoryMemoryDirtyIfCovered(
      chapter.project_id,
      chapter.position,
      '已删除章节，需要重建故事记忆。',
    );
    invalidateIdf(chapter.project_id);
  }
}

export async function getFragmentsByProject(
  projectId: number,
): Promise<Fragment[]> {
  return all<Fragment>(
    'SELECT * FROM fragments WHERE project_id = ? ORDER BY position ASC',
    [projectId],
  );
}

export async function createFragment(
  projectId: number,
  type: FragmentType | string,
  content: string,
  position: number,
): Promise<number> {
  const result = await execute(
    await openDatabase(),
    'INSERT INTO fragments (project_id, position, type, content, created_at) VALUES (?, ?, ?, ?, ?)',
    [projectId, position, type, content, now()],
  );
  await touchProject(projectId);
  return result.insertId!;
}

export async function deleteFragment(id: number): Promise<void> {
  await execute(await openDatabase(), 'DELETE FROM fragments WHERE id = ?', [
    id,
  ]);
}

export async function getPlotlinesByProject(
  projectId: number,
): Promise<Plotline[]> {
  return all<Plotline>(
    'SELECT * FROM plotlines WHERE project_id = ? ORDER BY id ASC',
    [projectId],
  );
}

export async function createPlotline(
  projectId: number,
  name: string,
  description: string,
  color: string,
): Promise<number> {
  const result = await execute(
    await openDatabase(),
    'INSERT INTO plotlines (project_id, name, description, color) VALUES (?, ?, ?, ?)',
    [projectId, name, description, color],
  );
  return result.insertId!;
}

export async function deletePlotline(id: number): Promise<void> {
  await execute(await openDatabase(), 'DELETE FROM plotlines WHERE id = ?', [
    id,
  ]);
}

export async function setChapterPlotlines(
  chapterId: number,
  plotlineIds: number[],
): Promise<void> {
  const database = await openDatabase();
  // V2.2.2 修复：改用统一 transaction executor，避免异步 callback 在 await 处触发 InvalidStateError。
  const stmts: Array<{ sql: string; params: any[] }> = [
    {
      sql: 'DELETE FROM project_plotlines WHERE chapter_id = ?',
      params: [chapterId],
    },
  ];
  for (const plotlineId of plotlineIds) {
    stmts.push({
      sql: 'INSERT INTO project_plotlines (chapter_id, plotline_id) VALUES (?, ?)',
      params: [chapterId, plotlineId],
    });
  }
  await executeTransaction(database, stmts);
}

export async function getChapterPlotlineIds(
  chapterId: number,
): Promise<number[]> {
  const rows = await all<{ plotline_id: number }>(
    'SELECT plotline_id FROM project_plotlines WHERE chapter_id = ?',
    [chapterId],
  );
  return rows.map(row => row.plotline_id);
}

export async function setProjectResourceEnabled(
  projectId: number,
  resourceType: ResourceType,
  resourceId: number,
  enabled: boolean,
): Promise<void> {
  await execute(
    await openDatabase(),
    'INSERT OR REPLACE INTO project_resources (project_id, resource_type, resource_id, enabled) VALUES (?, ?, ?, ?)',
    [projectId, resourceType, resourceId, enabled ? 1 : 0],
  );
}

export async function deleteProjectResourceLinks(
  resourceType: ResourceType,
  resourceId: number,
): Promise<void> {
  await execute(
    await openDatabase(),
    'DELETE FROM project_resources WHERE resource_type = ? AND resource_id = ?',
    [resourceType, resourceId],
  );
}

export async function linkResourceToProject(
  projectId: number,
  resourceType: ResourceType,
  resourceId: number,
): Promise<void> {
  if (projectId > 0) {
    await setProjectResourceEnabled(projectId, resourceType, resourceId, true);
  }
}

export function usageJoin(
  resourceType: ResourceType,
  alias: string,
  projectId?: number,
): string {
  if (!projectId) return '0 AS enabled_for_project';
  return `COALESCE((SELECT enabled FROM project_resources pr WHERE pr.project_id = ${Number(
    projectId,
  )} AND pr.resource_type = '${resourceType}' AND pr.resource_id = ${alias}.id), 0) AS enabled_for_project`;
}
