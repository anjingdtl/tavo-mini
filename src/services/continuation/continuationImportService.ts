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
import { PARSER_VERSION, createStreamingChapterParser, type ParsedChapter } from './continuationParser';
import { NORMALIZATION_VERSION, createStreamingNormalizer } from './continuationNormalizer';
import { applyParsingEdits, type ParsingEdit } from './continuationEditLog';
import { Sha256Stream, sha256Hex } from './hashUtils';
import {
  asSourcePosition,
  asUtf16Offset,
  buildActivateSourceBoundaryStatements,
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

/**
 * Hard ceiling on imported TXT size (mirrors the native MAX_FILE_BYTES).
 * Enforced in readFileMeta (native) AND here in JS so a too-large file is
 * rejected before being copied into the private import dir. Above this, the
 * decode/normalize/parse pipeline — even streaming — risks device-specific
 * storage/time limits.
 */
export const MAX_IMPORT_FILE_BYTES = 200 * 1024 * 1024;

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

/**
 * Return the single active import job for a project, if any (Spec §14.2).
 *
 * "Active" matches the partial unique index `idx_continuation_import_one_active`
 * (states queued/running/paused/awaiting_review/interrupted) — at most one such
 * row may exist per project. Used by the import UI to surface a resumable /
 * cancellable job and by startContinuationImport to avoid colliding with the
 * unique index.
 */
export async function getActiveImportJob(
  projectId: number,
): Promise<ImportJob | null> {
  const db = await getDb();
  const [res] = await db.executeSql(
    `SELECT * FROM continuation_import_jobs
     WHERE project_id = ? AND state IN ('queued','running','paused','awaiting_review','interrupted')
     ORDER BY started_at DESC LIMIT 1`,
    [projectId],
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

  // Guard against the partial unique index idx_continuation_import_one_active:
  // if a previous import on this project was interrupted (e.g. the app was
  // killed mid-decode) and never resumed/cancelled, its job still occupies the
  // index and a new insertJob would throw UNIQUE constraint failed. Clear any
  // such leftover interrupted job (and its staging source) before proceeding.
  const leftover = await getActiveImportJob(input.projectId);
  if (leftover && leftover.state === 'interrupted') {
    await cancelContinuationImport(leftover.id);
  }

  const mod = requireContinuationTextImport();
  const meta = await mod.readFileMeta(input.localPath);
  // Reject oversized files BEFORE copying into the private import dir (Spec §16,
  // native MAX_FILE_BYTES). The native readFileMeta already marks these
  // canRead=false + errorCode, but we double-check the byte count in JS too so
  // the friendly error fires regardless of the native contract.
  if (meta.errorCode === 'file_too_large' || meta.fileSizeBytes > MAX_IMPORT_FILE_BYTES) {
    const mb = (MAX_IMPORT_FILE_BYTES / (1024 * 1024)).toFixed(0);
    throw new Error(`文件过大（上限 ${mb} MB），请选择更小的原著文件或按章节拆分后导入。`);
  }
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

/** Convert a finished ParsedChapter to a chapter row input. */
function parsedChapterToInput(c: ParsedChapter): InsertChapterInput {
  return {
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
  };
}

/**
 * Decode → normalize → persist chunks → parse → persist chapters → validate.
 *
 * Single-pass streaming variant: each 192 KiB decoded byte-block is normalized,
 * hashed, sliced into text chunks, and fed to the streaming chapter parser
 * immediately, so the full novel never resides in JS memory at once. This
 * replaces the original load-everything-then-process pipeline that OOMed on
 * multi-MB novels. Output (chunks/chapters/hashes) is byte-for-byte identical
 * to the original pipeline — the streaming normalizer/parser are equivalence-
 * tested against the one-shot variants.
 */
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
  // Chunk the normalized text into ~192 KiB UTF-8 bands (Spec §9.3). 3 bytes
  // per CJK char is the rough average used by the original pipeline.
  const CHUNK_CHAR_TARGET = Math.floor((192 * 1024) / 3);

  const rawHasher = new Sha256Stream(); // SHA-256 over the raw decoded text
  const fallbackHasher = new Sha256Stream(); // SHA-256 over the full normalized text (fallback chapter)
  const normalizer = createStreamingNormalizer();
  const parser = createStreamingChapterParser();

  let byteCursor = 0;
  let normalizedCharCursor = 0; // running UTF-16 length of normalized output
  let chunkBand = ''; // current normalized-text band being filled toward CHUNK_CHAR_TARGET
  let chunkBandStart = 0; // UTF-16 offset where chunkBand begins
  let chunkIndex = 0;
  let chapterCount = 0;
  // Pending partial line carried across decoded chunks (the decoder may split a
  // line at any byte boundary; chapters are detected per complete line).
  let pendingLine = '';
  let pendingLineStartOffset = 0;
  // Whole-text paragraph count over the normalized output (used only if the
  // parser falls back to a single whole-text chapter). Counted online as each
  // complete normalized line arrives.
  let globalParagraphCount = 0;

  const progressTotal = Math.max(1, Math.ceil(fileSizeBytes / CHUNK_BYTES));
  await updateJob(db, jobId, { stage: 'decoding', progressTotal });

  const flushChapterBatch = async (chapters: ParsedChapter[]) => {
    if (chapters.length === 0) return;
    await insertChapters(
      db,
      sourceId,
      chapters.map(parsedChapterToInput),
    );
    chapterCount += chapters.length;
  };

  while (byteCursor < fileSizeBytes) {
    const decoded = await mod.decodeChunk(absPath, encoding, byteCursor, CHUNK_BYTES, null);
    if (decoded.bytesConsumed === 0 && !decoded.atEof) {
      throw new Error('解码无进展，疑似编码不匹配，请确认文件编码。');
    }
    // Raw hash is over the decoded text before normalization (matches the
    // original raw_sha256 = sha256Hex(rawDecoded)).
    rawHasher.updateString(decoded.text);

    // Normalize this byte-block incrementally; push() returns the normalized
    // text produced from just this block.
    const normalizedBlock = normalizer.push(decoded.text);
    fallbackHasher.updateString(normalizedBlock);

    // Split the normalized block into complete lines and feed the streaming
    // chapter parser. A trailing partial line (no '\n') is held until the next
    // block completes it. Line offsets are UTF-16 offsets into the normalized
    // text, tracked via normalizedCharCursor.
    let blockRest = normalizedBlock;
    while (true) {
      const nlIdx = blockRest.indexOf('\n');
      if (nlIdx < 0) {
        // No more complete lines in this block; carry the remainder.
        pendingLine += blockRest;
        break;
      }
      const completeLine = pendingLine + blockRest.slice(0, nlIdx);
      const flushed = parser.pushLine(completeLine, pendingLineStartOffset);
      await flushChapterBatch(flushed);
      if (completeLine.trim().length > 0) globalParagraphCount += 1;
      // Advance past the line content + the '\n'.
      pendingLineStartOffset = pendingLineStartOffset + completeLine.length + 1;
      pendingLine = '';
      blockRest = blockRest.slice(nlIdx + 1);
    }

    // Accumulate the normalized block into chunk bands. When a band reaches
    // CHUNK_CHAR_TARGET, flush it as a text chunk row.
    chunkBand += normalizedBlock;
    while (chunkBand.length >= CHUNK_CHAR_TARGET) {
      const slice = chunkBand.slice(0, CHUNK_CHAR_TARGET);
      const start = chunkBandStart;
      const end = start + slice.length;
      await insertChunks(db, sourceId, [
        {
          chunkIndex,
          charStartOffset: asUtf16Offset(start),
          charEndOffset: asUtf16Offset(end),
          content: slice,
          contentSha256: sha256Hex(slice),
        },
      ]);
      chunkIndex += 1;
      chunkBandStart = end;
      chunkBand = chunkBand.slice(CHUNK_CHAR_TARGET);
    }
    normalizedCharCursor += normalizedBlock.length;

    byteCursor = decoded.nextByteOffset;
    await updateJob(db, jobId, {
      progressCurrent: Math.min(progressTotal, Math.ceil(byteCursor / CHUNK_BYTES)),
      // checkpoint carries only cursor + small state, never full text (§9.6).
      checkpointJson: JSON.stringify({
        byteCursor,
        normalizedCharCursor,
        chunkIndex,
        chapterCount,
      }),
    });
    if (decoded.atEof) break;
  }

  // Flush the trailing partial line (if any) so the parser sees the last line.
  if (pendingLine.length > 0) {
    const flushed = parser.pushLine(pendingLine, pendingLineStartOffset);
    await flushChapterBatch(flushed);
    pendingLine = '';
  }

  // Flush the final partial chunk band.
  await updateJob(db, jobId, { stage: 'persisting' });
  if (chunkBand.length > 0) {
    const start = chunkBandStart;
    const end = start + chunkBand.length;
    await insertChunks(db, sourceId, [
      {
        chunkIndex,
        charStartOffset: asUtf16Offset(start),
        charEndOffset: asUtf16Offset(end),
        content: chunkBand,
        contentSha256: sha256Hex(chunkBand),
      },
    ]);
    chunkIndex += 1;
    chunkBand = '';
  }

  // Finalize the normalizer (aggregate normalized char/byte counts + sha) and
  // the parser (close trailing chapter / build fallback). The fallback needs
  // the whole-text hash + paragraph count, which the streaming normalizer's
  // sha and an online paragraph count provide.
  await updateJob(db, jobId, { stage: 'detecting_chapters' });
  const normMeta = normalizer.finalize();
  const parsedFinal = parser.finalize({
    fallbackSha256: fallbackHasher.digest(),
    fallbackParagraphCount: globalParagraphCount,
    totalCharCount: normMeta.normalizedCharCount,
  });
  await flushChapterBatch(parsedFinal.chapters);

  // --- validate chunk contiguity (DB-side, unchanged) ---
  await updateJob(db, jobId, { stage: 'validating' });
  const contiguity = await validateChunkContiguity(db, sourceId, normMeta.normalizedCharCount);
  if (!contiguity.ok) {
    throw new Error(`分块完整性校验失败：${contiguity.gap ?? '未知'}`);
  }

  // --- finalize source metadata + job ---
  const rawSha = rawHasher.digest();
  await db.executeSql(
    `UPDATE continuation_sources SET
      raw_sha256 = ?, normalized_sha256 = ?, normalized_char_count = ?,
      normalized_byte_count = ?, chapter_count = ?, detected_encoding = ?,
      status = 'needs_review', updated_at = ?
      WHERE id = ?`,
    [
      rawSha,
      normMeta.normalizedSha256,
      normMeta.normalizedCharCount,
      normMeta.normalizedByteCount,
      chapterCount,
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
 * Confirm the source: validate boundary, then atomically activate in ONE
 * transaction (Spec §6, §14.1, fix-plan §6.2): supersede prior ready, promote
 * the new source, switch the active+boundary pointers, AND mark in-flight
 * continuation runs `outdated` so stale context is never adopted against the
 * new boundary. Source status and the settings pointer can never diverge.
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

  // Single atomic transaction (fix-plan §6.2): source activation + settings
  // pointer switch + run invalidation commit or roll back together.
  const ts = now();
  const statements = buildActivateSourceBoundaryStatements({
    projectId: job.projectId,
    newSourceId: job.sourceId,
    boundaryChapterId: boundaryChapter.id,
    boundaryGlobalOffset: boundaryOffset,
    boundaryMode: boundary.mode,
    ts,
  });
  await executeTransaction(db, statements, { faultDomain: 'continuation' });

  await updateJob(db, jobId, {
    state: 'completed',
    stage: 'activating',
    progressCurrent: 1,
    progressTotal: 1,
    completedAt: ts,
  });

  // Clean up the private import copy on success (Spec §14.1 step 8). Best-effort
  // only, never inside the transaction.
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
