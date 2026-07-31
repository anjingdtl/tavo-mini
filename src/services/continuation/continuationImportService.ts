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
import { renumberContinuationChapterTitles } from './chapterNumbering/continuationChapterNumbering';
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

/**
 * One file in a multi-file import batch. The caller (picker) copies each
 * selected file into a private cache path and passes that path here; the
 * service re-copies each one into a per-job directory for resume durability.
 */
export interface ImportInputFile {
  /** App-private absolute path of the file copy (caller copies via picker). */
  localPath: string;
  originalFileName: string;
  /** User-confirmed encoding when detection was low-confidence; else auto-detect. */
  encodingOverride?: string;
}

export interface StartImportInput {
  projectId: number;
  /** One or more files to import. Single-file callers pass a 1-element array. */
  files: ImportInputFile[];
}

/**
 * Begin an import: copy file to private dir, create staging source + job,
 * then run the decode/normalize/parse pipeline to awaiting_review (Spec §14.1).
 *
 * Multi-file variant: each input file is copied into a per-job directory
 * `${importDir}/${jobId}/` so resume can re-read all original files. The
 * `inputCopyRelativePath` stored on the job points at that directory (relative
 * to DocumentDirectoryPath). `file_index` on chunks/chapters marks provenance.
 */
export async function startContinuationImport(
  input: StartImportInput,
): Promise<ImportJob> {
  const db = await getDb();
  await ensureSettingsRow(db, input.projectId);

  if (input.files.length === 0) {
    throw new Error('未选择任何文件。');
  }

  // Guard against the partial unique index idx_continuation_import_one_active:
  // if a previous import on this project was interrupted (e.g. the app was
  // killed mid-decode) and never resumed/cancelled, its job still occupies the
  // index and a new insertJob would throw UNIQUE constraint failed. Clear any
  // such leftover interrupted job (and its staging source) before proceeding.
  const leftover = await getActiveImportJob(input.projectId);
  // 清理所有活跃状态的残留 job（包括 awaiting_review），而不是只清理
  // interrupted。原逻辑只清 interrupted，awaiting_review 残留会撞唯一索引
  // 导致用户再次导入失败，且 UI 无取消入口，只能清数据重装。
  if (leftover && ACTIVE_JOB_STATES.includes(leftover.state)) {
    await cancelContinuationImport(leftover.id);
  }

  const mod = requireContinuationTextImport();

  // Pre-flight each file: read meta, detect encoding, sum total size.
  // Per-file size + cumulative size both checked against MAX_IMPORT_FILE_BYTES.
  const fileMetas: PipelineFileMeta[] = [];
  let totalSize = 0;
  for (let i = 0; i < input.files.length; i++) {
    const f = input.files[i];
    const meta = await mod.readFileMeta(f.localPath);
    if (meta.errorCode === 'file_too_large' || meta.fileSizeBytes > MAX_IMPORT_FILE_BYTES) {
      const mb = (MAX_IMPORT_FILE_BYTES / (1024 * 1024)).toFixed(0);
      throw new Error(`文件 ${f.originalFileName} 过大（上限 ${mb} MB），请选择更小的原著文件或按章节拆分后导入。`);
    }
    if (totalSize + meta.fileSizeBytes > MAX_IMPORT_FILE_BYTES) {
      const mb = (MAX_IMPORT_FILE_BYTES / (1024 * 1024)).toFixed(0);
      throw new Error(`原著总大小超过 ${mb} MB 限制，请减少文件数量或按章节拆分后导入。`);
    }
    if (!meta.canRead) {
      throw new Error(`无法读取文件 ${f.originalFileName}，请重新选择。`);
    }
    const detected = await mod.detectEncoding(f.localPath);
    const encoding = f.encodingOverride ?? detected.encoding;
    fileMetas.push({
      localPath: f.localPath,
      originalFileName: f.originalFileName,
      encoding,
      fileSizeBytes: meta.fileSizeBytes,
    });
    totalSize += meta.fileSizeBytes;
  }

  // Copy each input file into our private per-job import directory so resume
  // can re-read the originals even after the picker's cache is cleared.
  // Files are named `${fileIndex}_${sanitizedOriginal}` to preserve ordering
  // and human-readability while staying filesystem-safe.
  const importDir = `${RNFS.DocumentDirectoryPath}/continuation-imports`;
  await RNFS.mkdir(importDir);
  const jobId = uuidv4();
  const jobDirName = jobId;
  const jobDirAbs = `${importDir}/${jobDirName}`;
  await RNFS.mkdir(jobDirAbs);
  const inputCopyRelativePath = `continuation-imports/${jobDirName}`;
  try {
    for (let i = 0; i < fileMetas.length; i++) {
      const fm = fileMetas[i];
      const safeName = sanitizeFileNameForPath(fm.originalFileName);
      const destName = `${i}_${safeName}`;
      await RNFS.copyFile(fm.localPath, `${jobDirAbs}/${destName}`);
      // localPath is updated to the private copy so runPipelineToReview reads
      // the durable copy (the picker's cache may vanish mid-import).
      fileMetas[i] = { ...fm, localPath: `${jobDirAbs}/${destName}` };
    }
  } catch (copyErr) {
    // H6-Import 修复：copyFile 失败（如源文件被删/磁盘满）会留下半空 jobDir
    // 和 staging source，下次 resume 又会撞到。清理 jobDir + source cascade。
    await RNFS.unlink(jobDirAbs).catch(() => {
      // best-effort
    });
    throw copyErr;
  }

  // Build source_files_json metadata for provenance queries (UI/audit).
  const sourceFilesMeta = fileMetas.map((fm, idx) => ({
    fileIndex: idx,
    originalFileName: fm.originalFileName,
    fileSizeBytes: fm.fileSizeBytes,
    detectedEncoding: fm.encoding,
  }));
  const isMultiFile = input.files.length > 1;

  // Create staging source + job. H1 修复：insertSource 成功但 insertJob
  // 失败（如 awaiting_review 残留撞唯一索引）会留下孤儿 staging source，
  // 永远不会被任何清理路径触及。包 try/catch，insertJob 失败时回滚 source。
  const sourceVersion = await nextSourceVersionInTx(db, input.projectId);
  const displayName = isMultiFile
    ? `${stripExtension(fileMetas[0].originalFileName)} 等 ${fileMetas.length} 个文件`
    : stripExtension(fileMetas[0].originalFileName);
  const sourceId = await insertSource(db, {
    projectId: input.projectId,
    version: sourceVersion,
    status: 'staging',
    displayName,
    originalFileName: fileMetas[0].originalFileName,
    detectedEncoding: fileMetas[0].encoding,
    fileSizeBytes: totalSize,
    rawSha256: 'pending', // filled after full read
    normalizedSha256: 'pending',
    normalizedCharCount: 0,
    normalizedByteCount: 0,
    chapterCount: 0,
    parserVersion: PARSER_VERSION,
    normalizationVersion: NORMALIZATION_VERSION,
    sourceFilesJson: JSON.stringify(sourceFilesMeta),
    isMultiFile,
    fileCount: fileMetas.length,
  });
  try {
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
  } catch (jobErr) {
    // 回滚孤儿 source，避免 staging source 堆积污染 version 序列。
    await deleteSourceCascade(db, sourceId).catch(() => {
      // best-effort；原错误更重要
    });
    throw jobErr;
  }

  try {
    await runPipelineToReview(db, jobId, sourceId, fileMetas, totalSize);
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

/**
 * A file ready for the streaming pipeline: an app-private absolute path,
 * the encoding to decode with, byte size, and original name for provenance.
 *
 * `localPath` points at the durable private copy inside the per-job import
 * directory, NOT the picker's cache uri (which may vanish mid-import).
 */
export interface PipelineFileMeta {
  localPath: string;
  originalFileName: string;
  encoding: string;
  fileSizeBytes: number;
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
    // Task 2 占位：Task 4 会改成动态 fileIndex
    fileIndex: 0,
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
 *
 * Multi-file streaming variant: each file is decoded independently with its
 * own encoding, but the normalizer/parser/hashers are shared across files so
 * the merged output is byte-for-byte identical to a single-file import of the
 * concatenated text. `file_index` on chunks/chapters marks provenance. Chunk
 * bands may span file boundaries (fileIndex = the file that completed the
 * band); chapter boundaries are flushed at each file end so partial lines
 * never merge across files.
 */
async function runPipelineToReview(
  db: any,
  jobId: string,
  sourceId: number,
  files: PipelineFileMeta[],
  totalSizeBytes: number,
): Promise<void> {
  if (files.length === 0) {
    throw new Error('未选择任何文件。');
  }
  const mod = requireContinuationTextImport();
  const CHUNK_BYTES = 192 * 1024;
  // Chunk the normalized text into ~192 KiB UTF-8 bands (Spec §9.3). 3 bytes
  // per CJK char is the rough average used by the original pipeline.
  const CHUNK_CHAR_TARGET = Math.floor((192 * 1024) / 3);

  // Cross-file shared streaming state. These MUST outlive the per-file loop so
  // the merged output is identical to a single-file import of the concat.
  const rawHasher = new Sha256Stream(); // SHA-256 over the raw decoded text
  const fallbackHasher = new Sha256Stream(); // SHA-256 over the full normalized text (fallback chapter)
  const normalizer = createStreamingNormalizer();
  const parser = createStreamingChapterParser();

  let normalizedCharCursor = 0; // running UTF-16 length of normalized output (cross-file)
  let chunkBand = ''; // current normalized-text band being filled toward CHUNK_CHAR_TARGET (cross-file)
  let chunkBandStart = 0; // UTF-16 offset where chunkBand begins (cross-file)
  let chunkIndex = 0; // global chunk index (cross-file)
  let chapterCount = 0; // global chapter count (cross-file)
  // Pending partial line carried across decoded chunks within a single file.
  // Flushed at each file's end so partial lines never merge across files.
  let pendingLine = '';
  let pendingLineStartOffset = 0;
  // Whole-text paragraph count over the normalized output (used only if the
  // parser falls back to a single whole-text chapter). Counted online as each
  // complete normalized line arrives.
  let globalParagraphCount = 0;

  const progressTotal = Math.max(1, Math.ceil(totalSizeBytes / CHUNK_BYTES));
  await updateJob(db, jobId, { stage: 'decoding', progressTotal });

  // flushChapterBatch takes a fileIndex so every chapter row records which
  // file it originated from. parsedChapterToInput returns fileIndex: 0 as a
  // placeholder; the spread here overrides it with the correct value.
  const flushChapterBatch = async (chapters: ParsedChapter[], fileIndex: number) => {
    if (chapters.length === 0) return;
    await insertChapters(
      db,
      sourceId,
      chapters.map(c => ({ ...parsedChapterToInput(c), fileIndex })),
    );
    chapterCount += chapters.length;
  };

  // Per-file byte offsets (for progress + checkpoint). Reset to 0 each file.
  let byteCursor = 0;

  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const file = files[fileIndex];
    byteCursor = 0;

    while (byteCursor < file.fileSizeBytes) {
      const decoded = await mod.decodeChunk(
        file.localPath,
        file.encoding,
        byteCursor,
        CHUNK_BYTES,
        null,
      );
      if (decoded.bytesConsumed === 0 && !decoded.atEof) {
        throw new Error(
          `解码 ${file.originalFileName} 无进展，疑似编码不匹配，请确认文件编码。`,
        );
      }
      // Raw hash is over the decoded text before normalization (matches the
      // original raw_sha256 = sha256Hex(rawDecoded)). Cross-file accumulation.
      rawHasher.updateString(decoded.text);

      // Normalize this byte-block incrementally; push() returns the normalized
      // text produced from just this block.
      const normalizedBlock = normalizer.push(decoded.text);
      fallbackHasher.updateString(normalizedBlock);

      // Split the normalized block into complete lines and feed the streaming
      // chapter parser. A trailing partial line (no '\n') is held until the next
      // block completes it. Line offsets are UTF-16 offsets into the normalized
      // text, tracked via pendingLineStartOffset (cross-file accumulation).
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
        await flushChapterBatch(flushed, fileIndex);
        if (completeLine.trim().length > 0) globalParagraphCount += 1;
        // Advance past the line content + the '\n'.
        pendingLineStartOffset = pendingLineStartOffset + completeLine.length + 1;
        pendingLine = '';
        blockRest = blockRest.slice(nlIdx + 1);
      }

      // Accumulate the normalized block into chunk bands. When a band reaches
      // CHUNK_CHAR_TARGET, flush it as a text chunk row. The band may span
      // file boundaries; fileIndex here marks the file that completed the band
      // (i.e. the file currently being decoded), which is acceptable since
      // file_index is a provenance hint, not an offset participant (Spec §9.3).
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
            fileIndex,
          },
        ]);
        chunkIndex += 1;
        chunkBandStart = end;
        chunkBand = chunkBand.slice(CHUNK_CHAR_TARGET);
      }
      normalizedCharCursor += normalizedBlock.length;

      byteCursor = decoded.nextByteOffset;
      // Global processed bytes across all files (for progress + checkpoint).
      const globalProcessedBytes =
        files
          .slice(0, fileIndex)
          .reduce((s, f) => s + f.fileSizeBytes, 0) + byteCursor;
      await updateJob(db, jobId, {
        progressCurrent: Math.min(
          progressTotal,
          Math.ceil(globalProcessedBytes / CHUNK_BYTES),
        ),
        // checkpoint carries only cursor + small state, never full text (§9.6).
        checkpointJson: JSON.stringify({
          fileIndex,
          byteCursor,
          normalizedCharCursor,
          chunkIndex,
          chapterCount,
        }),
      });
      if (decoded.atEof) break;
    }

    // Flush the trailing partial line at the end of each file so partial lines
    // never merge across file boundaries (a file without a trailing newline
    // would otherwise concatenate with the next file's first line). The offset
    // advances by the pending line length only (no +1, because there is no
    // '\n' at the boundary); this keeps pendingLineStartOffset in sync with
    // normalizedCharCursor so the next file's first line starts at the right
    // UTF-16 offset.
    if (pendingLine.length > 0) {
      const flushed = parser.pushLine(pendingLine, pendingLineStartOffset);
      await flushChapterBatch(flushed, fileIndex);
      pendingLineStartOffset += pendingLine.length;
      pendingLine = '';
    }
  }

  // Flush the final partial chunk band (fileIndex = last file).
  await updateJob(db, jobId, { stage: 'persisting' });
  const lastFileIndex = files.length - 1;
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
        fileIndex: lastFileIndex,
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
  await flushChapterBatch(parsedFinal.chapters, lastFileIndex);

  // --- validate chunk contiguity (DB-side, unchanged) ---
  await updateJob(db, jobId, { stage: 'validating' });
  const contiguity = await validateChunkContiguity(db, sourceId, normMeta.normalizedCharCount);
  if (!contiguity.ok) {
    throw new Error(`分块完整性校验失败：${contiguity.gap ?? '未知'}`);
  }

  // --- finalize source metadata + job ---
  // Multi-file: detectedEncoding records the primary (first) file's encoding
  // for display; per-file encodings live in source_files_json.
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
      files[0].encoding,
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
    jobId,
  });
  await executeTransaction(db, statements, { faultDomain: 'continuation' });

  // Source activation renumbers auto-titled continuation chapters to continue
  // from the new boundary (Spec §11.5, §12). User-custom titles are preserved.
  // Best-effort: the activation transaction is already committed.
  try {
    const { renumberContinuationChapterTitles } = await import(
      './chapterNumbering/continuationChapterNumbering'
    );
    await renumberContinuationChapterTitles(job.projectId);
  } catch {
    // Non-fatal: titles re-sync on next load.
  }

  // Clean up the private import copy on success (Spec §14.1 step 8). Best-effort
  // only, never inside the transaction.
  if (job.inputCopyRelativePath) {
    await cleanupImportPath(job.inputCopyRelativePath);
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
    await cleanupImportPath(job.inputCopyRelativePath);
  }
}

/** Result of deleting the active source (Spec §9.2, §14.3). */
export interface DeleteContinuationSourceResult {
  /** True when an active source existed and was removed. */
  deleted: boolean;
  /** Count of user continuation chapters left in `chapters` (never deleted). */
  preservedChapterCount: number;
  /** In-flight generation runs marked outdated (unadopted body can no longer be adopted). */
  outdatedRunCount: number;
}

/** Pre-delete stats for the confirm dialog (does not mutate). */
export async function previewDeleteContinuationSource(
  projectId: number,
): Promise<{ preservedChapterCount: number; outdatedRunCount: number }> {
  const db = await getDb();
  const [chapterCountRes] = await db.executeSql(
    'SELECT COUNT(*) AS c FROM chapters WHERE project_id = ?',
    [projectId],
  );
  const [runCountRes] = await db.executeSql(
    `SELECT COUNT(*) AS c FROM continuation_generation_runs
     WHERE project_id = ? AND state IN ('queued', 'running', 'awaiting_user', 'interrupted')`,
    [projectId],
  );
  return {
    preservedChapterCount: Number(chapterCountRes.rows.item(0).c ?? 0),
    outdatedRunCount: Number(runCountRes.rows.item(0).c ?? 0),
  };
}

/**
 * Delete the active source for a project (Spec §9.2, §14.3).
 *
 * Removes original-work text/chapters/Canon/Style and clears the boundary.
 * User continuation chapters in the project `chapters` table are never deleted
 * or rewritten except for a best-effort freeze of auto titles so display
 * numbers do not collapse to position+1 after the boundary disappears.
 */
export async function deleteContinuationSource(
  projectId: number,
): Promise<DeleteContinuationSourceResult> {
  const db = await getDb();
  const [chapterCountRes] = await db.executeSql(
    'SELECT COUNT(*) AS c FROM chapters WHERE project_id = ?',
    [projectId],
  );
  const preservedChapterCount = Number(chapterCountRes.rows.item(0).c ?? 0);

  const active = await getActiveSource(projectId);
  if (!active) {
    return { deleted: false, preservedChapterCount, outdatedRunCount: 0 };
  }

  const [runCountRes] = await db.executeSql(
    `SELECT COUNT(*) AS c FROM continuation_generation_runs
     WHERE project_id = ? AND state IN ('queued', 'running', 'awaiting_user', 'interrupted')`,
    [projectId],
  );
  const outdatedRunCount = Number(runCountRes.rows.item(0).c ?? 0);

  // Collect private import copies before the source (and its jobs) CASCADE away.
  const [jobRes] = await db.executeSql(
    `SELECT input_copy_relative_path FROM continuation_import_jobs
     WHERE project_id = ? AND source_id = ? AND input_copy_relative_path IS NOT NULL`,
    [projectId, active.id],
  );
  const privateCopies: string[] = [];
  for (let i = 0; i < jobRes.rows.length; i++) {
    const rel = jobRes.rows.item(i).input_copy_relative_path;
    if (rel) privateCopies.push(String(rel));
  }

  // Freeze auto titles against the current boundary so after deletion the
  // visible numbers stay as 第 N 章 rather than collapsing to position+1.
  try {
    await renumberContinuationChapterTitles(projectId);
  } catch {
    // Non-fatal: titles re-sync on next boundary activation.
  }

  await clearActiveSourceAndDelete(db, projectId, active.id);

  // Best-effort private file cleanup (Spec §16) — outside the DB transaction.
  for (const rel of privateCopies) {
    await cleanupImportPath(rel);
  }

  // Post-condition guard: user chapters must still be present (Spec §14.3).
  const [afterRes] = await db.executeSql(
    'SELECT COUNT(*) AS c FROM chapters WHERE project_id = ?',
    [projectId],
  );
  const afterCount = Number(afterRes.rows.item(0).c ?? 0);
  if (afterCount !== preservedChapterCount) {
    throw new Error(
      `删除原著后续写章节数量异常（期望 ${preservedChapterCount}，实际 ${afterCount}）。请从备份中心恢复，并联系支持。`,
    );
  }

  return {
    deleted: true,
    preservedChapterCount: afterCount,
    outdatedRunCount,
  };
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

  // The per-job import directory holds the durable copies of every input
  // file (named `${fileIndex}_${sanitizedOriginal}`). If the directory is
  // missing, the user must re-pick the files. Read the directory, sort by
  // fileIndex, and rebuild the PipelineFileMeta[] for runPipelineToReview.
  // Per-file encoding is read from source_files_json when available; if not
  // (older single-file imports), all files fall back to source.detectedEncoding.
  const jobDirAbs = job.inputCopyRelativePath
    ? `${RNFS.DocumentDirectoryPath}/${job.inputCopyRelativePath}`
    : null;
  if (!jobDirAbs) {
    await updateJob(db, jobId, {
      state: 'failed',
      errorCode: 'source_changed',
      errorMessage: '导入临时文件已清理，请重新选择原著文件。',
    });
    throw new Error('导入临时文件已清理，请重新选择原著文件。');
  }

  // Pull source_files_json from the DB row (Task 1 added the column but the
  // TS type may not surface it; read the row directly so resume works even
  // when the source was created before the type update).
  const [srcRow] = await db.executeSql(
    'SELECT source_files_json FROM continuation_sources WHERE id = ?',
    [job.sourceId],
  );
  const sourceFilesJsonRaw =
    srcRow.rows.length > 0 ? srcRow.rows.item(0).source_files_json : null;
  let sourceFilesMeta: Array<{
    fileIndex: number;
    originalFileName: string;
    fileSizeBytes: number;
    detectedEncoding: string;
  }> = [];
  if (sourceFilesJsonRaw) {
    try {
      sourceFilesMeta = JSON.parse(sourceFilesJsonRaw);
    } catch {
      sourceFilesMeta = [];
    }
  }

  // Read the directory, filter to files matching `${i}_` prefix, sort by i.
  let dirItems: { name: string; path: string; size: number }[];
  try {
    const items = await RNFS.readDir(jobDirAbs);
    dirItems = items
      .filter(it => it.isFile())
      .map(it => ({ name: it.name, path: it.path, size: Number(it.size ?? 0) }));
  } catch {
    await updateJob(db, jobId, {
      state: 'failed',
      errorCode: 'source_changed',
      errorMessage: '导入临时文件目录已损坏，请重新选择原著文件。',
    });
    throw new Error('导入临时文件目录已损坏，请重新选择原著文件。');
  }

  // Sort by the leading fileIndex prefix; entries without a numeric prefix
  // (defensive: stray files) sort to the end in lexicographic order.
  const withSortKey = dirItems.map(it => {
    const m = it.name.match(/^(\d+)_/);
    return { it, key: m ? Number(m[1]) : Number.MAX_SAFE_INTEGER };
  });
  withSortKey.sort((a, b) => a.key - b.key || a.it.name.localeCompare(b.it.name));
  const sortedItems = withSortKey.map(x => x.it);

  if (sortedItems.length === 0) {
    await updateJob(db, jobId, {
      state: 'failed',
      errorCode: 'source_changed',
      errorMessage: '导入临时文件目录为空，请重新选择原著文件。',
    });
    throw new Error('导入临时文件目录为空，请重新选择原著文件。');
  }

  // Build PipelineFileMeta[]: per-file encoding from source_files_json if
  // present, else fall back to source.detectedEncoding. Original file name
  // is read from source_files_json if present; else from the file's own name
  // with the `${i}_` prefix stripped.
  const files: PipelineFileMeta[] = sortedItems.map((it, idx) => {
    const meta = sourceFilesMeta[idx];
    const originalFileName =
      meta?.originalFileName ?? it.name.replace(/^\d+_/, '');
    const encoding = meta?.detectedEncoding ?? source.detectedEncoding;
    return {
      localPath: it.path,
      originalFileName,
      encoding,
      fileSizeBytes: it.size,
    };
  });

  const totalSize = files.reduce((s, f) => s + f.fileSizeBytes, 0);

  // Reset staging data before re-running.
  // H8-Import 修复：原两条 DELETE 非事务，中间崩溃会留下 chunks 已删但
  // chapters 还在的不一致状态，导致 parser 在 finalized_chapters 阶段
  // contiguity 校验失败。包 executeTransaction 保证原子性。
  await executeTransaction(db, [
    {
      sql: 'DELETE FROM continuation_source_text_chunks WHERE source_id = ?',
      params: [job.sourceId],
    },
    {
      sql: 'DELETE FROM continuation_source_chapters WHERE source_id = ?',
      params: [job.sourceId],
    },
  ]);

  // H1-Import-resume 修复：原 `updateJob(state='running')` 是无条件 UPDATE，
  // 两次并发 resume（用户切屏回来再点恢复 / useFocusEffect 重新触发）都能
  // 通过 1048 行的 state 检查，然后两条流同时从 chunkIndex=0 跑 insertChunks
  // 撞 UNIQUE(source_id, chunk_index)，最终 job 状态被两条流互相覆盖。
  // 改为条件 UPDATE + rowsAffected 断言：只有从 interrupted/failed 抢占成功
  // 才能继续，第二条并发调用直接抛错退出，不会污染 staging 数据。
  const ts = now();
  const [claimRes] = await db.executeSql(
    `UPDATE continuation_import_jobs
       SET state = 'running', stage = 'reading',
           error_code = NULL, error_message = NULL, updated_at = ?
     WHERE id = ? AND state IN ('interrupted', 'failed')`,
    [ts, jobId],
  );
  if (claimRes.rowsAffected !== 1) {
    throw new Error('任务已被另一处恢复抢占，请刷新列表后重试。');
  }

  try {
    await runPipelineToReview(db, jobId, job.sourceId, files, totalSize);
    return (await getJob(db, jobId))!;
  } catch (e: any) {
    await updateJob(db, jobId, {
      state: 'failed',
      errorCode: classifyError(e),
      errorMessage: sanitizeError(e?.message),
    });
    // H2-Import-resume 修复：原 catch 只 updateJob 不 updateSourceStatus，
    // 对比 startContinuationImport 的 catch（381 行）遗漏了 source 状态。
    // 后果：source 卡在 needs_review/staging，getActiveContinuationSource
    // 返回 null，UI 既无恢复按钮也无清理入口，孤儿 source 永久占用磁盘。
    await updateSourceStatus(db, job.sourceId, 'failed', {
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

/**
 * Make an original file name safe to embed in an Android file path segment.
 * Replaces path separators and other unsafe chars with `_`, collapses
 * consecutive underscores, trims leading/trailing underscores, and caps the
 * length at 128 chars. Used when naming per-file copies inside the per-job
 * import directory so ordering is preserved (fileIndex prefix) and the
 * original name stays human-readable for debugging.
 */
export function sanitizeFileNameForPath(name: string): string {
  // Strip directory components if any, then replace unsafe chars.
  const base = name.split(/[\\/]/).pop() ?? name;
  const sanitized = base
    .replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5]/g, '_')
    .replace(/_+/g, '_') // collapse consecutive _
    .replace(/^_|_$/g, '') // trim leading/trailing _
    .slice(0, 128);
  return sanitized || 'file';
}

/**
 * Best-effort cleanup of the per-job import copy. Handles both the new
 * multi-file directory layout (`continuation-imports/${jobId}/`) and the
 * legacy single-file layout (`continuation-imports/${jobId}.txt`) so resume
 * of older interrupted jobs (pre-Task 4) still cleans up correctly.
 *
 * For a directory, deletes every file inside first, then the directory itself.
 * Never throws — cleanup is best-effort, orphans get swept on next recover.
 */
export async function cleanupImportPath(relativePath: string): Promise<void> {
  if (!relativePath) return;
  const abs = `${RNFS.DocumentDirectoryPath}/${relativePath}`;
  // Try as a directory first (new layout): readDir + unlink each + unlink dir.
  try {
    const items = await RNFS.readDir(abs);
    for (const it of items) {
      try {
        await RNFS.unlink(it.path);
      } catch {
        // ignore individual file errors
      }
    }
    await RNFS.unlink(abs);
    return;
  } catch {
    // Not a directory (or doesn't exist): fall through to file-mode unlink.
  }
  // Legacy single-file layout (or stale directory entry): try direct unlink.
  try {
    await RNFS.unlink(abs);
  } catch {
    // best-effort; orphan cleanup runs on next recover.
  }
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
