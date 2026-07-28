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
  type ContinuationSourceReader,
  type ContinuationSourceSnapshot,
} from './types';

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
    const boundary = snapshot.boundary.charOffsetExclusive;

    const out: BoundedSourceChapter[] = [];
    for (const ch of chapters) {
      if (ch.isExcluded) continue;
      // Entirely past the boundary → future source, excluded (Spec §5.3, §12.3).
      if (ch.sourceStartOffset >= boundary) continue;

      // Determine the clipped end for this chapter.
      const rawEnd = ch.sourceEndOffset;
      const clippedEnd =
        rawEnd > boundary ? boundary : rawEnd;
      const clippedByBoundary = rawEnd > boundary;

      // Read the chapter body text from chunks: from content_start to clippedEnd.
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
          // `content` deliberately excludes the chapter heading, therefore
          // evidence offsets must begin at the body start as well. Using the
          // source start here shifted every Canon quote by the title length.
          start: ch.contentStartOffset,
          end: asUtf16Offset(clippedEnd),
        },
        clippedByBoundary,
      });

      // Once we've passed/clipped the boundary chapter, stop — no future source.
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
 * Slice chunk contents to a UTF-16 sub-range `[start, end)` (Spec §9.3, §12.3).
 * Chunks are read by their stored offsets and sliced locally so the chunks
 * table remains the single text authority.
 */
async function readTextRange(
  db: SQLite.SQLiteDatabase,
  sourceId: number,
  start: Utf16Offset,
  end: Utf16Offset,
): Promise<string> {
  if (start >= end) return '';
  const chunks = await readChunksForRange(db, sourceId, start, end);
  let result = '';
  for (const chunk of chunks) {
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
  return result;
}

/** Re-export the branded helpers for services/UI that build positions. */
export { asSourcePosition, asUtf16Offset };
export type { SourceChapterPosition, Utf16Offset };
