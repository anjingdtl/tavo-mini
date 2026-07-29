/**
 * Continuation chapter display numbering (Spec §11).
 *
 * Internal `chapters.position` for continuation chapters is a 0-based
 * `ContinuationChapterPosition` namespace that must stay decoupled from the
 * source-chapter `SourceChapterPosition` namespace (Phase 1/2 invariant). The
 * user-visible chapter number, however, should continue from where the original
 * work left off: if the boundary sits at the end of source chapter N, the first
 * continuation chapter (internal position 0) displays as "第 N+1 章".
 *
 * This service is the single source of truth for that mapping. UI, prompts,
 * notifications, Story Memory visible text and exports all go through it so the
 * displayed number is consistent and never silently drifts from the prompt.
 */
import { openDatabase } from '../../../data/connection/openDatabase';
import { continuationSourceReader } from '../continuationSourceReader';
import type { ContinuationChapterPosition } from '../../../types/novel';
import type { Chapter } from '../../../types/novel';

/**
 * Strict auto-title regex. Matches a pure numeric chapter title with optional
 * whitespace between 第, the number, and 章 (covers both `第1章` and `第 1 章`).
 * Anything else (e.g. `第 21 章 夜雨`, `夜雨来客`) is treated as a user-custom
 * title that must never be overwritten by renumbering (Spec §11.5). The regex
 * is anchored so a trailing subtitle disqualifies auto-renumber.
 */
export const AUTO_TITLE_REGEX = /^第\s*(\d+)\s*章$/;

/** Canonical display number for an original-source chapter (0-based). */
export function getSourceChapterDisplayNumber(position: number): number {
  return Number(position) + 1;
}

export function isAutoChapterTitle(title: string): boolean {
  return AUTO_TITLE_REGEX.test(title.trim());
}

export interface ContinuationChapterNumbering {
  /**
   * The source chapter number the boundary sits at (1-based), or null when no
   * source/boundary is available (offline hand-written continuation falls back
   * to position+1 per Phase 1 compat).
   */
  boundaryChapterNumber: number | null;
  /**
   * Map an internal 0-based continuation position to its user-visible number.
   * When a boundary exists: boundaryChapterNumber + position + 1. Otherwise the
   * Phase 1 fallback position + 1.
   */
  getDisplayNumber(position: ContinuationChapterPosition): number;
  /** Default auto title for a new continuation chapter at this position. */
  getDefaultTitle(position: ContinuationChapterPosition): string;
  /**
   * Resolve the display title for a chapter: keep user-custom titles verbatim,
   * recompute auto titles from the current boundary so renumbering follows
   * boundary changes without clobbering user edits.
   */
  getDisplayTitle(chapter: { title: string; position: number }): string;
}

/**
 * Build a numbering view from a known boundary chapter number (1-based, or null
 * when no source/boundary is bound). Pure helper — safe to unit test without a
 * database.
 */
export function makeContinuationChapterNumbering(
  boundaryChapterNumber: number | null,
): ContinuationChapterNumbering {
  const getDisplayNumber = (position: ContinuationChapterPosition): number => {
    if (boundaryChapterNumber == null) {
      return Number(position) + 1;
    }
    return boundaryChapterNumber + Number(position) + 1;
  };
  return {
    boundaryChapterNumber,
    getDisplayNumber,
    getDefaultTitle: position => `第 ${getDisplayNumber(position)} 章`,
    getDisplayTitle: chapter => {
      if (isAutoChapterTitle(chapter.title)) {
        return `第 ${getDisplayNumber(chapter.position as ContinuationChapterPosition)} 章`;
      }
      return chapter.title;
    },
  };
}

/**
 * Resolve the numbering view for a project by reading its active continuation
 * boundary. Reads only — never mutates state or positions. When the project has
 * no active source or boundary, returns the offline fallback numbering.
 */
export async function getContinuationChapterNumbering(
  projectId: number,
): Promise<ContinuationChapterNumbering> {
  let boundaryChapterNumber: number | null = null;
  try {
    const snapshot = await continuationSourceReader.getSnapshot(projectId);
    // boundary.chapterPosition is 0-based source position; the displayed source
    // chapter number is position + 1. New continuation chapters start at the
    // next chapter number regardless of a custom char offset inside the
    // boundary chapter (Spec §11.6).
    boundaryChapterNumber = getSourceChapterDisplayNumber(
      snapshot.boundary.chapterPosition,
    );
  } catch {
    // No active source/boundary: Phase 1 offline hand-written continuation
    // falls back to position + 1.
    boundaryChapterNumber = null;
  }
  return makeContinuationChapterNumbering(boundaryChapterNumber);
}

/**
 * Next internal position for a newly created continuation chapter. Uses
 * max(existing continuation chapter positions) + 1 instead of chapters.length
 * so deletions, imports or non-contiguous positions never produce duplicates or
 * wrong ordering (Spec §11.4). Returns 0 when no continuation chapters exist.
 */
export async function getNextContinuationChapterPosition(
  projectId: number,
): Promise<ContinuationChapterPosition> {
  const db = await openDatabase();
  const [res] = await db.executeSql(
    'SELECT COALESCE(MAX(position), -1) AS max_pos FROM chapters WHERE project_id = ?',
    [projectId],
  );
  const maxPos = res.rows.item(0).max_pos as number;
  return (maxPos + 1) as ContinuationChapterPosition;
}

/**
 * Renumber auto-titled continuation chapters after a boundary change while
 * preserving user-custom titles. Does NOT modify internal positions, state
 * events, Story Memory or generation runs (Spec §11.5, §12). Only chapters
 * whose current title matches the pure auto pattern are rewritten.
 */
export async function renumberContinuationChapterTitles(
  projectId: number,
): Promise<{ renamed: number }> {
  const numbering = await getContinuationChapterNumbering(projectId);
  // Stable ordering: position ASC, id ASC (Spec §11.4) — never by title string.
  const db = await openDatabase();
  const [res] = await db.executeSql(
    'SELECT id, position, title FROM chapters WHERE project_id = ? ORDER BY position ASC, id ASC',
    [projectId],
  );
  let renamed = 0;
  for (let i = 0; i < res.rows.length; i++) {
    const row = res.rows.item(i) as { id: number; position: number; title: string };
    if (isAutoChapterTitle(row.title)) {
      const newTitle = numbering.getDefaultTitle(
        row.position as ContinuationChapterPosition,
      );
      if (newTitle !== row.title) {
        await db.executeSql(
          'UPDATE chapters SET title = ?, updated_at = ? WHERE id = ?',
          [newTitle, new Date().toISOString(), row.id],
        );
        renamed += 1;
      }
    }
  }
  return { renamed };
}

/**
 * Chapter type re-exported for callers that want the minimal shape used by
 * getDisplayTitle. Kept loose to avoid coupling numbering to the full Chapter.
 */
export type { Chapter };
