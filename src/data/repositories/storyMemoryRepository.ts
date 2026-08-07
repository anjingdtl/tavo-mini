import { execute } from '../connection/execute';
import { openDatabase } from '../connection/openDatabase';
import { all, one } from '../connection/query';
import {
  executeTransaction,
  type SqlStatement,
} from '../connection/transaction';
import { canonicalStringify } from '../../services/storyMemory/storyMemoryFingerprint';
import { createEmptyStoryMemory } from '../../services/storyMemory/storyMemoryDefaults';
import {
  clampIntervalChapters,
  createDefaultStoryMemoryPolicy,
  normalizeStoryMemoryMode,
  STORY_MEMORY_DEFAULT_PENDING_SOFT_LIMIT,
} from '../../services/storyMemory/storyMemoryPolicy';
import type {
  BatchChapterSummary,
  StoredChapterMemoryPatch,
  StoredStoryMemoryBatch,
  StoryMemoryBatchPatchDraft,
  StoryMemoryBatchStatus,
  StoryMemoryBuildStatus,
  StoryMemoryPolicy,
  StoryMemoryState,
  StoryMemoryUpdateMode,
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

export interface SaveStoryMemoryBatchUpdateInput {
  previousFingerprint: string;
  state: StoryMemoryState;
  batch: StoredStoryMemoryBatch;
  chapterSummaries: Array<{
    chapterId: number;
    text: string;
    estimatedTokens: number;
  }>;
  createSnapshot?: boolean;
}

interface PolicyDbRow {
  project_id: number;
  mode: string;
  interval_chapters: number;
  pending_token_soft_limit: number;
  update_on_key_chapter: number;
  updated_at: string;
}

interface BatchDbRow {
  batch_id: string;
  project_id: number;
  from_chapter_id: number;
  from_position: number;
  through_chapter_id: number;
  through_position: number;
  schema_version: number;
  source_fingerprint: string;
  base_state_fingerprint: string;
  result_state_fingerprint: string;
  patch_json: string;
  chapter_summaries_json: string;
  estimated_tokens: number;
  status: StoryMemoryBatchStatus;
  last_error: string;
  generated_at: string;
  applied_at: string | null;
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

function mapSnapshotRow(
  row: StoryMemorySnapshotDbRow,
): StoryMemorySnapshotRecord {
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

/**
 * Pure SQL builders for composition into larger transactions (e.g. chapter
 * update/delete + dirty + batch invalidation must share one SQLite transaction).
 */
export function buildInvalidateAppliedStoryMemoryBatchesFromStatements(
  projectId: number,
  fromPosition: number,
  reason = '已覆盖章节已变更，批次失效',
): SqlStatement[] {
  return [
    {
      sql: `UPDATE story_memory_batches
     SET status = 'invalidated', last_error = ?
     WHERE project_id = ?
       AND status = 'applied'
       AND through_position >= ?`,
      params: [reason, projectId, fromPosition],
    },
  ];
}

export function buildMarkStoryMemoryDirtyStatements(
  projectId: number,
  fromPosition: number,
  reason = '',
  updatedAt: string = new Date().toISOString(),
): SqlStatement[] {
  return [
    {
      sql: `UPDATE project_story_memory SET
      status = 'dirty',
      dirty_from_position = CASE
        WHEN dirty_from_position IS NULL THEN ?
        WHEN dirty_from_position > ? THEN ?
        ELSE dirty_from_position
      END,
      last_error = ?, updated_at = ?
     WHERE project_id = ?`,
      params: [
        fromPosition,
        fromPosition,
        fromPosition,
        reason,
        updatedAt,
        projectId,
      ],
    },
    // Drop applied batches from the dirty point forward so rebuild cannot reuse
    // a stale post-edit checkpoint chain.
    ...buildInvalidateAppliedStoryMemoryBatchesFromStatements(
      projectId,
      fromPosition,
    ),
  ];
}

export function buildInvalidateStoryMemoryBatchesOverlappingStatements(
  projectId: number,
  fromPosition: number,
  toPosition: number = Number.MAX_SAFE_INTEGER,
): SqlStatement[] {
  return [
    {
      sql: `UPDATE story_memory_batches
     SET status = 'invalidated', last_error = ?
     WHERE project_id = ?
       AND status IN ('generated', 'failed')
       AND from_position <= ?
       AND through_position >= ?`,
      params: ['pending 范围章节已变更', projectId, toPosition, fromPosition],
    },
  ];
}

/**
 * Decide dirty vs pending-invalidation side effects without opening a connection.
 * Callers compose the returned statements into a larger transaction.
 */
export function buildStoryMemoryContinuitySideEffects(
  record: ProjectStoryMemoryRecord | null,
  projectId: number,
  affectedPosition: number,
  reason = '',
  updatedAt: string = new Date().toISOString(),
): {
  outcome: 'dirty' | 'pending_invalidated' | 'none';
  statements: SqlStatement[];
} {
  if (!record) {
    return { outcome: 'none', statements: [] };
  }
  if (affectedPosition <= record.state.throughChapterPosition) {
    return {
      outcome: 'dirty',
      statements: buildMarkStoryMemoryDirtyStatements(
        projectId,
        affectedPosition,
        reason,
        updatedAt,
      ),
    };
  }
  return {
    outcome: 'pending_invalidated',
    statements: buildInvalidateStoryMemoryBatchesOverlappingStatements(
      projectId,
      affectedPosition,
      affectedPosition,
    ),
  };
}

/**
 * Invalidate already-applied checkpoint batches that cover or follow a dirty
 * edit. Without this, rebuild may regenerate only the changed batch while
 * reusing later batches that still encode the pre-edit world.
 */
export async function invalidateAppliedStoryMemoryBatchesFrom(
  projectId: number,
  fromPosition: number,
  reason = '已覆盖章节已变更，批次失效',
): Promise<void> {
  await executeTransaction(
    await openDatabase(),
    buildInvalidateAppliedStoryMemoryBatchesFromStatements(
      projectId,
      fromPosition,
      reason,
    ),
  );
}

export async function markStoryMemoryDirty(
  projectId: number,
  fromPosition: number,
  reason = '',
): Promise<void> {
  await ensureProjectStoryMemoryRow(projectId);
  await executeTransaction(
    await openDatabase(),
    buildMarkStoryMemoryDirtyStatements(projectId, fromPosition, reason),
  );
}

export async function setStoryMemoryBuildStatus(
  projectId: number,
  status: StoryMemoryBuildStatus,
  dirtyFromPosition: number | null,
  lastError = '',
): Promise<void> {
  await ensureProjectStoryMemoryRow(projectId);
  await execute(
    await openDatabase(),
    `UPDATE project_story_memory SET status = ?, dirty_from_position = ?,
      last_error = ?, updated_at = ? WHERE project_id = ?`,
    [status, dirtyFromPosition, lastError, new Date().toISOString(), projectId],
  );
}

export async function clearStoryMemory(projectId: number): Promise<void> {
  await executeTransaction(await openDatabase(), [
    {
      sql: 'DELETE FROM story_memory_batches WHERE project_id = ?',
      params: [projectId],
    },
    {
      sql: 'DELETE FROM story_memory_snapshots WHERE project_id = ?',
      params: [projectId],
    },
    {
      sql: 'DELETE FROM chapter_memory_patches WHERE project_id = ?',
      params: [projectId],
    },
    {
      sql: 'DELETE FROM project_story_memory_policy WHERE project_id = ?',
      params: [projectId],
    },
    {
      sql: 'DELETE FROM project_story_memory WHERE project_id = ?',
      params: [projectId],
    },
  ]);
}

function mapPolicyRow(row: PolicyDbRow): StoryMemoryPolicy {
  return createDefaultStoryMemoryPolicy(row.project_id, {
    mode: normalizeStoryMemoryMode(row.mode),
    intervalChapters: clampIntervalChapters(row.interval_chapters),
    pendingTokenSoftLimit: row.pending_token_soft_limit,
    updateOnKeyChapter: row.update_on_key_chapter !== 0,
    updatedAt: row.updated_at,
  });
}

function mapBatchRow(row: BatchDbRow): StoredStoryMemoryBatch {
  return {
    batchId: row.batch_id,
    projectId: row.project_id,
    fromChapterId: row.from_chapter_id,
    fromPosition: row.from_position,
    throughChapterId: row.through_chapter_id,
    throughPosition: row.through_position,
    schemaVersion: 2,
    sourceFingerprint: row.source_fingerprint,
    baseStateFingerprint: row.base_state_fingerprint,
    resultStateFingerprint: row.result_state_fingerprint,
    patch: parseJson<StoryMemoryBatchPatchDraft>(
      row.patch_json,
      '检查点批次补丁',
    ),
    chapterSummaries: parseJson<BatchChapterSummary[]>(
      row.chapter_summaries_json,
      '检查点章节摘要',
    ),
    estimatedTokens: row.estimated_tokens,
    status: row.status,
    lastError: row.last_error,
    generatedAt: row.generated_at,
    appliedAt: row.applied_at,
  };
}

export async function getStoryMemoryPolicy(
  projectId: number,
): Promise<StoryMemoryPolicy | null> {
  const row = await one<PolicyDbRow>(
    'SELECT * FROM project_story_memory_policy WHERE project_id = ?',
    [projectId],
  );
  return row ? mapPolicyRow(row) : null;
}

export async function ensureStoryMemoryPolicy(
  projectId: number,
  slidingWindowSize?: number,
): Promise<StoryMemoryPolicy> {
  const existing = await getStoryMemoryPolicy(projectId);
  if (existing) return existing;
  // Default soft limit aligns with the default 10-chapter trigger interval
  // (10 × ~1.2K tokens). A low limit would make smart mode auto-update every
  // 2-3 chapters and defeat the "roughly every 10 chapters" cadence.
  const pendingTokenSoftLimit = Math.max(
    STORY_MEMORY_DEFAULT_PENDING_SOFT_LIMIT,
    Math.round((slidingWindowSize || 4000) * 0.6),
  );
  const policy = createDefaultStoryMemoryPolicy(projectId, {
    pendingTokenSoftLimit,
  });
  await upsertStoryMemoryPolicy(policy);
  return policy;
}

export async function upsertStoryMemoryPolicy(
  policy: StoryMemoryPolicy,
): Promise<StoryMemoryPolicy> {
  const mode = normalizeStoryMemoryMode(policy.mode);
  const intervalChapters = clampIntervalChapters(policy.intervalChapters);
  if (intervalChapters !== policy.intervalChapters || mode !== policy.mode) {
    // repository-side clamp; callers may still validate UI input.
  }
  if (
    !Number.isFinite(policy.pendingTokenSoftLimit) ||
    policy.pendingTokenSoftLimit < 200
  ) {
    throw new StoryMemoryError(
      'MEMORY_CHECKPOINT_SCHEMA_INVALID',
      'pendingTokenSoftLimit 无效。',
    );
  }
  const normalized = createDefaultStoryMemoryPolicy(policy.projectId, {
    ...policy,
    mode,
    intervalChapters,
    updatedAt: policy.updatedAt || new Date().toISOString(),
  });
  await execute(
    await openDatabase(),
    `INSERT OR REPLACE INTO project_story_memory_policy (
      project_id, mode, interval_chapters, pending_token_soft_limit,
      update_on_key_chapter, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      normalized.projectId,
      normalized.mode,
      normalized.intervalChapters,
      normalized.pendingTokenSoftLimit,
      normalized.updateOnKeyChapter ? 1 : 0,
      normalized.updatedAt,
    ],
  );
  return normalized;
}

export async function getStoryMemoryBatch(
  batchId: string,
): Promise<StoredStoryMemoryBatch | null> {
  const row = await one<BatchDbRow>(
    'SELECT * FROM story_memory_batches WHERE batch_id = ?',
    [batchId],
  );
  return row ? mapBatchRow(row) : null;
}

export async function listStoryMemoryBatches(
  projectId: number,
  statuses?: StoryMemoryBatchStatus[],
): Promise<StoredStoryMemoryBatch[]> {
  if (statuses && statuses.length > 0) {
    const placeholders = statuses.map(() => '?').join(', ');
    const rows = await all<BatchDbRow>(
      `SELECT * FROM story_memory_batches
       WHERE project_id = ? AND status IN (${placeholders})
       ORDER BY through_position ASC`,
      [projectId, ...statuses],
    );
    return rows.map(mapBatchRow);
  }
  const rows = await all<BatchDbRow>(
    `SELECT * FROM story_memory_batches
     WHERE project_id = ? ORDER BY through_position ASC`,
    [projectId],
  );
  return rows.map(mapBatchRow);
}

export async function upsertStoryMemoryBatch(
  batch: StoredStoryMemoryBatch,
): Promise<void> {
  await execute(
    await openDatabase(),
    `INSERT OR REPLACE INTO story_memory_batches (
      batch_id, project_id, from_chapter_id, from_position,
      through_chapter_id, through_position, schema_version,
      source_fingerprint, base_state_fingerprint, result_state_fingerprint,
      patch_json, chapter_summaries_json, estimated_tokens, status,
      last_error, generated_at, applied_at
    ) VALUES (?, ?, ?, ?, ?, ?, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      batch.batchId,
      batch.projectId,
      batch.fromChapterId,
      batch.fromPosition,
      batch.throughChapterId,
      batch.throughPosition,
      batch.sourceFingerprint,
      batch.baseStateFingerprint,
      batch.resultStateFingerprint,
      canonicalStringify(batch.patch),
      canonicalStringify(batch.chapterSummaries),
      batch.estimatedTokens,
      batch.status,
      batch.lastError,
      batch.generatedAt,
      batch.appliedAt,
    ],
  );
}

export async function invalidateStoryMemoryBatchesOverlapping(
  projectId: number,
  fromPosition: number,
  toPosition: number = Number.MAX_SAFE_INTEGER,
): Promise<void> {
  await executeTransaction(
    await openDatabase(),
    buildInvalidateStoryMemoryBatchesOverlappingStatements(
      projectId,
      fromPosition,
      toPosition,
    ),
  );
}

export async function finalizeChapterLocally(
  chapterId: number,
  finalizedAt: string,
): Promise<void> {
  await execute(
    await openDatabase(),
    `UPDATE chapters SET status = 'final', finalized_at = ?, updated_at = ?
     WHERE id = ?`,
    [finalizedAt, finalizedAt, chapterId],
  );
}

export async function saveStoryMemoryBatchUpdate(
  input: SaveStoryMemoryBatchUpdateInput,
): Promise<void> {
  const { state, batch } = input;
  const stateJson = canonicalStringify(state);
  const statements: SqlStatement[] = [
    {
      sql: `INSERT OR REPLACE INTO story_memory_batches (
        batch_id, project_id, from_chapter_id, from_position,
        through_chapter_id, through_position, schema_version,
        source_fingerprint, base_state_fingerprint, result_state_fingerprint,
        patch_json, chapter_summaries_json, estimated_tokens, status,
        last_error, generated_at, applied_at
      ) VALUES (?, ?, ?, ?, ?, ?, 2, ?,
        CASE
          WHEN (SELECT state_fingerprint FROM project_story_memory
                WHERE project_id = ? AND status <> 'dirty') = ? THEN ?
          ELSE NULL
        END,
        ?, ?, ?, ?, 'applied', '', ?, ?)`,
      params: [
        batch.batchId,
        batch.projectId,
        batch.fromChapterId,
        batch.fromPosition,
        batch.throughChapterId,
        batch.throughPosition,
        batch.sourceFingerprint,
        state.projectId,
        input.previousFingerprint,
        batch.baseStateFingerprint,
        batch.resultStateFingerprint || state.metadata.stateFingerprint,
        canonicalStringify(batch.patch),
        canonicalStringify(batch.chapterSummaries),
        batch.estimatedTokens,
        batch.generatedAt,
        batch.appliedAt || state.metadata.updatedAt,
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
        state.projectId,
        state.throughChapterId,
        state.throughChapterPosition,
        stateJson,
        state.metadata.estimatedTokens,
        state.metadata.stateFingerprint,
        state.metadata.lastAppliedPatchId,
        state.metadata.status,
        state.metadata.source,
        state.metadata.dirtyFromPosition,
        state.metadata.lastError,
        state.metadata.updatedAt,
      ],
    },
  ];
  for (const summary of input.chapterSummaries) {
    statements.push({
      sql: `UPDATE chapters SET memory_summary = ?, memory_summary_tokens = ?,
        updated_at = ? WHERE id = ?`,
      params: [
        summary.text,
        summary.estimatedTokens,
        state.metadata.updatedAt,
        summary.chapterId,
      ],
    });
  }
  const shouldSnapshot =
    input.createSnapshot !== false && state.throughChapterId != null;
  if (shouldSnapshot) {
    statements.push(
      {
        sql: `INSERT OR REPLACE INTO story_memory_snapshots (
          project_id, through_chapter_id, through_chapter_position,
          memory_json, estimated_tokens, state_fingerprint, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        params: [
          state.projectId,
          state.throughChapterId,
          state.throughChapterPosition,
          stateJson,
          state.metadata.estimatedTokens,
          state.metadata.stateFingerprint,
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
  try {
    await executeTransaction(await openDatabase(), statements);
  } catch (error) {
    const message = error instanceof Error ? error.message : '检查点事务失败。';
    if (message.includes('base_state_fingerprint')) {
      throw new StoryMemoryError(
        'MEMORY_BASE_FINGERPRINT_MISMATCH',
        '故事记忆在整理期间发生了变化，本批次未写入。',
      );
    }
    throw new StoryMemoryError('MEMORY_CHECKPOINT_TRANSACTION_FAILED', message);
  }
}

/** Mark dirty only when edited/deleted position is within checkpoint coverage. */
export async function markStoryMemoryDirtyIfCovered(
  projectId: number,
  affectedPosition: number,
  reason = '',
): Promise<'dirty' | 'pending_invalidated' | 'none'> {
  const record = await getProjectStoryMemory(projectId);
  const { outcome, statements } = buildStoryMemoryContinuitySideEffects(
    record,
    projectId,
    affectedPosition,
    reason,
  );
  if (statements.length > 0) {
    await executeTransaction(await openDatabase(), statements);
  }
  return outcome;
}

export type { StoryMemoryUpdateMode };

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
        patch.chapterId,
        patch.projectId,
        patch.chapterPosition,
        patch.patchId,
        patch.sourceFingerprint,
        patch.baseMemoryFingerprint,
        patch.resultMemoryFingerprint,
        episodicJson,
        patchJson,
        estimateTokens(patchJson),
        patch.generatedAt,
        patch.appliedAt,
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
        state.projectId,
        state.throughChapterId,
        state.throughChapterPosition,
        stateJson,
        state.metadata.estimatedTokens,
        state.metadata.stateFingerprint,
        state.metadata.lastAppliedPatchId,
        state.metadata.status,
        state.metadata.source,
        state.metadata.dirtyFromPosition,
        state.metadata.lastError,
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
          state.projectId,
          state.throughChapterId,
          state.throughChapterPosition,
          stateJson,
          state.metadata.estimatedTokens,
          state.metadata.stateFingerprint,
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
