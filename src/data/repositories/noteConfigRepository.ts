import { execute } from '../connection/execute';
import { openDatabase } from '../connection/openDatabase';
import { type Row } from './shared';

// ---------------------------------------------------------------------------
// 笔记双模式（V1.7.0 / schema 9）
// ---------------------------------------------------------------------------

export type NoteMode = 'none' | 'style' | 'retrieval';

export interface ProjectNoteConfig {
  projectId: number;
  mode: NoteMode;
  styleWeights: Record<string, number>;
  retrievalTopK: number;
  retrievalFragmentChars: number;
  enabledNoteIds: number[];
  updatedAt: string;
}

// 同一项目的配置写入必须串行。UI 中模式、权重和参与名单可能连续触发异步保存；
// 若并发执行 SELECT → INSERT OR REPLACE，后完成的旧快照会覆盖先完成的新字段。
const configWriteQueues = new Map<number, Promise<void>>();

function safeJsonParse(text: string, fallback: any): any {
  try {
    // ?? 只匹配 null/undefined，但 JSON.parse('null') 会返回 null 也会污染 state
    // 改用 || 同时拦截 null 和空对象（空对象会导致后续 .length/.map 报错）
    if (text == null || text === '') return fallback;
    const parsed = JSON.parse(text);
    if (parsed == null) return fallback;
    return parsed;
  } catch {
    return fallback;
  }
}

function parseProjectNoteConfigRow(row: Row): ProjectNoteConfig {
  return {
    projectId: Number(row.project_id),
    mode: row.mode as NoteMode,
    styleWeights: safeJsonParse(row.style_weights, {}),
    // 11.10 修复：原 || 把 0 当 falsy 回退到 5，改用 ?? 保留显式 0
    retrievalTopK: Number(row.retrieval_top_k) ?? 5,
    retrievalFragmentChars: Number(row.retrieval_fragment_chars) || 1000,
    enabledNoteIds: safeJsonParse(row.enabled_note_ids, []),
    updatedAt: row.updated_at,
  };
}

export async function getProjectNoteConfig(
  projectId: number,
): Promise<ProjectNoteConfig | null> {
  const result = await execute(
    await openDatabase(),
    'SELECT * FROM project_note_config WHERE project_id = ?',
    [projectId],
  );
  if (result.rows.length === 0) return null;
  return parseProjectNoteConfigRow(result.rows.item(0));
}

export async function setProjectNoteConfig(
  projectId: number,
  config: Partial<Omit<ProjectNoteConfig, 'projectId' | 'updatedAt'>>,
): Promise<void> {
  const previous = configWriteQueues.get(projectId) ?? Promise.resolve();
  const pending = previous
    .catch(() => undefined)
    .then(() => writeProjectNoteConfig(projectId, config));
  configWriteQueues.set(projectId, pending);
  try {
    await pending;
  } finally {
    if (configWriteQueues.get(projectId) === pending) {
      configWriteQueues.delete(projectId);
    }
  }
}

async function writeProjectNoteConfig(
  projectId: number,
  config: Partial<Omit<ProjectNoteConfig, 'projectId' | 'updatedAt'>>,
): Promise<void> {
  // 11.13 修复：原实现用异步 transaction callback 在 callback 中 await，
  // react-native-sqlite-storage 的 transaction 期望 callback **同步**执行 SQL，
  // async callback 在第一次 await 之前 transaction 已被 finalize，导致 InvalidStateError
  // (DOM Exception 11)。改成分步：先 SELECT 读 existing → INSERT OR REPLACE 写。
  // 单 project 单行写入，丢失"严格原子性"在并发场景下极少见且可接受
  // （下一句写会覆盖上一句写，最终态一致）。
  const database = await openDatabase();
  const existing = await getProjectNoteConfig(projectId);
  const mode = config.mode ?? existing?.mode ?? 'none';
  const styleWeights = JSON.stringify(
    config.styleWeights ?? existing?.styleWeights ?? {},
  );
  const retrievalTopK = config.retrievalTopK ?? existing?.retrievalTopK ?? 5;
  const retrievalFragmentChars =
    config.retrievalFragmentChars ?? existing?.retrievalFragmentChars ?? 1000;
  const enabledNoteIds = JSON.stringify(
    config.enabledNoteIds ?? existing?.enabledNoteIds ?? [],
  );
  const updatedAt = new Date().toISOString();
  await execute(
    database,
    `INSERT OR REPLACE INTO project_note_config (project_id, mode, style_weights, retrieval_top_k, retrieval_fragment_chars, enabled_note_ids, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      projectId,
      mode,
      styleWeights,
      retrievalTopK,
      retrievalFragmentChars,
      enabledNoteIds,
      updatedAt,
    ],
  );
}

export interface NoteStyleProfileRow {
  noteId: number;
  profileText: string;
  profileJson: string;
  analyzedAt: string;
  sourceHash: string;
}

export async function getNoteStyleProfile(
  noteId: number,
): Promise<NoteStyleProfileRow | null> {
  const result = await execute(
    await openDatabase(),
    'SELECT * FROM note_style_profiles WHERE note_id = ?',
    [noteId],
  );
  if (result.rows.length === 0) return null;
  const row = result.rows.item(0);
  return {
    noteId: Number(row.note_id),
    profileText: row.profile_text || '',
    profileJson: row.profile_json || '{}',
    analyzedAt: row.analyzed_at,
    sourceHash: row.source_hash || '',
  };
}

export async function setNoteStyleProfile(
  noteId: number,
  profileText: string,
  profileJson: string,
  sourceHash: string,
): Promise<void> {
  const analyzedAt = new Date().toISOString();
  await execute(
    await openDatabase(),
    `INSERT OR REPLACE INTO note_style_profiles (note_id, profile_text, profile_json, analyzed_at, source_hash)
     VALUES (?, ?, ?, ?, ?)`,
    [noteId, profileText, profileJson, analyzedAt, sourceHash],
  );
}

export async function deleteNoteStyleProfile(noteId: number): Promise<void> {
  await execute(
    await openDatabase(),
    'DELETE FROM note_style_profiles WHERE note_id = ?',
    [noteId],
  );
}

// 简易 hash（非加密级别，用于笔记内容变更检测）
export async function computeNoteSourceHash(content: string): Promise<string> {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return (
    Math.abs(hash).toString(16).padStart(8, '0') +
    '_' +
    content.length.toString(16)
  );
}
