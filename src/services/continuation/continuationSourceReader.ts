/**
 * Bounded SourceReader — the ONLY Phase 2/3 entry point for source text
 * (Spec §12.3, §13, §23).
 *
 * Contract enforced here, not assumed:
 *  - Every call binds the supplied snapshot within one DB read transaction.
 *  - The snapshot's sourceId/version/hash and parser/normalizer versions MUST
 *    still equal the live active source; otherwise throw
 *    `continuation_source_snapshot_outdated` (Spec §12.3, §23).
 *  - Results are always clipped to `snapshot.boundary.charOffsetExclusive`.
 *  - When the boundary falls mid-chapter, the last chapter's `content` is
 *    physically truncated at the boundary (Spec §12.3).
 *  - Future source (offsets ≥ boundary) is never returned.
 *
 * Phase 2 MUST NOT import the repository or chunks table directly, and MUST
 * NOT import ContinuationSourceBrowserService (that's UI-only future-browsing).
 */
import type {
  SourceChapterPosition,
  Utf16Offset,
} from '../../types/novel';
import type SQLite from 'react-native-sqlite-storage';
import { openDatabase } from '../../data/connection/openDatabase';
import {
  asSourcePosition,
  asUtf16Offset,
  getActiveSourceInTx,
  getChaptersBySourceInTx,
  getSettingsInTx,
  readChunksForRange,
} from './continuationSourceRepository';
import {
  ContinuationSnapshotOutdatedError,
  type BoundedSourceChapter,
  type BoundedSourceChapterMeta,
  type ContinuationSourceReader,
  type ContinuationSourceSnapshot,
} from './types';
import { ContinuationSourceIntegrityError } from './sourceIntegrity';

/**
 * Build a snapshot from the live active source + settings. Phase 2 captures
 * one of these per run and reuses it for every read so consistency can be
 * verified cheaply (Spec §23).
 */
export async function buildSnapshot(
  projectId: number,
): Promise<ContinuationSourceSnapshot> {
  const db = await openDatabase();
  const source = await getActiveSourceInTx(db, projectId);
  const settings = await getSettingsInTx(db, projectId);
  if (!source || !settings) {
    throw new ContinuationSnapshotOutdatedError('当前项目尚未激活续写源。');
  }
  if (
    settings.activeSourceId !== source.id ||
    settings.boundaryChapterId === null ||
    settings.boundaryCharOffsetGlobal === null
  ) {
    throw new ContinuationSnapshotOutdatedError('续写源尚未设置续写起点。');
  }
  // Look up the boundary chapter's position for the snapshot.
  const chapters = await getChaptersBySourceInTx(db, source.id);
  const boundaryChapter = chapters.find(c => c.id === settings.boundaryChapterId);
  if (!boundaryChapter) {
    throw new ContinuationSnapshotOutdatedError('续写起点章节已不存在。');
  }
  return {
    projectId,
    sourceId: source.id,
    sourceVersion: source.version,
    normalizedSha256: source.normalizedSha256,
    parserVersion: source.parserVersion,
    normalizationVersion: source.normalizationVersion,
    boundary: {
      chapterId: boundaryChapter.id,
      chapterPosition: boundaryChapter.position,
      charOffsetExclusive: settings.boundaryCharOffsetGlobal,
    },
  };
}

/**
 * Verify a snapshot still matches the live active source inside the supplied
 * DB handle's read context (Spec §12.3, §23). Throws on any drift.
 */
async function assertSnapshotMatches(
  db: SQLite.SQLiteDatabase,
  snapshot: ContinuationSourceSnapshot,
): Promise<void> {
  const source = await getActiveSourceInTx(db, snapshot.projectId);
  const settings = await getSettingsInTx(db, snapshot.projectId);
  if (
    !source ||
    !settings ||
    source.id !== snapshot.sourceId ||
    source.version !== snapshot.sourceVersion ||
    source.normalizedSha256 !== snapshot.normalizedSha256 ||
    source.parserVersion !== snapshot.parserVersion ||
    source.normalizationVersion !== snapshot.normalizationVersion ||
    settings.activeSourceId !== snapshot.sourceId ||
    settings.boundaryChapterId !== snapshot.boundary.chapterId ||
    settings.boundaryCharOffsetGlobal !== snapshot.boundary.charOffsetExclusive
  ) {
    throw new ContinuationSnapshotOutdatedError();
  }
}

/** Implementation of {@link ContinuationSourceReader} (Spec §23). */
export const continuationSourceReader: ContinuationSourceReader = {
  async getSnapshot(projectId: number): Promise<ContinuationSourceSnapshot> {
    return buildSnapshot(projectId);
  },

  async listBoundedSourceChapters(
    snapshot: ContinuationSourceSnapshot,
  ): Promise<BoundedSourceChapter[]> {
    const db = await openDatabase();
    await assertSnapshotMatches(db, snapshot);
    const chapters = await getChaptersBySourceInTx(db, snapshot.sourceId);
    return readBoundedChaptersFromRows(db, snapshot, chapters, null, null);
  },

  async listBoundedSourceChaptersForRange(
    snapshot: ContinuationSourceSnapshot,
    startPosition: SourceChapterPosition,
    endPosition: SourceChapterPosition,
  ): Promise<BoundedSourceChapter[]> {
    const db = await openDatabase();
    await assertSnapshotMatches(db, snapshot);
    const chapters = await getChaptersBySourceInTx(db, snapshot.sourceId);
    return readBoundedChaptersFromRows(
      db,
      snapshot,
      chapters,
      startPosition,
      endPosition,
    );
  },

  async listBoundedSourceChapterMetas(
    snapshot: ContinuationSourceSnapshot,
  ): Promise<BoundedSourceChapterMeta[]> {
    const db = await openDatabase();
    await assertSnapshotMatches(db, snapshot);
    const chapters = await getChaptersBySourceInTx(db, snapshot.sourceId);
    const boundary = snapshot.boundary.charOffsetExclusive;
    const out: BoundedSourceChapterMeta[] = [];
    for (const ch of chapters) {
      if (ch.isExcluded) continue;
      if (Number(ch.sourceStartOffset) >= boundary) continue;
      const rawEnd = Number(ch.sourceEndOffset);
      const clippedEnd = rawEnd > boundary ? boundary : rawEnd;
      const clippedByBoundary = rawEnd > boundary;
      out.push({
        id: ch.id,
        sourceId: ch.sourceId,
        position: ch.position,
        title: ch.title,
        contentLength: Math.max(0, clippedEnd - Number(ch.contentStartOffset)),
        range: {
          start: ch.contentStartOffset,
          end: asUtf16Offset(clippedEnd),
        },
        clippedByBoundary,
      });
      if (clippedByBoundary) break;
    }
    return out;
  },

  async readBoundedEvidenceRange(input): Promise<string> {
    const { snapshot, start, end } = input;
    if (start < 0 || end < 0 || start > end) {
      throw new Error(`非法的证据范围：[${start}, ${end})`);
    }
    const db = await openDatabase();
    await assertSnapshotMatches(db, snapshot);
    // Clip the requested range to the boundary (Spec §12.3).
    const boundary = snapshot.boundary.charOffsetExclusive;
    const clippedEnd = end > boundary ? boundary : end;
    if (start >= clippedEnd) return '';
    return readTextRange(
      db,
      snapshot.sourceId,
      asUtf16Offset(start),
      asUtf16Offset(clippedEnd),
    );
  },
};

/**
 * H1 修复：共享的章节正文读取核心。`startPosition`/`endPosition` 为 null
 * 时读取全部边界内章节（兼容 listBoundedSourceChapters）；非 null 时只读
 * position ∈ [startPosition, endPosition) 的章节（listBoundedSourceChaptersForRange
 * 按 batch 流式读取，避免 2000+ 章全量加载 OOM）。
 */
async function readBoundedChaptersFromRows(
  db: SQLite.SQLiteDatabase,
  snapshot: ContinuationSourceSnapshot,
  chapters: Awaited<ReturnType<typeof getChaptersBySourceInTx>>,
  startPosition: SourceChapterPosition | null,
  endPosition: SourceChapterPosition | null,
): Promise<BoundedSourceChapter[]> {
  const boundary = snapshot.boundary.charOffsetExclusive;
  const out: BoundedSourceChapter[] = [];
  for (const ch of chapters) {
    if (ch.isExcluded) continue;
    if (Number(ch.sourceStartOffset) >= boundary) continue;
    // H1: 按 position 区间过滤，跳过 batch 范围外的章节
    if (startPosition != null && endPosition != null) {
      const pos = Number(ch.position);
      if (pos < Number(startPosition) || pos >= Number(endPosition)) continue;
    }

    const rawEnd = Number(ch.sourceEndOffset);
    const clippedEnd = rawEnd > boundary ? boundary : rawEnd;
    const clippedByBoundary = rawEnd > boundary;

    const text = await readTextRange(
      db,
      snapshot.sourceId,
      ch.contentStartOffset,
      asUtf16Offset(clippedEnd),
    );

    out.push({
      id: ch.id,
      sourceId: ch.sourceId,
      position: ch.position,
      title: ch.title,
      content: text,
      range: {
        start: ch.contentStartOffset,
        end: asUtf16Offset(clippedEnd),
      },
      clippedByBoundary,
    });

    if (clippedByBoundary) break;
  }
  return out;
}

/**
 * Slice chunk contents to a UTF-16 sub-range `[start, end)` (Spec §9.3, §12.3).
 * Chunks are read by their stored offsets and sliced locally so the chunks
 * table remains the single text authority.
 *
 * Self-checks (fail loud — never silently return a shifted/truncated span):
 *  - at least one overlapping chunk when range is non-empty
 *  - first chunk covers `start`, last chunk covers `end`
 *  - adjacent chunks have no gap/overlap in declared offsets
 *  - each chunk's content.length matches declared end-start
 *  - final result.length === end - start
 */
async function readTextRange(
  db: SQLite.SQLiteDatabase,
  sourceId: number,
  start: Utf16Offset,
  end: Utf16Offset,
): Promise<string> {
  if (start >= end) return '';
  const expectedLen = end - start;
  const chunks = await readChunksForRange(db, sourceId, start, end);
  if (chunks.length === 0) {
    throw new ContinuationSourceIntegrityError(
      'continuation_source_integrity_failed',
      `原著分块缺失：无法读取区间 [${start}, ${end})。请重新导入原著。`,
      { sourceId, start, end },
    );
  }
  const first = chunks[0];
  const last = chunks[chunks.length - 1];
  if (first.charStartOffset > start || first.charEndOffset <= start) {
    throw new ContinuationSourceIntegrityError(
      'chunk_offset_gap',
      `原著分块未覆盖起点 ${start}（首块 [${first.charStartOffset}, ${first.charEndOffset})）。请重新导入原著。`,
      { sourceId, start, end, chunkStart: first.charStartOffset },
    );
  }
  if (last.charEndOffset < end || last.charStartOffset >= end) {
    throw new ContinuationSourceIntegrityError(
      'chunk_offset_gap',
      `原著分块未覆盖终点 ${end}（末块 [${last.charStartOffset}, ${last.charEndOffset})）。请重新导入原著。`,
      { sourceId, start, end, chunkEnd: last.charEndOffset },
    );
  }

  let result = '';
  let prevEnd: number | null = null;
  for (const chunk of chunks) {
    const declaredLen = chunk.charEndOffset - chunk.charStartOffset;
    if (chunk.content.length !== declaredLen) {
      throw new ContinuationSourceIntegrityError(
        'chunk_length_mismatch',
        `原著分块长度不一致：声明 ${declaredLen}，实际 content.length=${chunk.content.length}` +
          `（offset [${chunk.charStartOffset}, ${chunk.charEndOffset})）。请重新导入原著。`,
        {
          sourceId,
          start: chunk.charStartOffset,
          end: chunk.charEndOffset,
          declaredLen,
          actualLen: chunk.content.length,
        },
      );
    }
    if (prevEnd != null && chunk.charStartOffset !== prevEnd) {
      const code =
        chunk.charStartOffset > prevEnd
          ? 'chunk_offset_gap'
          : 'chunk_offset_overlap';
      throw new ContinuationSourceIntegrityError(
        code,
        `原著分块偏移不连续：期望 ${prevEnd}，实际 ${chunk.charStartOffset}。请重新导入原著。`,
        {
          sourceId,
          start: prevEnd,
          end: chunk.charStartOffset,
        },
      );
    }
    prevEnd = chunk.charEndOffset;

    // Translate global offsets to local slice indices within this chunk.
    const localStart = Math.max(0, start - chunk.charStartOffset);
    const localEnd = Math.min(
      chunk.content.length,
      end - chunk.charStartOffset,
    );
    if (localEnd > localStart) {
      result += chunk.content.slice(localStart, localEnd);
    }
  }
  if (result.length !== expectedLen) {
    throw new ContinuationSourceIntegrityError(
      'read_range_length_mismatch',
      `原著回读长度不匹配：期望 ${expectedLen}，实际 ${result.length}` +
        `（区间 [${start}, ${end})）。请重新导入原著。`,
      { sourceId, start, end, expectedLen, actualLen: result.length },
    );
  }
  return result;
}

/** Re-export the branded helpers for services/UI that build positions. */
export { asSourcePosition, asUtf16Offset };
export type { SourceChapterPosition, Utf16Offset };
