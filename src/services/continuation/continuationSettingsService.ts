/**
 * Continuation settings + boundary service (Spec §9.5, §12.3, §13).
 *
 * Owns boundary validation and the Phase 2 invalidation hook. Every boundary
 * change marks `analysis_status = 'outdated'` so Phase 2/3 state cannot be
 * silently reused after the user moves the continuation point (Spec §5.9).
 */
import { openDatabase } from '../../data/connection/openDatabase';
import {
  asUtf16Offset,
  ensureSettingsRow,
  getActiveSourceInTx,
  getChaptersBySourceInTx,
  getSettings,
  getSettingsInTx,
  markAnalysisOutdated,
  updateBoundaryInTx,
} from './continuationSourceRepository';
import type {
  ContinuationBoundaryMode,
  ContinuationSettings,
} from './types';

export interface BoundaryUpdateInput {
  mode: ContinuationBoundaryMode;
  /** Required for end_of_chapter / custom_offset. */
  chapterPosition?: number;
  /** For custom_offset: UTF-16 offset within the chosen chapter's body. */
  charOffsetWithinChapter?: number;
}

/** Read the current continuation settings for a project (Spec §13). */
export async function getContinuationSettings(
  projectId: number,
): Promise<ContinuationSettings | null> {
  return getSettings(projectId);
}

/**
 * Update the boundary and invalidate Phase 2 analysis (Spec §5.9, §9.5, §13).
 *
 * Validation:
 *   - end_of_source: boundary = last non-excluded chapter's end offset.
 *   - end_of_chapter: boundary = chosen chapter's end offset.
 *   - custom_offset: boundary = chapter.start + within, must lie in
 *     [content_start_offset, source_end_offset] of the chosen chapter.
 *   - the chosen chapter must not be excluded.
 *
 * The update marks analysis_status='outdated' in the same transaction so a
 * moved boundary can never be served with stale Phase 2 data.
 */
export async function updateContinuationBoundary(
  projectId: number,
  input: BoundaryUpdateInput,
): Promise<void> {
  const db = await openDatabase();
  await ensureSettingsRow(db, projectId);
  const source = await getActiveSourceInTx(db, projectId);
  if (!source) {
    throw new Error('当前项目尚未导入原著，无法设置续写起点。');
  }
  const chapters = (await getChaptersBySourceInTx(db, source.id)).filter(
    c => !c.isExcluded,
  );
  if (chapters.length === 0) {
    throw new Error('没有可用章节，无法设置续写起点。');
  }

  let chapterId: number;
  let charOffset: number;

  if (input.mode === 'end_of_source') {
    const last = chapters[chapters.length - 1];
    chapterId = last.id;
    charOffset = last.sourceEndOffset;
  } else {
    const pos = input.chapterPosition ?? chapters[chapters.length - 1].position;
    const chapter = chapters.find(c => c.position === pos);
    if (!chapter) {
      throw new Error('所选续写起点章节不存在或已被排除。');
    }
    chapterId = chapter.id;
    if (input.mode === 'end_of_chapter') {
      charOffset = chapter.sourceEndOffset;
    } else {
      const within = input.charOffsetWithinChapter ?? 0;
      charOffset = chapter.sourceStartOffset + within;
      if (
        charOffset < chapter.contentStartOffset ||
        charOffset > chapter.sourceEndOffset
      ) {
        throw new Error('自定义续写起点必须在所选章节的正文范围内。');
      }
    }
  }

  await updateBoundaryInTx(db, projectId, {
    sourceId: source.id,
    chapterId,
    charOffsetGlobal: asUtf16Offset(charOffset),
    mode: input.mode,
  });

  // Boundary change renumbers auto-titled continuation chapters to continue
  // from the new boundary (Spec §11.5, §12). User-custom titles are preserved;
  // internal positions, state events, Story Memory and generation runs are not
  // touched. Best-effort: a renumber failure must not roll back the boundary.
  try {
    const { renumberContinuationChapterTitles } = await import(
      './chapterNumbering/continuationChapterNumbering'
    );
    await renumberContinuationChapterTitles(projectId);
  } catch {
    // Non-fatal: the boundary is already committed; titles re-sync on next load.
  }
}

/** Mark Phase 2 analysis outdated without changing the boundary (Spec §5.9). */
export async function invalidateAnalysis(projectId: number): Promise<void> {
  const db = await openDatabase();
  await markAnalysisOutdated(db, projectId);
}

/** Whether the active source has a usable boundary for Phase 2 (Spec §23). */
export async function isBoundaryReady(projectId: number): Promise<boolean> {
  const settings = await getSettings(projectId);
  return !!(
    settings &&
    settings.activeSourceId &&
    settings.boundaryChapterId &&
    settings.boundaryCharOffsetGlobal
  );
}

// Re-export for convenience.
export { getSettingsInTx };
