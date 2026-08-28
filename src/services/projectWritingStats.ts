import type { SqlStatement } from '../data/connection/transaction';

export interface ProjectWritingStats {
  projectId: number;
  chapterCount: number;
  bodyCharCount: number;
  updatedAt?: string;
}

/**
 * The one product-wide definition of project writing length.
 *
 * JavaScript `for...of` iterates Unicode code points (rather than UTF-16 code
 * units), and String#trim follows the platform's Unicode whitespace rules.
 * This deliberately counts only saved editable chapter bodies; callers must
 * not feed outline, source, prompt, or memory text into this function.
 */
export function countProjectBodyChars(value: unknown): number {
  const text = String(value ?? '');
  let count = 0;
  for (const codePoint of text) {
    if (codePoint.trim().length > 0) count += 1;
  }
  return count;
}

function formatBodyCharCount(count: number): string {
  const safeCount = Math.max(0, Math.floor(Number(count) || 0));
  if (safeCount < 10000) return `${safeCount.toLocaleString('zh-CN')} 字`;
  const wan = safeCount / 10000;
  const display =
    wan >= 100 ? wan.toFixed(0) : wan.toFixed(1).replace(/\.0$/, '');
  return `${display} 万字`;
}

export function formatProjectWritingStats(stats: {
  chapterCount: number;
  bodyCharCount: number;
}): string {
  const chapters = Math.max(0, Math.floor(Number(stats.chapterCount) || 0));
  return `${chapters.toLocaleString('zh-CN')} 章 · ${formatBodyCharCount(
    stats.bodyCharCount,
  )}`;
}

export function buildEnsureProjectWritingStatsStatement(
  projectId: number,
  timestamp: string,
): SqlStatement {
  return {
    sql: `INSERT OR IGNORE INTO project_writing_stats
      (project_id, chapter_count, body_char_count, updated_at)
      VALUES (?, 0, 0, ?)`,
    params: [projectId, timestamp],
  };
}

export function buildProjectWritingStatsDeltaStatement(
  projectId: number,
  chapterDelta: number,
  bodyCharDelta: number,
  timestamp: string,
): SqlStatement {
  return {
    sql: `UPDATE project_writing_stats
      SET chapter_count = chapter_count + ?,
          body_char_count = body_char_count + ?,
          updated_at = ?
      WHERE project_id = ?`,
    params: [chapterDelta, bodyCharDelta, timestamp, projectId],
  };
}
