import type {
  Chapter,
  Fragment,
  FragmentType,
  Plotline,
  Project,
  ProjectMode,
} from '../../types/novel';
import { normalizeProjectMode } from '../../services/continuation/projectMode';
import { execute } from '../connection/execute';
import { all, one } from '../connection/query';
import {
  executeTransaction,
  type SqlStatement,
} from '../connection/transaction';
import { openDatabase } from '../connection/openDatabase';
import {
  now,
  parseChapter,
  touchProject,
  type ResourceType,
  type Row,
} from './shared';
import { ensureDefaultPreset } from './presetRepository';
import {
  buildStoryMemoryContinuitySideEffects,
  getProjectStoryMemory,
} from './storyMemoryRepository';
import { invalidateIdf } from '../../utils/idfCache';

export async function getAllProjects(): Promise<Project[]> {
  return all<Project>(
    'SELECT * FROM projects WHERE id > 0 ORDER BY updated_at DESC',
  );
}

export async function setProjectCollectionEnabled(
  projectId: number,
  resourceType: 'character' | 'worldbook' | 'note',
  collectionId: number,
  enabled: boolean,
): Promise<void> {
  if (projectId <= 0) {
    throw new Error('请先选择项目，再设置合集的启用状态。');
  }
  await execute(
    await openDatabase(),
    `INSERT OR REPLACE INTO project_collection_settings
      (project_id, resource_type, collection_id, enabled) VALUES (?, ?, ?, ?)`,
    [projectId, resourceType, collectionId, enabled ? 1 : 0],
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
  // Boundary guard (Spec §8.1, §9.1): normalize before INSERT so unknown
  // strings never reach `projects.mode`. Empty/undefined falls back to the
  // historical `outline` default; genuinely unknown values throw here rather
  // than persisting as an unreadable mode.
  const resolvedMode = normalizeProjectMode(mode);
  const timestamp = now();
  // V2.2.2 修复：用统一 transaction executor 取代旧的异步 callback。
  // 原因：react-native-sqlite-storage 的 transaction 期望 callback **同步**执行所有 SQL，
  // 任何 await 都会让 transaction 被 finalize 触发 InvalidStateError (DOM Exception 11)。
  // 这里改成：先 INSERT projects → 拿 insertId → 再 ensureDefaultPreset → 绑预设 + 建首章 + touch。
  // 整个写入过程走同步 statement batch，原子性保留。
  const insertProjectResult = await execute(
    database,
    'INSERT INTO projects (name, mode, created_at, updated_at) VALUES (?, ?, ?, ?)',
    [name, resolvedMode, timestamp, timestamp],
  );
  const projectId = insertProjectResult.insertId!;
  // 默认预设的 id 需要先解析出来，不能把 resource_id=0 当占位写入：
  // 项目级查询按实际 preset id join，0 会使新项目的写作/流水线预设列表为空。
  const defaultPresetId = await ensureDefaultPreset(database);

  // 新项目必须从“资料全关闭”开始。显式写入当前全部全局资料的项目级
  // 开关，而不是依赖查询端的 COALESCE 默认值；这样随后新增项目、切换
  // 合集或查看上下文时都不会意外带入旧项目的资料。
  //
  // ensureDefaultPreset 可能独立写入全局预设，因此不能嵌套到这个事务中；
  // 但该预设也必须以关闭状态关联到新项目，写作时会安全回退内建默认提示词。
  await executeTransaction(database, [
    {
      sql: `INSERT OR IGNORE INTO project_resources (project_id, resource_type, resource_id, enabled)
            SELECT ?, 'character', id, 0 FROM characters`,
      params: [projectId],
    },
    {
      sql: `INSERT OR IGNORE INTO project_resources (project_id, resource_type, resource_id, enabled)
            SELECT ?, 'worldbook', id, 0 FROM worldbook_entries`,
      params: [projectId],
    },
    {
      sql: `INSERT OR IGNORE INTO project_resources (project_id, resource_type, resource_id, enabled)
            SELECT ?, 'note', id, 0 FROM notes`,
      params: [projectId],
    },
    {
      sql: `INSERT OR IGNORE INTO project_resources (project_id, resource_type, resource_id, enabled)
            SELECT ?, 'preset', id, 0 FROM presets`,
      params: [projectId],
    },
    {
      sql: `INSERT OR IGNORE INTO project_collection_settings (project_id, resource_type, collection_id, enabled)
            SELECT ?, 'character', id, 0 FROM character_collections`,
      params: [projectId],
    },
    {
      sql: `INSERT OR IGNORE INTO project_collection_settings (project_id, resource_type, collection_id, enabled)
            SELECT ?, 'worldbook', id, 0 FROM worldbook_collections`,
      params: [projectId],
    },
    {
      sql: `INSERT OR IGNORE INTO project_collection_settings (project_id, resource_type, collection_id, enabled)
            SELECT ?, 'note', id, 0 FROM note_collections`,
      params: [projectId],
    },
    {
      sql: 'INSERT OR REPLACE INTO project_resources (project_id, resource_type, resource_id, enabled) VALUES (?, ?, ?, ?)',
      params: [projectId, 'preset', defaultPresetId, 0],
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
  const timestamp = now();
  const sets = ['updated_at = ?'];
  const values: any[] = [timestamp];
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

  // Chapter write + project touch + story-memory dirty/invalidation must share
  // one SQLite transaction. A partial commit (new body + clean memory) would
  // let equal-content autosave retries skip re-dirtying permanently.
  const statements: SqlStatement[] = [
    {
      sql: `UPDATE chapters SET ${sets.join(', ')} WHERE id = ?`,
      params: values,
    },
  ];

  if (chapter) {
    statements.push({
      sql: 'UPDATE projects SET updated_at = ? WHERE id = ?',
      params: [timestamp, chapter.project_id],
    });

    const continuityFields = ['title', 'synopsis', 'content', 'position'];
    const changedContinuity = continuityFields.some(key => {
      if (!(key in fields)) return false;
      return fields[key as keyof Chapter] !== chapter[key as keyof Chapter];
    });
    if (
      changedContinuity &&
      (chapter.finalized_at != null || Boolean(chapter.memory_summary?.trim()))
    ) {
      const affectedPosition =
        typeof fields.position === 'number'
          ? Math.min(chapter.position, fields.position)
          : chapter.position;
      const memory = await getProjectStoryMemory(chapter.project_id);
      const { statements: sideEffects } = buildStoryMemoryContinuitySideEffects(
        memory,
        chapter.project_id,
        affectedPosition,
        '已定稿章节内容或顺序发生变化。',
        timestamp,
      );
      statements.push(...sideEffects);
    }
  }

  await executeTransaction(await openDatabase(), statements);
}

export async function deleteChapter(id: number): Promise<void> {
  const chapter = await getChapterById(id);
  const timestamp = now();
  const statements: SqlStatement[] = [
    {
      sql: 'DELETE FROM chapters WHERE id = ?',
      params: [id],
    },
  ];

  let shouldInvalidateIdf = false;
  if (chapter) {
    statements.push({
      sql: 'UPDATE projects SET updated_at = ? WHERE id = ?',
      params: [timestamp, chapter.project_id],
    });

    if (
      chapter.finalized_at != null ||
      Boolean(chapter.memory_summary?.trim())
    ) {
      const memory = await getProjectStoryMemory(chapter.project_id);
      const { statements: sideEffects } = buildStoryMemoryContinuitySideEffects(
        memory,
        chapter.project_id,
        chapter.position,
        '已删除章节，需要重建故事记忆。',
        timestamp,
      );
      statements.push(...sideEffects);
      // IDF is process-local; only clear after the DB transaction commits.
      // Historical behavior: drop IDF for any deleted finalized/summarized chapter.
      shouldInvalidateIdf = true;
    }
  }

  await executeTransaction(await openDatabase(), statements);
  if (shouldInvalidateIdf && chapter) {
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
  const database = await openDatabase();
  // A newly-created project records its existing worldbook collections as
  // disabled. If a user later enables just one entry (or creates a new entry),
  // keeping that parent flag disabled makes the UI say "当前项目使用" while the
  // context query correctly-but-surprisingly filters the entry out. Enabling
  // an entry therefore also makes its project-level collection available.
  // This does not cascade to sibling entries: only an explicit parent toggle
  // should turn every child on/off.
  if (resourceType === 'worldbook' && enabled) {
    const entry = await one<{ collection_id: number }>(
      'SELECT collection_id FROM worldbook_entries WHERE id = ?',
      [resourceId],
    );
    const collectionId = Number(entry?.collection_id || 0);
    const statements: SqlStatement[] = [
      {
        sql: 'INSERT OR REPLACE INTO project_resources (project_id, resource_type, resource_id, enabled) VALUES (?, ?, ?, ?)',
        params: [projectId, resourceType, resourceId, 1],
      },
      // 项目启用世界书条目时默认常驻，保证写作上下文能直接带入
      {
        sql: 'UPDATE worldbook_entries SET constant = 1 WHERE id = ?',
        params: [resourceId],
      },
    ];
    if (collectionId > 0) {
      statements.push({
        sql: `INSERT OR REPLACE INTO project_collection_settings
          (project_id, resource_type, collection_id, enabled) VALUES (?, ?, ?, 1)`,
        params: [projectId, 'worldbook', collectionId],
      });
    }
    await executeTransaction(database, statements);
    return;
  }
  await execute(
    database,
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
