import { execute } from '../connection/execute';
import { openDatabase } from '../connection/openDatabase';
import { all, one } from '../connection/query';
import { executeTransaction, type SqlStatement } from '../connection/transaction';
import { canonicalStringify } from '../../services/storyMemory/storyMemoryFingerprint';
import { createEmptyStoryMemory } from '../../services/storyMemory/storyMemoryDefaults';
import type {
  StoredChapterMemoryPatch,
  StoryMemoryBuildStatus,
  StoryMemoryState,
} from '../../services/storyMemory/storyMemoryTypes';
import { StoryMemoryError } from '../../services/storyMemory/storyMemoryTypes';
import { estimateTokens } from '../../utils/tokenEstimator';

export const STORY_MEMORY_SNAPSHOT_INTERVAL = 10;
export const STORY_MEMORY_MAX_SNAPSHOTS_PER_PROJECT = 20;

interface ProjectStoryMemoryDbRow {
  project_id: number;
  schema_version: number;
  through_chapter_id: number | null;
  through_chapter_position: number;
  memory_json: string;
  estimated_tokens: number;
  state_fingerprint: string;
  last_applied_patch_id: string | null;
  status: StoryMemoryBuildStatus;
  source: StoryMemoryState['metadata']['source'];
  dirty_from_position: number | null;
  last_error: string;
  updated_at: string;
}

interface ChapterMemoryPatchDbRow {
  chapter_id: number;
  project_id: number;
  chapter_position: number;
  patch_id: string;
  schema_version: number;
  source_fingerprint: string;
  base_memory_fingerprint: string;
  result_memory_fingerprint: string;
  episodic_summary_json: string;
  patch_json: string;
  estimated_tokens: number;
  status: 'generated' | 'applied' | 'failed';
  last_error: string;
  generated_at: string;
  applied_at: string | null;
}

interface StoryMemorySnapshotDbRow {
  id: number;
  project_id: number;
  through_chapter_id: number;
  through_chapter_position: number;
  memory_json: string;
  estimated_tokens: number;
  state_fingerprint: string;
  created_at: string;
}

export interface ProjectStoryMemoryRecord {
  state: StoryMemoryState;
  status: StoryMemoryBuildStatus;
  dirtyFromPosition: number | null;
  lastError: string;
  updatedAt: string;
}

export interface ChapterMemoryPatchRecord {
  patch: StoredChapterMemoryPatch;
  status: ChapterMemoryPatchDbRow['status'];
  lastError: string;
  estimatedTokens: number;
}

export interface StoryMemorySnapshotRecord {
  id: number;
  state: StoryMemoryState;
  createdAt: string;
}

export interface SaveStoryMemoryUpdateInput {
  state: StoryMemoryState;
  patch: StoredChapterMemoryPatch;
  episodicMemoryText: string;
  finalizedAt: string;
  createSnapshot?: boolean;
}

function parseJson<T>(json: string, label: string): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    throw new StoryMemoryError(
      'MEMORY_STATE_CORRUPTED',
      `${label} JSON 已损坏。`,
    );
  }
}

function mapProjectRow(row: ProjectStoryMemoryDbRow): ProjectStoryMemoryRecord {
  const state = parseJson<StoryMemoryState>(row.memory_json, '项目故事记忆');
  state.metadata = {
    ...state.metadata,
    status: row.status,
    source: row.source,
    stateFingerprint: row.state_fingerprint,
    lastAppliedPatchId: row.last_applied_patch_id,
    estimatedTokens: row.estimated_tokens,
    dirtyFromPosition: row.dirty_from_position,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
  return {
    state,
    status: row.status,
    dirtyFromPosition: row.dirty_from_position,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

function mapPatchRow(row: ChapterMemoryPatchDbRow): ChapterMemoryPatchRecord {
  return {
    patch: {
      patchId: row.patch_id,
      schemaVersion: 1,
      projectId: row.project_id,
      chapterId: row.chapter_id,
      chapterPosition: row.chapter_position,
      sourceFingerprint: row.source_fingerprint,
      baseMemoryFingerprint: row.base_memory_fingerprint,
      resultMemoryFingerprint: row.result_memory_fingerprint,
      episodicSummary: parseJson(row.episodic_summary_json, '章节事件摘要'),
      normalizedPatch: parseJson(row.patch_json, '章节记忆补丁'),
      generatedAt: row.generated_at,
      appliedAt: row.applied_at,
    },
    status: row.status,
    lastError: row.last_error,
    estimatedTokens: row.estimated_tokens,
  };
}

function mapSnapshotRow(row: StoryMemorySnapshotDbRow): StoryMemorySnapshotRecord {
  return {
    id: row.id,
    state: parseJson(row.memory_json, '故事记忆快照'),
    createdAt: row.created_at,
  };
}

export async function getProjectStoryMemory(
  projectId: number,
): Promise<ProjectStoryMemoryRecord | null> {
  const row = await one<ProjectStoryMemoryDbRow>(
    'SELECT * FROM project_story_memory WHERE project_id = ?',
    [projectId],
  );
  return row && typeof row.memory_json === 'string' ? mapProjectRow(row) : null;
}

export async function ensureProjectStoryMemoryRow(
  projectId: number,
): Promise<ProjectStoryMemoryRecord> {
  const existing = await getProjectStoryMemory(projectId);
  if (existing) return existing;
  const earliest = await one<{ position: number }>(
    `SELECT position FROM chapters
     WHERE project_id = ? AND (TRIM(content) != '' OR finalized_at IS NOT NULL)
     ORDER BY position ASC LIMIT 1`,
    [projectId],
  );
  const state = createEmptyStoryMemory(projectId);
  state.metadata.dirtyFromPosition = earliest?.position ?? null;
  const now = new Date().toISOString();
  state.metadata.updatedAt = now;
  await execute(
    await openDatabase(),
    `INSERT OR IGNORE INTO project_story_memory (
      project_id, schema_version, through_chapter_id,
      through_chapter_position, memory_json, estimated_tokens,
      state_fingerprint, last_applied_patch_id, status, source,
      dirty_from_position, last_error, updated_at
    ) VALUES (?, 1, NULL, -1, ?, ?, ?, NULL, 'empty', 'native', ?, '', ?)`,
    [
      projectId,
      canonicalStringify(state),
      state.metadata.estimatedTokens,
      state.metadata.stateFingerprint,
      earliest?.position ?? null,
      now,
    ],
  );
  const created = await getProjectStoryMemory(projectId);
  if (!created) {
    throw new StoryMemoryError(
      'MEMORY_TRANSACTION_FAILED',
      '无法创建项目故事记忆记录。',
    );
  }
  return created;
}

export async function getChapterMemoryPatch(
  chapterId: number,
): Promise<ChapterMemoryPatchRecord | null> {
  const row = await one<ChapterMemoryPatchDbRow>(
    'SELECT * FROM chapter_memory_patches WHERE chapter_id = ?',
    [chapterId],
  );
  return row && typeof row.patch_json === 'string' ? mapPatchRow(row) : null;
}

export async function getChapterMemoryPatchesByProject(
  projectId: number,
  fromPosition = -1,
  toPosition = Number.MAX_SAFE_INTEGER,
): Promise<ChapterMemoryPatchRecord[]> {
  const rows = await all<ChapterMemoryPatchDbRow>(
    `SELECT * FROM chapter_memory_patches
     WHERE project_id = ? AND chapter_position >= ? AND chapter_position <= ?
     ORDER BY chapter_position ASC`,
    [projectId, fromPosition, toPosition],
  );
  return rows.map(mapPatchRow);
}

export async function getNearestStoryMemorySnapshot(
  projectId: number,
  beforePosition: number,
): Promise<StoryMemorySnapshotRecord | null> {
  const row = await one<StoryMemorySnapshotDbRow>(
    `SELECT * FROM story_memory_snapshots
     WHERE project_id = ? AND through_chapter_position < ?
     ORDER BY through_chapter_position DESC LIMIT 1`,
    [projectId, beforePosition],
  );
  return row ? mapSnapshotRow(row) : null;
}

export async function listStoryMemorySnapshots(
  projectId: number,
): Promise<StoryMemorySnapshotRecord[]> {
  const rows = await all<StoryMemorySnapshotDbRow>(
    `SELECT * FROM story_memory_snapshots
     WHERE project_id = ? ORDER BY through_chapter_position DESC`,
    [projectId],
  );
  return rows.map(mapSnapshotRow);
}

export async function markStoryMemoryDirty(
  projectId: number,
  fromPosition: number,
  reason = '',
): Promise<void> {
  await ensureProjectStoryMemoryRow(projectId);
  await execute(
    await openDatabase(),
    `UPDATE project_story_memory SET
      status = 'dirty',
      dirty_from_position = CASE
        WHEN dirty_from_position IS NULL THEN ?
        WHEN dirty_from_position > ? THEN ?
        ELSE dirty_from_position
      END,
      last_error = ?, updated_at = ?
     WHERE project_id = ?`,
    [
      fromPosition,
      fromPosition,
      fromPosition,
      reason,
      new Date().toISOString(),
      projectId,
    ],
  );
}

export async function clearStoryMemory(projectId: number): Promise<void> {
  await executeTransaction(await openDatabase(), [
    { sql: 'DELETE FROM story_memory_snapshots WHERE project_id = ?', params: [projectId] },
    { sql: 'DELETE FROM chapter_memory_patches WHERE project_id = ?', params: [projectId] },
    { sql: 'DELETE FROM project_story_memory WHERE project_id = ?', params: [projectId] },
  ]);
}

export async function saveStoryMemoryUpdate(
  input: SaveStoryMemoryUpdateInput,
): Promise<void> {
  const { patch, state } = input;
  const stateJson = canonicalStringify(state);
  const patchJson = canonicalStringify(patch.normalizedPatch);
  const episodicJson = canonicalStringify(patch.episodicSummary);
  const statements: SqlStatement[] = [
    {
      sql: `INSERT OR REPLACE INTO chapter_memory_patches (
        chapter_id, project_id, chapter_position, patch_id, schema_version,
        source_fingerprint, base_memory_fingerprint, result_memory_fingerprint,
        episodic_summary_json, patch_json, estimated_tokens, status, last_error,
        generated_at, applied_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 'applied', '', ?, ?)`,
      params: [
        patch.chapterId, patch.projectId, patch.chapterPosition, patch.patchId,
        patch.sourceFingerprint, patch.baseMemoryFingerprint,
        patch.resultMemoryFingerprint, episodicJson, patchJson,
        estimateTokens(patchJson), patch.generatedAt, patch.appliedAt,
      ],
    },
    {
      sql: `INSERT OR REPLACE INTO project_story_memory (
        project_id, schema_version, through_chapter_id,
        through_chapter_position, memory_json, estimated_tokens,
        state_fingerprint, last_applied_patch_id, status, source,
        dirty_from_position, last_error, updated_at
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        state.projectId, state.throughChapterId, state.throughChapterPosition,
        stateJson, state.metadata.estimatedTokens,
        state.metadata.stateFingerprint, state.metadata.lastAppliedPatchId,
        state.metadata.status, state.metadata.source,
        state.metadata.dirtyFromPosition, state.metadata.lastError,
        state.metadata.updatedAt,
      ],
    },
    {
      sql: `UPDATE chapters SET memory_summary = ?, memory_summary_tokens = ?,
        finalized_at = ?, status = 'final', updated_at = ? WHERE id = ?`,
      params: [
        input.episodicMemoryText,
        estimateTokens(input.episodicMemoryText),
        input.finalizedAt,
        input.finalizedAt,
        patch.chapterId,
      ],
    },
  ];
  const shouldSnapshot =
    input.createSnapshot ||
    patch.chapterPosition % STORY_MEMORY_SNAPSHOT_INTERVAL ===
      STORY_MEMORY_SNAPSHOT_INTERVAL - 1;
  if (shouldSnapshot && state.throughChapterId != null) {
    statements.push(
      {
        sql: `INSERT OR REPLACE INTO story_memory_snapshots (
          project_id, through_chapter_id, through_chapter_position,
          memory_json, estimated_tokens, state_fingerprint, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        params: [
          state.projectId, state.throughChapterId,
          state.throughChapterPosition, stateJson,
          state.metadata.estimatedTokens, state.metadata.stateFingerprint,
          state.metadata.updatedAt,
        ],
      },
      {
        sql: `DELETE FROM story_memory_snapshots
          WHERE project_id = ? AND id NOT IN (
            SELECT id FROM story_memory_snapshots WHERE project_id = ?
            ORDER BY through_chapter_position DESC LIMIT ?
          )`,
        params: [
          state.projectId,
          state.projectId,
          STORY_MEMORY_MAX_SNAPSHOTS_PER_PROJECT,
        ],
      },
    );
  }
  await executeTransaction(await openDatabase(), statements);
}
