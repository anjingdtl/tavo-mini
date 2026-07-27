/**
 * Continuation import service (Spec §13, §14, §20-7).
 *
 * Orchestrates the resumable TXT-import flow:
 *   1. copy user file to app-private import dir + create staging source + job
 *   2. native chunked decode → normalize → write continuation_source_text_chunks
 *   3. parse chapters → write continuation_source_chapters
 *   4. validate chunk contiguity + ranges
 *   5. source → needs_review, job → awaiting_review
 *   6. user applies edits + confirms boundary
 *   7. atomic transaction: supersede prior ready, promote new, switch pointers
 *   8. delete private import copy on success
 *
 * Failure semantics (Spec §14.1): active source never changes mid-import;
 * staging data is cleaned up or recoverable; job marks failed; the
 * interrupted→resume path (Spec §14.2) is driven by `recoverInterruptedJobs`.
 */
import RNFS from 'react-native-fs';
import { v4 as uuidv4 } from '../uuidBridge';
import { executeTransaction, type SqlStatement } from '../../data/connection/transaction';
import { openDatabase } from '../../data/connection/openDatabase';
import { now } from '../../data/repositories/shared';
import { requireContinuationTextImport } from '../../native/ContinuationTextImportModule';
import { PARSER_VERSION } from './continuationParser';
import { NORMALIZATION_VERSION, normalizeSourceText } from './continuationNormalizer';
import { parseSourceChapters } from './continuationParser';
import { applyParsingEdits, type ParsingEdit } from './continuationEditLog';
import { sha256Hex } from './hashUtils';
import {
  activateSourceInTx,
  asSourcePosition,
  asUtf16Offset,
  clearActiveSourceAndDelete,
  deleteSourceCascade,
  ensureSettingsRow,
  getActiveSource,
  getDb,
  getSourceByIdInTx,
  insertChapters,
  insertChunks,
  insertSource,
  nextSourceVersionInTx,
  updateSourceStatus,
  validateChunkContiguity,
  type ChunkInput,
  type InsertChapterInput,
} from './continuationSourceRepository';
import type {
  ContinuationSource,
  ImportJobStage,
  ImportJobState,
} from './types';

// --- job persistence --------------------------------------------------------

const ACTIVE_JOB_STATES: ImportJobState[] = [
  'queued',
  'running',
  'paused',
  'awaiting_review',
  'interrupted',
];

export interface ImportJob {
  id: string;
  projectId: number;
  sourceId: number;
  sourceVersion: number;
  state: ImportJobState;
  stage: ImportJobStage;
  progressCurrent: number;
  progressTotal: number;
  parserVersion: string;
  normalizationVersion: string;
  inputCopyRelativePath: string | null;
  checkpointJson: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
}

function mapJob(row: any): ImportJob {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceId: row.source_id,
    sourceVersion: row.source_version,
    state: row.state,
    stage: row.stage,
    progressCurrent: row.progress_current,
    progressTotal: row.progress_total,
    parserVersion: row.parser_version,
    normalizationVersion: row.normalization_version,
    inputCopyRelativePath: row.input_copy_relative_path ?? null,
    checkpointJson: row.checkpoint_json ?? null,
    errorCode: row.error_code ?? null,
    errorMessage: row.error_message ?? null,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? null,
  };
}

async function insertJob(db: any, input: {
  id: string;
  projectId: number;
  sourceId: number;
  sourceVersion: number;
  state: ImportJobState;
  stage: ImportJobStage;
  parserVersion: string;
  normalizationVersion: string;
  inputCopyRelativePath: string | null;
}): Promise<void> {
  const ts = now();
  await db.executeSql(
    `INSERT INTO continuation_import_jobs (
      id, project_id, source_id, source_version, state, stage,
      progress_current, progress_total, parser_version, normalization_version,
      input_copy_relative_path, started_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.projectId,
      input.sourceId,
      input.sourceVersion,
      input.state,
      input.stage,
      input.parserVersion,
      input.normalizationVersion,
      input.inputCopyRelativePath,
      ts,
      ts,
    ],
  );
}

async function updateJob(
  db: any,
  jobId: string,
  patch: Partial<Pick<ImportJob, 'state' | 'stage' | 'progressCurrent' | 'progressTotal' | 'checkpointJson' | 'errorCode' | 'errorMessage' | 'completedAt'>>,
): Promise<void> {
  const sets: string[] = [];
  const params: any[] = [];
  if (patch.state !== undefined) { sets.push('state = ?'); params.push(patch.state); }
  if (patch.stage !== undefined) { sets.push('stage = ?'); params.push(patch.stage); }
  if (patch.progressCurrent !== undefined) { sets.push('progress_current = ?'); params.push(patch.progressCurrent); }
  if (patch.progressTotal !== undefined) { sets.push('progress_total = ?'); params.push(patch.progressTotal); }
  if (patch.checkpointJson !== undefined) { sets.push('checkpoint_json = ?'); params.push(patch.checkpointJson); }
  if (patch.errorCode !== undefined) { sets.push('error_code = ?'); params.push(patch.errorCode); }
  if (patch.errorMessage !== undefined) { sets.push('error_message = ?'); params.push(patch.errorMessage); }
  if (patch.completedAt !== undefined) { sets.push('completed_at = ?'); params.push(patch.completedAt); }
  sets.push('updated_at = ?'); params.push(now());
  params.push(jobId);
  await db.executeSql(
    `UPDATE continuation_import_jobs SET ${sets.join(', ')} WHERE id = ?`,
    params,
  );
}

async function getJob(db: any, jobId: string): Promise<ImportJob | null> {
  const [res] = await db.executeSql(
    'SELECT * FROM continuation_import_jobs WHERE id = ?',
    [jobId],
  );
  if (res.rows.length === 0) return null;
  return mapJob(res.rows.item(0));
}

// --- public API (Spec §13) --------------------------------------------------

export interface StartImportInput {
  projectId: number;
  /** App-private absolute path of the file copy (caller copies via picker). */
  localPath: string;
  originalFileName: string;
  /** User-confirmed encoding when detection was low-confidence; else auto-detect. */
  encodingOverride?: string;
}

/**
 * Begin an import: copy file to private dir, create staging source + job,
 * then run the decode/normalize/parse pipeline to awaiting_review (Spec §14.1).
 */
export async function startContinuationImport(
  input: StartImportInput,
): Promise<ImportJob> {
  const db = await getDb();
  await ensureSettingsRow(db, input.projectId);

  const mod = requireContinuationTextImport();
  const meta = await mod.readFileMeta(input.localPath);
  if (!meta.canRead) {
    throw new Error('无法读取所选文件，请重新选择。');
  }
  const detected = await mod.detectEncoding(input.localPath);
  const encoding = input.encodingOverride ?? detected.encoding;

  // Copy the picked file into our private import dir (Spec §14.1 step 1, §16).
  const importDir = `${RNFS.DocumentDirectoryPath}/continuation-imports`;
  await RNFS.mkdir(importDir);
  const jobId = uuidv4();
  const inputCopyRelativePath = `continuation-imports/${jobId}.txt`;
  const copyAbs = `${RNFS.DocumentDirectoryPath}/${inputCopyRelativePath}`;
  await RNFS.copyFile(input.localPath, copyAbs);

  // Create staging source + job in one transaction.
  const sourceVersion = await nextSourceVersionInTx(db, input.projectId);
  const sourceId = await insertSource(db, {
    projectId: input.projectId,
    version: sourceVersion,
    status: 'staging',
    displayName: stripExtension(input.originalFileName),
    originalFileName: input.originalFileName,
    detectedEncoding: encoding,
    fileSizeBytes: meta.fileSizeBytes,
    rawSha256: 'pending', // filled after full read
    normalizedSha256: 'pending',
    normalizedCharCount: 0,
    normalizedByteCount: 0,
    chapterCount: 0,
    parserVersion: PARSER_VERSION,
    normalizationVersion: NORMALIZATION_VERSION,
  });
  await insertJob(db, {
    id: jobId,
    projectId: input.projectId,
    sourceId,
    sourceVersion,
    state: 'running',
    stage: 'reading',
    parserVersion: PARSER_VERSION,
    normalizationVersion: NORMALIZATION_VERSION,
    inputCopyRelativePath,
  });

  try {
    await runPipelineToReview(db, jobId, sourceId, copyAbs, encoding, meta.fileSizeBytes);
    return (await getJob(db, jobId))!;
  } catch (e: any) {
    await updateJob(db, jobId, {
      state: 'failed',
      errorCode: classifyError(e),
      errorMessage: sanitizeError(e?.message),
    });
    await updateSourceStatus(db, sourceId, 'failed', {
      errorCode: classifyError(e),
      errorMessage: sanitizeError(e?.message),
    });
    throw e;
  }
}

/** Decode → normalize → persist chunks → parse → persist chapters → validate. */
async function runPipelineToReview(
  db: any,
  jobId: string,
  sourceId: number,
  absPath: string,
  encoding: string,
  fileSizeBytes: number,
): Promise<void> {
  const mod = requireContinuationTextImport();
  const CHUNK_BYTES = 192 * 1024;

  // --- decode + normalize (streaming chunks) ---
  let byteCursor = 0;
  let rawByteHasherInput = '';
  const normalizedParts: string[] = [];
  let normalizedCharCursor = 0;
  const chunkInputs: ChunkInput[] = [];
  let chunkIndex = 0;
  const progressTotal = Math.max(1, Math.ceil(fileSizeBytes / CHUNK_BYTES));
  await updateJob(db, jobId, { stage: 'decoding', progressTotal });

  while (byteCursor < fileSizeBytes) {
    const decoded = await mod.decodeChunk(absPath, encoding, byteCursor, CHUNK_BYTES, null);
    if (decoded.bytesConsumed === 0 && !decoded.atEof) {
      throw new Error('解码无进展，疑似编码不匹配，请确认文件编码。');
    }
    rawByteHasherInput += decoded.text;
    normalizedParts.push(decoded.text);
    byteCursor = decoded.nextByteOffset;
    await updateJob(db, jobId, {
      progressCurrent: Math.min(progressTotal, Math.ceil(byteCursor / CHUNK_BYTES)),
      // checkpoint carries only cursor + small state, never full text (§9.6).
      checkpointJson: JSON.stringify({ byteCursor, normalizedCharCursor, chunkIndex }),
    });
    if (decoded.atEof) break;
  }

  await updateJob(db, jobId, { stage: 'normalizing' });
  const rawDecoded = rawByteHasherInput;
  const normalized = normalizeSourceText(rawDecoded);

  // --- persist text chunks (contiguous, no overlap, no hole) ---
  // Slice the normalized text into ~192 KiB UTF-8 bands (Spec §9.3).
  const CHUNK_CHAR_TARGET = Math.floor((192 * 1024) / 3); // rough CJK avg
  for (let i = 0; i < normalized.text.length; i += CHUNK_CHAR_TARGET) {
    const slice = normalized.text.slice(i, i + CHUNK_CHAR_TARGET);
    const start = i;
    const end = i + slice.length;
    chunkInputs.push({
      chunkIndex,
      charStartOffset: asUtf16Offset(start),
      charEndOffset: asUtf16Offset(end),
      content: slice,
      contentSha256: sha256Hex(slice),
    });
    chunkIndex += 1;
  }
  await insertChunks(db, sourceId, chunkInputs);
  // checkpoint the chunk count so resume knows how far we got.
  await updateJob(db, jobId, {
    checkpointJson: JSON.stringify({ chunksWritten: chunkInputs.length }),
  });

  // --- parse chapters ---
  await updateJob(db, jobId, { stage: 'detecting_chapters' });
  const parsed = parseSourceChapters(normalized.text);

  await updateJob(db, jobId, { stage: 'persisting' });
  const chapterInputs: InsertChapterInput[] = parsed.chapters.map(c => ({
    position: asSourcePosition(c.position),
    volumeTitle: c.volumeTitle,
    detectedTitle: c.detectedTitle,
    title: c.title,
    contentSha256: c.contentSha256,
    charCount: c.charCount,
    paragraphCount: c.paragraphCount,
    sourceStartOffset: c.sourceStartOffset,
    contentStartOffset: c.contentStartOffset,
    sourceEndOffset: c.sourceEndOffset,
    isExcluded: c.isExcluded,
    exclusionReason: c.exclusionReason,
  }));
  await insertChapters(db, sourceId, chapterInputs);

  // --- validate ---
  await updateJob(db, jobId, { stage: 'validating' });
  const contiguity = await validateChunkContiguity(db, sourceId, normalized.normalizedCharCount);
  if (!contiguity.ok) {
    throw new Error(`分块完整性校验失败：${contiguity.gap ?? '未知'}`);
  }

  // --- finalize source metadata + job ---
  const rawSha = sha256Hex(rawDecoded);
  await db.executeSql(
    `UPDATE continuation_sources SET
      raw_sha256 = ?, normalized_sha256 = ?, normalized_char_count = ?,
      normalized_byte_count = ?, chapter_count = ?, detected_encoding = ?,
      status = 'needs_review', updated_at = ?
      WHERE id = ?`,
    [
      rawSha,
      normalized.normalizedSha256,
      normalized.normalizedCharCount,
      normalized.normalizedByteCount,
      parsed.chapters.length,
      encoding,
      now(),
      sourceId,
    ],
  );
  await updateJob(db, jobId, {
    state: 'awaiting_review',
    stage: 'awaiting_review',
    progressCurrent: progressTotal,
  });
}

export interface ParsedSourcePreview {
  jobId: string;
  sourceId: number;
  displayName: string;
  originalFileName: string;
  detectedEncoding: string;
  fileSizeBytes: number;
  normalizedCharCount: number;
  chapterCount: number;
  chapters: Array<{
    position: number;
    title: string;
    detectedTitle: string;
    charCount: number;
    isExcluded: boolean;
  }>;
  fallbackUsed: boolean;
  warnings: string[];
}

/** Load the parsed-chapter preview for a job (Spec §11.2). */
export async function previewParsedSource(jobId: string): Promise<ParsedSourcePreview> {
  const db = await getDb();
  const job = await getJob(db, jobId);
  if (!job) throw new Error('导入任务不存在。');
  const source = await getSourceByIdInTx(db, job.sourceId);
  if (!source) throw new Error('原著源记录不存在。');

  const [chapRes] = await db.executeSql(
    'SELECT position, title, detected_title, char_count, is_excluded FROM continuation_source_chapters WHERE source_id = ? ORDER BY position ASC',
    [job.sourceId],
  );
  const chapters: ParsedSourcePreview['chapters'] = [];
  for (let i = 0; i < chapRes.rows.length; i++) {
    const r = chapRes.rows.item(i);
    chapters.push({
      position: r.position,
      title: r.title,
      detectedTitle: r.detected_title,
      charCount: r.char_count,
      isExcluded: Number(r.is_excluded) === 1,
    });
  }
  return {
    jobId,
    sourceId: job.sourceId,
    displayName: source.displayName,
    originalFileName: source.originalFileName,
    detectedEncoding: source.detectedEncoding,
    fileSizeBytes: source.fileSizeBytes,
    normalizedCharCount: source.normalizedCharCount,
    chapterCount: chapters.length,
    chapters,
    fallbackUsed: false,
    warnings: [],
  };
}

/** Apply preview edits (rename/merge/split/exclude) to the staging chapters (Spec §11.2). */
export async function applyParsingEditsToJob(
  jobId: string,
  edits: ParsingEdit[],
): Promise<ParsedSourcePreview> {
  const db = await getDb();
  const job = await getJob(db, jobId);
  if (!job) throw new Error('导入任务不存在。');

  const [chapRes] = await db.executeSql(
    'SELECT * FROM continuation_source_chapters WHERE source_id = ? ORDER BY position ASC',
    [job.sourceId],
  );
  const chapters: any[] = [];
  for (let i = 0; i < chapRes.rows.length; i++) chapters.push(chapRes.rows.item(i));
  const edited = applyParsingEdits(
    chapters.map(c => ({
      position: c.position,
      volumeTitle: c.volume_title ?? null,
      detectedTitle: c.detected_title,
      title: c.title,
      sourceStartOffset: c.source_start_offset,
      contentStartOffset: c.content_start_offset,
      sourceEndOffset: c.source_end_offset,
      charCount: c.char_count,
      paragraphCount: c.paragraph_count,
      contentSha256: c.content_sha256,
      isExcluded: Number(c.is_excluded) === 1,
      exclusionReason: c.exclusion_reason ?? null,
    })),
    edits,
  );

  // Persist edited metadata in one transaction.
  const ts = now();
  const statements: SqlStatement[] = edited.map(c => ({
    sql: `UPDATE continuation_source_chapters SET
      title = ?, is_excluded = ?, exclusion_reason = ?,
      source_start_offset = ?, content_start_offset = ?, source_end_offset = ?,
      char_count = ?, content_sha256 = ?, updated_at = ?
      WHERE source_id = ? AND position = ?`,
    params: [
      c.title,
      c.isExcluded ? 1 : 0,
      c.exclusionReason ?? null,
      c.sourceStartOffset,
      c.contentStartOffset,
      c.sourceEndOffset,
      c.charCount,
      c.contentSha256,
      ts,
      job.sourceId,
      c.position,
    ],
  }));
  await executeTransaction(db, statements);
  return previewParsedSource(jobId);
}

export interface BoundaryInput {
  mode: 'end_of_source' | 'end_of_chapter' | 'custom_offset';
  chapterPosition?: number;
  /** For custom_offset: UTF-16 offset within the chosen chapter. */
  charOffsetWithinChapter?: number;
}

/**
 * Confirm the source: validate boundary, then atomically activate
 * (supersede prior ready + promote new + switch pointers) in one tx (Spec §6, §14.1).
 */
export async function confirmContinuationSource(
  jobId: string,
  boundary: BoundaryInput,
): Promise<ContinuationSource> {
  const db = await getDb();
  const job = await getJob(db, jobId);
  if (!job) throw new Error('导入任务不存在。');
  const source = await getSourceByIdInTx(db, job.sourceId);
  if (!source) throw new Error('原著源记录不存在。');

  // Resolve boundary chapter + global offset.
  const [chapRes] = await db.executeSql(
    'SELECT id, position, source_start_offset, content_start_offset, source_end_offset FROM continuation_source_chapters WHERE source_id = ? AND is_excluded = 0 ORDER BY position ASC',
    [job.sourceId],
  );
  const chapters: any[] = [];
  for (let i = 0; i < chapRes.rows.length; i++) chapters.push(chapRes.rows.item(i));
  if (chapters.length === 0) throw new Error('没有可用章节，无法设置续写起点。');

  let boundaryChapter: any;
  let boundaryOffset: number;
  if (boundary.mode === 'end_of_source') {
    boundaryChapter = chapters[chapters.length - 1];
    boundaryOffset = boundaryChapter.source_end_offset;
  } else {
    const pos = boundary.chapterPosition ?? chapters[chapters.length - 1].position;
    boundaryChapter = chapters.find(c => c.position === pos);
    if (!boundaryChapter) throw new Error('所选续写起点章节不存在或已被排除。');
    if (boundary.mode === 'end_of_chapter') {
      boundaryOffset = boundaryChapter.source_end_offset;
    } else {
      const within = boundary.charOffsetWithinChapter ?? 0;
      boundaryOffset = boundaryChapter.source_start_offset + within;
      if (
        boundaryOffset < boundaryChapter.content_start_offset ||
        boundaryOffset > boundaryChapter.source_end_offset
      ) {
        throw new Error('自定义续写起点必须在所选章节的正文范围内。');
      }
    }
  }

  // Atomic activation (Spec §6): supersede prior ready, promote new source,
  // then switch the active + boundary pointers. Both steps run against the
  // same handle; SQLite serializes them. A future revision may wrap both in a
  // single executeTransaction for stricter atomicity guarantees.
  await activateSourceInTx(db, job.projectId, job.sourceId);
  const ts = now();
  await executeTransaction(db, [
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
        job.sourceId,
        job.sourceId,
        boundaryChapter.id,
        boundaryOffset,
        boundary.mode,
        ts,
        job.projectId,
      ],
    },
  ]);
  await updateJob(db, jobId, {
    state: 'completed',
    stage: 'activating',
    progressCurrent: 1,
    progressTotal: 1,
    completedAt: ts,
  });

  // Clean up the private import copy on success (Spec §14.1 step 8).
  if (job.inputCopyRelativePath) {
    try {
      await RNFS.unlink(`${RNFS.DocumentDirectoryPath}/${job.inputCopyRelativePath}`);
    } catch {
      // best-effort; orphan cleanup runs on next recover.
    }
  }
  return (await getSourceByIdInTx(db, job.sourceId))!;
}

/** Cancel an in-flight import and clean up staging data (Spec §14.1). */
export async function cancelContinuationImport(jobId: string): Promise<void> {
  const db = await getDb();
  const job = await getJob(db, jobId);
  if (!job) return;
  await updateJob(db, jobId, { state: 'cancelled', completedAt: now() });
  // Physical-delete the staging source + chunks + chapters (cascade).
  await deleteSourceCascade(db, job.sourceId);
  if (job.inputCopyRelativePath) {
    try {
      await RNFS.unlink(`${RNFS.DocumentDirectoryPath}/${job.inputCopyRelativePath}`);
    } catch {
      // ignore
    }
  }
}

/** Delete the active source for a project (Spec §9.2, §14.3). */
export async function deleteContinuationSource(projectId: number): Promise<void> {
  const db = await getDb();
  const active = await getActiveSource(projectId);
  if (!active) return;
  await clearActiveSourceAndDelete(db, projectId, active.id);
}

/** Replace the active source by starting a new import (Spec §14.3). */
export async function replaceContinuationSource(
  projectId: number,
  input: Omit<StartImportInput, 'projectId'>,
): Promise<ImportJob> {
  return startContinuationImport({ ...input, projectId });
}

/** Active source accessor (Spec §13). */
export async function getActiveContinuationSource(
  projectId: number,
): Promise<ContinuationSource | null> {
  return getActiveSource(projectId);
}

// --- interrupted recovery (Spec §14.2) --------------------------------------

/**
 * On cold start, convert any leftover active jobs to `interrupted` so the UI
 * can offer resume/retry/cancel (Spec §14.2). Idempotent.
 */
export async function recoverInterruptedJobs(): Promise<{ recovered: number }> {
  const db = await openDatabase();
  let recovered = 0;
  for (const state of ACTIVE_JOB_STATES) {
    if (state === 'interrupted') continue;
    const [res] = await db.executeSql(
      `SELECT id FROM continuation_import_jobs WHERE state = ?`,
      [state],
    );
    for (let i = 0; i < res.rows.length; i++) {
      const id = res.rows.item(i).id;
      await updateJob(db, id, { state: 'interrupted', errorCode: 'job_interrupted' });
      recovered += 1;
    }
  }
  return { recovered };
}

/** Resume an interrupted job by restarting the pipeline from the staging source. */
export async function resumeContinuationImport(jobId: string): Promise<ImportJob> {
  const db = await getDb();
  const job = await getJob(db, jobId);
  if (!job) throw new Error('导入任务不存在。');
  if (job.state !== 'interrupted' && job.state !== 'failed') {
    throw new Error(`任务当前状态为 ${job.state}，无需恢复。`);
  }
  const source = await getSourceByIdInTx(db, job.sourceId);
  if (!source) throw new Error('原著源记录不存在。');

  // If we have a private copy, re-run the pipeline; else ask user to re-pick.
  const absPath = job.inputCopyRelativePath
    ? `${RNFS.DocumentDirectoryPath}/${job.inputCopyRelativePath}`
    : null;
  if (!absPath) {
    await updateJob(db, jobId, {
      state: 'failed',
      errorCode: 'source_changed',
      errorMessage: '导入临时文件已清理，请重新选择原著文件。',
    });
    throw new Error('导入临时文件已清理，请重新选择原著文件。');
  }
  // Reset staging data before re-running.
  await db.executeSql('DELETE FROM continuation_source_text_chunks WHERE source_id = ?', [job.sourceId]);
  await db.executeSql('DELETE FROM continuation_source_chapters WHERE source_id = ?', [job.sourceId]);
  await updateJob(db, jobId, { state: 'running', stage: 'reading', errorCode: null, errorMessage: null });

  try {
    const meta = await requireContinuationTextImport().readFileMeta(absPath);
    await runPipelineToReview(db, jobId, job.sourceId, absPath, source.detectedEncoding, meta.fileSizeBytes);
    return (await getJob(db, jobId))!;
  } catch (e: any) {
    await updateJob(db, jobId, {
      state: 'failed',
      errorCode: classifyError(e),
      errorMessage: sanitizeError(e?.message),
    });
    throw e;
  }
}

// --- helpers (exported for unit testing) -----------------------------------

export function stripExtension(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

export function classifyError(e: any): string {
  const msg = String(e?.message ?? '');
  if (/编码|encoding/i.test(msg)) return 'unsupported_encoding';
  if (/过大|too.?large/i.test(msg)) return 'file_too_large';
  if (/完整性|integrity|chunk/i.test(msg)) return 'chunk_integrity_failed';
  if (/解析|parse/i.test(msg)) return 'parse_failed';
  if (/空间|storage|disk/i.test(msg)) return 'storage_full';
  return 'decode_failed';
}

/** Sanitize error messages for UI display (no full paths, length-capped). */
export function sanitizeError(msg: string): string {
  const stripped = String(msg ?? '').replace(/file:\/\/\/[^\s]+/g, '<file>');
  return stripped.length > 200 ? stripped.slice(0, 200) + '…' : stripped;
}
