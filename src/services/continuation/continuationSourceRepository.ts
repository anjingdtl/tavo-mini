/**
 * Continuation source data access (Spec §9, §13).
 *
 * Single repository for the four backed-up continuation tables
 * (sources / chunks / chapters / settings). Import-job persistence lives in
 * the import service. All offsets crossing this boundary are converted
 * to/from the branded {@link Utf16Offset} / {@link SourceChapterPosition}
 * types so callers cannot pass raw numbers where a branded position is
 * required (Spec §6).
 */
import type SQLite from 'react-native-sqlite-storage';
import type {
  SourceChapterPosition,
  Utf16Offset,
} from '../../types/novel';
import { all, one } from '../../data/connection/query';
import { execute } from '../../data/connection/execute';
import {
  executeTransaction,
  type SqlStatement,
} from '../../data/connection/transaction';
import { openDatabase } from '../../data/connection/openDatabase';
import { now, type Row } from '../../data/repositories/shared';
import type {
  ContinuationBoundaryMode,
  ContinuationSettings,
  ContinuationSource,
  ContinuationSourceChapter,
  ContinuationSourceStatus,
} from './types';

// --- branded-type conversions (Spec §6) -------------------------------------

/** Brand a validated non-negative integer as a UTF-16 offset. */
export function asUtf16Offset(value: number): Utf16Offset {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`非法的 UTF-16 偏移：${value}`);
  }
  return value as Utf16Offset;
}

/** Brand a validated non-negative integer as a source chapter position. */
export function asSourcePosition(value: number): SourceChapterPosition {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`非法的原著章节位置：${value}`);
  }
  return value as SourceChapterPosition;
}

// --- row mappers ------------------------------------------------------------

function mapSource(row: Row): ContinuationSource {
  return {
    id: row.id,
    projectId: row.project_id,
    version: row.version,
    status: row.status as ContinuationSourceStatus,
    displayName: row.display_name,
    originalFileName: row.original_file_name,
    mimeType: row.mime_type,
    detectedEncoding: row.detected_encoding,
    fileSizeBytes: row.file_size_bytes,
    rawSha256: row.raw_sha256,
    normalizedSha256: row.normalized_sha256,
    normalizedCharCount: row.normalized_char_count,
    normalizedByteCount: row.normalized_byte_count,
    chapterCount: row.chapter_count,
    parserVersion: row.parser_version,
    normalizationVersion: row.normalization_version,
    errorCode: row.error_code ?? null,
    errorMessage: row.error_message ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activatedAt: row.activated_at ?? null,
  };
}

function mapChapter(row: Row): ContinuationSourceChapter {
  return {
    id: row.id,
    sourceId: row.source_id,
    position: asSourcePosition(row.position),
    volumeTitle: row.volume_title ?? null,
    detectedTitle: row.detected_title,
    title: row.title,
    contentSha256: row.content_sha256,
    charCount: row.char_count,
    paragraphCount: row.paragraph_count,
    sourceStartOffset: asUtf16Offset(row.source_start_offset),
    contentStartOffset: asUtf16Offset(row.content_start_offset),
    sourceEndOffset: asUtf16Offset(row.source_end_offset),
    isExcluded: Number(row.is_excluded) === 1,
    exclusionReason: row.exclusion_reason ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSettings(row: Row): ContinuationSettings {
  return {
    projectId: row.project_id,
    activeSourceId: row.active_source_id ?? null,
    boundarySourceId: row.boundary_source_id ?? null,
    boundaryChapterId: row.boundary_chapter_id ?? null,
    boundaryCharOffsetGlobal:
      row.boundary_char_offset_global === null ||
      row.boundary_char_offset_global === undefined
        ? null
        : asUtf16Offset(row.boundary_char_offset_global),
    boundaryMode: row.boundary_mode as ContinuationBoundaryMode,
    importCompleted: Number(row.import_completed) === 1,
    analysisStatus: row.analysis_status,
    activeCanonSnapshotId: row.active_canon_snapshot_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// --- sources ----------------------------------------------------------------

/** Next version number for a new source in this project (1-based). */
export async function nextSourceVersion(
  db: SQLite.SQLiteDatabase,
  projectId: number,
): Promise<number> {
  const row = await one<{ max_version: number | null }>(
    'SELECT MAX(version) AS max_version FROM continuation_sources WHERE project_id = ?',
    [projectId],
    // Note: all/one default to the shared DB handle; for transactional callers
    // we expose the *_InTx variants below.
  ).catch(() => null);
  // Fall back to a direct query on the supplied handle for in-transaction use.
  if (row) return (row.max_version ?? 0) + 1;
  const [result] = await db.executeSql(
    'SELECT MAX(version) AS max_version FROM continuation_sources WHERE project_id = ?',
    [projectId],
  );
  const maxV = result.rows.length > 0 ? result.rows.item(0).max_version : null;
  return (maxV ?? 0) + 1;
}

export async function nextSourceVersionInTx(
  db: SQLite.SQLiteDatabase,
  projectId: number,
): Promise<number> {
  const [result] = await db.executeSql(
    'SELECT MAX(version) AS max_version FROM continuation_sources WHERE project_id = ?',
    [projectId],
  );
  const maxV = result.rows.length > 0 ? result.rows.item(0).max_version : null;
  return (maxV ?? 0) + 1;
}

export interface InsertSourceInput {
  projectId: number;
  version: number;
  status: ContinuationSourceStatus;
  displayName: string;
  originalFileName: string;
  detectedEncoding: string;
  fileSizeBytes: number;
  rawSha256: string;
  normalizedSha256: string;
  normalizedCharCount: number;
  normalizedByteCount: number;
  chapterCount: number;
  parserVersion: string;
  normalizationVersion: string;
  errorCode?: string | null;
  errorMessage?: string | null;
}

/** INSERT a new source row and return its id. */
export async function insertSource(
  db: SQLite.SQLiteDatabase,
  input: InsertSourceInput,
): Promise<number> {
  const ts = now();
  const [result] = await db.executeSql(
    `INSERT INTO continuation_sources (
      project_id, version, status, display_name, original_file_name, mime_type,
      detected_encoding, file_size_bytes, raw_sha256, normalized_sha256,
      normalized_char_count, normalized_byte_count, chapter_count,
      parser_version, normalization_version, error_code, error_message,
      created_at, updated_at, activated_at
    ) VALUES (?, ?, ?, ?, ?, 'text/plain', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      input.projectId,
      input.version,
      input.status,
      input.displayName,
      input.originalFileName,
      input.detectedEncoding,
      input.fileSizeBytes,
      input.rawSha256,
      input.normalizedSha256,
      input.normalizedCharCount,
      input.normalizedByteCount,
      input.chapterCount,
      input.parserVersion,
      input.normalizationVersion,
      input.errorCode ?? null,
      input.errorMessage ?? null,
      ts,
      ts,
    ],
  );
  const id = result.insertId;
  if (!id) throw new Error('continuation_sources 写入失败：未返回 insertId');
  return id;
}

/** Update mutable status / error fields on a source row. */
export async function updateSourceStatus(
  db: SQLite.SQLiteDatabase,
  sourceId: number,
  status: ContinuationSourceStatus,
  extras?: { errorCode?: string | null; errorMessage?: string | null },
): Promise<void> {
  const ts = now();
  await db.executeSql(
    `UPDATE continuation_sources SET status = ?, error_code = ?, error_message = ?,
      updated_at = ?, activated_at = CASE WHEN ? = 'ready' THEN ? ELSE activated_at END
      WHERE id = ?`,
    [
      status,
      extras?.errorCode ?? null,
      extras?.errorMessage ?? null,
      ts,
      status,
      ts,
      sourceId,
    ],
  );
}

/** Replace the ready/boundary pointers atomically (Spec §6 source-activation). */
export async function activateSourceInTx(
  db: SQLite.SQLiteDatabase,
  projectId: number,
  newSourceId: number,
): Promise<void> {
  const ts = now();
  // 1) mark any prior ready source as superseded
  await db.executeSql(
    `UPDATE continuation_sources SET status = 'superseded', updated_at = ?
      WHERE project_id = ? AND status = 'ready'`,
    [ts, projectId],
  );
  // 2) promote the new source to ready
  await db.executeSql(
    `UPDATE continuation_sources SET status = 'ready', updated_at = ?, activated_at = ?
      WHERE id = ? AND project_id = ?`,
    [ts, ts, newSourceId, projectId],
  );
}

/**
 * Build the full statement list for an atomic source activation
 * (fix-plan §6.2): supersede prior ready, promote the new source, switch the
 * settings active+boundary pointers, and mark in-flight continuation runs as
 * `outdated` — all as one batch so the settings pointer can never point at a
 * superseded source and an old run can never be adopted against the new
 * boundary. The caller wraps these in a single executeTransaction.
 *
 * When `jobId` is supplied, import-job completion belongs to the same atomic
 * boundary as source activation. A crash can then never leave an active source
 * attached to a resumable/cancellable import job.
 */
export function buildActivateSourceBoundaryStatements(input: {
  projectId: number;
  newSourceId: number;
  boundaryChapterId: number;
  boundaryGlobalOffset: number;
  boundaryMode: string;
  ts: string;
  jobId?: string;
}): SqlStatement[] {
  const {
    projectId,
    newSourceId,
    boundaryChapterId,
    boundaryGlobalOffset,
    boundaryMode,
    ts,
    jobId,
  } = input;
  return [
    {
      sql: `UPDATE continuation_sources SET status = 'superseded', updated_at = ?
        WHERE project_id = ? AND status = 'ready'`,
      params: [ts, projectId],
    },
    {
      sql: `UPDATE continuation_sources SET status = 'ready', updated_at = ?, activated_at = ?
        WHERE id = ? AND project_id = ?`,
      params: [ts, ts, newSourceId, projectId],
    },
    {
      sql: `UPDATE continuation_settings SET
        active_source_id = ?,
        boundary_source_id = ?,
        boundary_chapter_id = ?,
        boundary_char_offset_global = ?,
        boundary_mode = ?,
        import_completed = 1,
        analysis_status = 'not_started',
        updated_at = ?
        WHERE project_id = ?`,
      params: [
        newSourceId,
        newSourceId,
        boundaryChapterId,
        boundaryGlobalOffset,
        boundaryMode,
        ts,
        projectId,
      ],
    },
    {
      // Invalidate in-flight continuation runs so stale context is never
      // adopted against the new boundary (fix-plan §6.1).
      sql: `UPDATE continuation_generation_runs
        SET state = 'outdated', error_code = 'outdated',
            error_message = ?, updated_at = ?
        WHERE project_id = ? AND state IN ('queued', 'running', 'awaiting_user', 'interrupted')`,
      params: ['source_or_boundary_changed', ts, projectId],
    },
    ...(jobId
      ? [{
          sql: `UPDATE continuation_import_jobs SET
            state = 'completed', stage = 'activating', progress_current = 1,
            progress_total = 1, completed_at = ?, updated_at = ?
            WHERE id = ? AND project_id = ?`,
          params: [ts, ts, jobId, projectId],
        }]
      : []),
  ];
}

export async function getSourceById(
  sourceId: number,
): Promise<ContinuationSource | null> {
  const row = await one<Row>(
    'SELECT * FROM continuation_sources WHERE id = ?',
    [sourceId],
  );
  return row ? mapSource(row) : null;
}

export async function getSourceByIdInTx(
  db: SQLite.SQLiteDatabase,
  sourceId: number,
): Promise<ContinuationSource | null> {
  const [result] = await db.executeSql(
    'SELECT * FROM continuation_sources WHERE id = ?',
    [sourceId],
  );
  if (result.rows.length === 0) return null;
  return mapSource(result.rows.item(0));
}

/** Active source for a project, read via continuation_settings (Spec §5.11). */
export async function getActiveSource(
  projectId: number,
): Promise<ContinuationSource | null> {
  const row = await one<Row>(
    `SELECT s.* FROM continuation_sources s
      JOIN continuation_settings st ON st.active_source_id = s.id
      WHERE st.project_id = ?`,
    [projectId],
  );
  return row ? mapSource(row) : null;
}

export async function getActiveSourceInTx(
  db: SQLite.SQLiteDatabase,
  projectId: number,
): Promise<ContinuationSource | null> {
  const [result] = await db.executeSql(
    `SELECT s.* FROM continuation_sources s
      JOIN continuation_settings st ON st.active_source_id = s.id
      WHERE st.project_id = ?`,
    [projectId],
  );
  if (result.rows.length === 0) return null;
  return mapSource(result.rows.item(0));
}

/** Physical delete of a source and all its chunks/chapters (Spec §9.2). */
export async function deleteSourceCascade(
  db: SQLite.SQLiteDatabase,
  sourceId: number,
): Promise<void> {
  // chunks/chapters cascade via ON DELETE CASCADE on source_id.
  await db.executeSql('DELETE FROM continuation_sources WHERE id = ?', [
    sourceId,
  ]);
}

// --- chunks -----------------------------------------------------------------

export interface ChunkInput {
  chunkIndex: number;
  charStartOffset: Utf16Offset;
  charEndOffset: Utf16Offset;
  content: string;
  contentSha256: string;
}

/** Insert a batch of chunks within one transaction (Spec §9.3, §10.2). */
export async function insertChunks(
  db: SQLite.SQLiteDatabase,
  sourceId: number,
  chunks: ChunkInput[],
): Promise<void> {
  if (chunks.length === 0) return;
  const statements: SqlStatement[] = chunks.map(c => ({
    sql: `INSERT INTO continuation_source_text_chunks (
        source_id, chunk_index, char_start_offset, char_end_offset, content, content_sha256
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    params: [
      sourceId,
      c.chunkIndex,
      c.charStartOffset,
      c.charEndOffset,
      c.content,
      c.contentSha256,
    ],
  }));
  await executeTransaction(db, statements);
}

/**
 * Read the chunk covering a UTF-16 offset range `[start, end)` for the
 * bounded reader. Returns the raw chunk rows overlapping the range — the
 * caller slices to the exact window (Spec §9.3, §12.3).
 */
export async function readChunksForRange(
  db: SQLite.SQLiteDatabase,
  sourceId: number,
  start: Utf16Offset,
  end: Utf16Offset,
): Promise<
  {
    content: string;
    charStartOffset: number;
    charEndOffset: number;
  }[]
> {
  // A chunk overlaps [start, end) iff char_start_offset < end AND char_end_offset > start.
  const [result] = await db.executeSql(
    `SELECT content, char_start_offset, char_end_offset
      FROM continuation_source_text_chunks
      WHERE source_id = ? AND char_start_offset < ? AND char_end_offset > ?
      ORDER BY char_start_offset ASC`,
    [sourceId, end, start],
  );
  const out: { content: string; charStartOffset: number; charEndOffset: number }[] =
    [];
  for (let i = 0; i < result.rows.length; i++) {
    const r = result.rows.item(i);
    out.push({
      content: r.content,
      charStartOffset: r.char_start_offset,
      charEndOffset: r.char_end_offset,
    });
  }
  return out;
}

/** Integrity check: chunk ranges must be contiguous, non-overlapping (Spec §9.3). */
export async function validateChunkContiguity(
  db: SQLite.SQLiteDatabase,
  sourceId: number,
  expectedCharCount: number,
): Promise<{ ok: boolean; gap?: string }> {
  const [result] = await db.executeSql(
    `SELECT char_start_offset, char_end_offset
      FROM continuation_source_text_chunks
      WHERE source_id = ?
      ORDER BY char_start_offset ASC`,
    [sourceId],
  );
  if (result.rows.length === 0) {
    return { ok: expectedCharCount === 0, gap: 'no chunks' };
  }
  let cursor = 0;
  for (let i = 0; i < result.rows.length; i++) {
    const r = result.rows.item(i);
    if (r.char_start_offset !== cursor) {
      return {
        ok: false,
        gap: `hole/overlap at chunk ${i}: expected ${cursor}, got ${r.char_start_offset}`,
      };
    }
    cursor = r.char_end_offset;
  }
  if (cursor !== expectedCharCount) {
    return {
      ok: false,
      gap: `last chunk ends at ${cursor}, expected ${expectedCharCount}`,
    };
  }
  return { ok: true };
}

// --- chapters ---------------------------------------------------------------

export interface InsertChapterInput {
  position: SourceChapterPosition;
  volumeTitle: string | null;
  detectedTitle: string;
  title: string;
  contentSha256: string;
  charCount: number;
  paragraphCount: number;
  sourceStartOffset: Utf16Offset;
  contentStartOffset: Utf16Offset;
  sourceEndOffset: Utf16Offset;
  isExcluded?: boolean;
  exclusionReason?: string | null;
}

/** Insert a batch of chapter rows within one transaction (Spec §9.4). */
export async function insertChapters(
  db: SQLite.SQLiteDatabase,
  sourceId: number,
  chapters: InsertChapterInput[],
): Promise<void> {
  if (chapters.length === 0) return;
  const ts = now();
  const statements: SqlStatement[] = chapters.map(c => ({
    sql: `INSERT INTO continuation_source_chapters (
        source_id, position, volume_title, detected_title, title, content_sha256,
        char_count, paragraph_count, source_start_offset, content_start_offset,
        source_end_offset, is_excluded, exclusion_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      sourceId,
      c.position,
      c.volumeTitle,
      c.detectedTitle,
      c.title,
      c.contentSha256,
      c.charCount,
      c.paragraphCount,
      c.sourceStartOffset,
      c.contentStartOffset,
      c.sourceEndOffset,
      c.isExcluded ? 1 : 0,
      c.exclusionReason ?? null,
      ts,
      ts,
    ],
  }));
  await executeTransaction(db, statements);
}

export async function getChaptersBySource(
  sourceId: number,
): Promise<ContinuationSourceChapter[]> {
  const rows = await all<Row>(
    'SELECT * FROM continuation_source_chapters WHERE source_id = ? ORDER BY position ASC',
    [sourceId],
  );
  return rows.map(mapChapter);
}

export async function getChaptersBySourceInTx(
  db: SQLite.SQLiteDatabase,
  sourceId: number,
): Promise<ContinuationSourceChapter[]> {
  const [result] = await db.executeSql(
    'SELECT * FROM continuation_source_chapters WHERE source_id = ? ORDER BY position ASC',
    [sourceId],
  );
  const out: ContinuationSourceChapter[] = [];
  for (let i = 0; i < result.rows.length; i++) {
    out.push(mapChapter(result.rows.item(i)));
  }
  return out;
}

export async function getChapterByIdInTx(
  db: SQLite.SQLiteDatabase,
  chapterId: number,
): Promise<ContinuationSourceChapter | null> {
  const [result] = await db.executeSql(
    'SELECT * FROM continuation_source_chapters WHERE id = ?',
    [chapterId],
  );
  if (result.rows.length === 0) return null;
  return mapChapter(result.rows.item(0));
}

// --- settings ---------------------------------------------------------------

/** Ensure a settings row exists for the project (idempotent, Spec §9.5). */
export async function ensureSettingsRow(
  db: SQLite.SQLiteDatabase,
  projectId: number,
): Promise<void> {
  const ts = now();
  await db.executeSql(
    `INSERT OR IGNORE INTO continuation_settings
      (project_id, boundary_mode, import_completed, analysis_status, created_at, updated_at)
      VALUES (?, 'end_of_source', 0, 'not_started', ?, ?)`,
    [projectId, ts, ts],
  );
}

export async function getSettings(
  projectId: number,
): Promise<ContinuationSettings | null> {
  const row = await one<Row>(
    'SELECT * FROM continuation_settings WHERE project_id = ?',
    [projectId],
  );
  return row ? mapSettings(row) : null;
}

export async function getSettingsInTx(
  db: SQLite.SQLiteDatabase,
  projectId: number,
): Promise<ContinuationSettings | null> {
  const [result] = await db.executeSql(
    'SELECT * FROM continuation_settings WHERE project_id = ?',
    [projectId],
  );
  if (result.rows.length === 0) return null;
  return mapSettings(result.rows.item(0));
}

export interface BoundaryUpdate {
  sourceId: number;
  chapterId: number;
  charOffsetGlobal: Utf16Offset;
  mode: ContinuationBoundaryMode;
}

/**
 * Update boundary + active pointer in one transaction (Spec §5.11, §9.5).
 * The CHECK constraints on continuation_settings enforce that boundary fields
 * are either all-null or all-present and point at the active source.
 */
export async function updateBoundaryInTx(
  db: SQLite.SQLiteDatabase,
  projectId: number,
  boundary: BoundaryUpdate,
): Promise<void> {
  const ts = now();
  // Spec §5.9 / Phase 2 §14: boundary change invalidates active Canon snapshot.
  await executeTransaction(db, [
    {
      sql: `UPDATE continuation_canon_snapshots
        SET status = 'outdated', updated_at = ?
        WHERE project_id = ? AND status IN ('staging', 'awaiting_review', 'ready')`,
      params: [ts, projectId],
    },
    {
      sql: `UPDATE continuation_analysis_runs
        SET state = 'outdated', updated_at = ?
        WHERE project_id = ? AND state IN ('queued', 'running', 'paused', 'awaiting_review')`,
      params: [ts, projectId],
    },
    {
      sql: `UPDATE continuation_settings SET
          active_source_id = ?,
          boundary_source_id = ?,
          boundary_chapter_id = ?,
          boundary_char_offset_global = ?,
          boundary_mode = ?,
          analysis_status = 'outdated',
          active_canon_snapshot_id = NULL,
          updated_at = ?
        WHERE project_id = ?`,
      params: [
        boundary.sourceId,
        boundary.sourceId,
        boundary.chapterId,
        boundary.charOffsetGlobal,
        boundary.mode,
        ts,
        projectId,
      ],
    },
  ]);
}

/** Mark analysis outdated without changing the boundary (Spec §5.9 / Phase 2 §14). */
export async function markAnalysisOutdated(
  db: SQLite.SQLiteDatabase,
  projectId: number,
): Promise<void> {
  const ts = now();
  await executeTransaction(db, [
    {
      sql: `UPDATE continuation_canon_snapshots
        SET status = 'outdated', updated_at = ?
        WHERE project_id = ? AND status IN ('staging', 'awaiting_review', 'ready')`,
      params: [ts, projectId],
    },
    {
      sql: `UPDATE continuation_analysis_runs
        SET state = 'outdated', updated_at = ?
        WHERE project_id = ? AND state IN ('queued', 'running', 'paused', 'awaiting_review')`,
      params: [ts, projectId],
    },
    {
      sql: `UPDATE continuation_settings SET
          analysis_status = 'outdated',
          active_canon_snapshot_id = NULL,
          updated_at = ?
        WHERE project_id = ?`,
      params: [ts, projectId],
    },
  ]);
}

/** Clear the active source pointer, then physical-delete the source row (Spec §6). */
export async function clearActiveSourceAndDelete(
  db: SQLite.SQLiteDatabase,
  projectId: number,
  sourceId: number,
): Promise<void> {
  const ts = now();
  await executeTransaction(db, [
    {
      sql: `UPDATE continuation_settings SET
          active_source_id = NULL,
          boundary_source_id = NULL,
          boundary_chapter_id = NULL,
          boundary_char_offset_global = NULL,
          import_completed = 0,
          analysis_status = 'not_started',
          active_canon_snapshot_id = NULL,
          updated_at = ?
        WHERE project_id = ?`,
      params: [ts, projectId],
    },
    {
      sql: 'DELETE FROM continuation_sources WHERE id = ?',
      params: [sourceId],
    },
    {
      // Fix-plan §6.1: deleting the active source invalidates in-flight runs so
      // their frozen source snapshot can never be adopted against the now-empty
      // active source.
      sql: `UPDATE continuation_generation_runs
        SET state = 'outdated', error_code = 'outdated',
            error_message = ?, updated_at = ?
        WHERE project_id = ? AND state IN ('queued', 'running', 'awaiting_user', 'interrupted')`,
      params: ['source_deleted', ts, projectId],
    },
  ]);
}

/** Convenience: open the shared DB handle for non-transactional callers. */
export async function getDb(): Promise<SQLite.SQLiteDatabase> {
  return openDatabase();
}

/** Re-exported for services that already hold a handle. */
export async function touchProject(projectId: number): Promise<void> {
  await execute(
    await openDatabase(),
    'UPDATE projects SET updated_at = ? WHERE id = ?',
    [now(), projectId],
  );
}
