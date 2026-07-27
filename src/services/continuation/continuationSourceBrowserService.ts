/**
 * ⚠️ UI-only future-source browser (Spec §12.3).
 *
 * This service intentionally reads source text OUTSIDE the Phase 2 boundary.
 * It exists exclusively so the user can browse the part of the original work
 * that lies AFTER their chosen continuation point (the "future source").
 *
 * CONTRACT (Spec §12.3, §5.3):
 *   - ONLY the UI may import this service. Canon analysis (`src/services/
 *     continuation/canon`) and generation modules MUST NOT import it.
 *   - Every call MUST pass `purpose: 'user_browse_future_source'`.
 *   - This service reads the raw chunks table directly; it does NOT honour the
 *     boundary snapshot. It is the single, audited escape hatch.
 *
 * If you are adding an import of this file from a canon/generation path, STOP
 * — that is a Spec violation. Use `continuationSourceReader` instead.
 */
import type { Utf16Offset } from '../../types/novel';
import { openDatabase } from '../../data/connection/openDatabase';
import {
  asUtf16Offset,
  getActiveSourceInTx,
  getChaptersBySourceInTx,
  readChunksForRange,
} from './continuationSourceRepository';

export const BROWSER_PURPOSE = 'user_browse_future_source' as const;
export type BrowserPurpose = typeof BROWSER_PURPOSE;

export interface BrowseFutureChaptersInput {
  projectId: number;
  /** Must be exactly 'user_browse_future_source'. */
  purpose: BrowserPurpose;
  /** Cap the number of chapters returned (defensive). */
  maxChapters?: number;
}

export interface FutureChapter {
  id: number;
  position: number;
  title: string;
  /** First ~500 chars of the chapter body, for preview only. */
  preview: string;
  isExcluded: boolean;
}

function assertPurpose(purpose: BrowserPurpose): void {
  if (purpose !== BROWSER_PURPOSE) {
    throw new Error(
      '非法调用：未来原文浏览必须显式声明 purpose: user_browse_future_source。',
    );
  }
}

/**
 * List chapters that lie beyond the current boundary (Spec §12.3).
 * Returns only metadata + a short preview — never the full chapter body.
 */
export async function listFutureSourceChapters(
  input: BrowseFutureChaptersInput,
): Promise<FutureChapter[]> {
  assertPurpose(input.purpose);
  const db = await openDatabase();
  const source = await getActiveSourceInTx(db, input.projectId);
  if (!source) return [];
  const settings = await import('./continuationSourceRepository')
    .then(m => m.getSettingsInTx(db, input.projectId));
  if (!settings || settings.boundaryCharOffsetGlobal === null) return [];

  const boundary = settings.boundaryCharOffsetGlobal;
  const chapters = await getChaptersBySourceInTx(db, source.id);
  const future = chapters.filter(c => c.sourceStartOffset >= boundary);
  const cap = input.maxChapters ?? 50;

  const out: FutureChapter[] = [];
  for (const ch of future.slice(0, cap)) {
    // Read at most 500 chars of the chapter body for preview.
    const previewEnd = Math.min(
      ch.contentStartOffset + 500,
      ch.sourceEndOffset,
    ) as Utf16Offset;
    const preview = await readText(db, source.id, ch.contentStartOffset, previewEnd);
    out.push({
      id: ch.id,
      position: ch.position,
      title: ch.title,
      preview,
      isExcluded: ch.isExcluded,
    });
  }
  return out;
}

async function readText(
  db: Awaited<ReturnType<typeof openDatabase>>,
  sourceId: number,
  start: Utf16Offset,
  end: Utf16Offset,
): Promise<string> {
  if (start >= end) return '';
  const chunks = await readChunksForRange(db, sourceId, start, end);
  let result = '';
  for (const chunk of chunks) {
    const localStart = Math.max(0, start - chunk.charStartOffset);
    const localEnd = Math.min(chunk.content.length, end - chunk.charStartOffset);
    if (localEnd > localStart) result += chunk.content.slice(localStart, localEnd);
  }
  return result;
}

// Re-export the branded helper so the UI can build offsets safely.
export { asUtf16Offset };
