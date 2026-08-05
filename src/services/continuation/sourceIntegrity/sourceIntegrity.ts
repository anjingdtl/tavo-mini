/**
 * Continuation source integrity checks (import gate + analysis preflight).
 *
 * Quick check (analysis start): offset continuity, declared length vs
 * content.length, stored hash vs actual hash, chapter range legality.
 * Does NOT re-hash the entire novel body on every open.
 */
import type SQLite from 'react-native-sqlite-storage';
import { sha256Hex } from '../hashUtils';
import {
  ContinuationSourceIntegrityError,
  type ContinuationSourceIntegrityCode,
} from './ContinuationSourceIntegrityError';
import { isHighSurrogate, isLowSurrogate } from './utf16Safety';

export interface ContinuationSourceIntegrityIssue {
  code: ContinuationSourceIntegrityCode;
  sourceId: number;
  chunkIndex?: number;
  chapterId?: number;
  start?: number;
  end?: number;
  detail: string;
}

export interface ContinuationSourceIntegrityReport {
  ok: boolean;
  checkedChunkCount: number;
  checkedChapterCount: number;
  issues: ContinuationSourceIntegrityIssue[];
}

export interface ChunkIntegrityDiagnostic {
  chunkIndex: number;
  declaredStart: number;
  declaredEnd: number;
  declaredUtf16Length: number;
  actualUtf16Length: number;
  storedHash: string;
  actualHash: string;
  lengthMatches: boolean;
  hashMatches: boolean;
  firstCodeUnit: number | null;
  lastCodeUnit: number | null;
  startsWithLowSurrogate: boolean;
  endsWithHighSurrogate: boolean;
}

function pushIssue(
  issues: ContinuationSourceIntegrityIssue[],
  issue: ContinuationSourceIntegrityIssue,
): void {
  issues.push(issue);
}

/** Diagnose a single in-memory chunk row (safe for tests / scripts). */
export function diagnoseChunkContent(input: {
  chunkIndex: number;
  charStartOffset: number;
  charEndOffset: number;
  content: string;
  contentSha256: string;
}): ChunkIntegrityDiagnostic {
  const declaredUtf16Length = input.charEndOffset - input.charStartOffset;
  const actualUtf16Length = input.content.length;
  const actualHash = sha256Hex(input.content);
  const first =
    input.content.length > 0 ? input.content.charCodeAt(0) : null;
  const last =
    input.content.length > 0
      ? input.content.charCodeAt(input.content.length - 1)
      : null;
  return {
    chunkIndex: input.chunkIndex,
    declaredStart: input.charStartOffset,
    declaredEnd: input.charEndOffset,
    declaredUtf16Length,
    actualUtf16Length,
    storedHash: input.contentSha256,
    actualHash,
    lengthMatches: declaredUtf16Length === actualUtf16Length,
    hashMatches: actualHash === input.contentSha256,
    firstCodeUnit: first,
    lastCodeUnit: last,
    startsWithLowSurrogate: first != null && isLowSurrogate(first),
    endsWithHighSurrogate: last != null && isHighSurrogate(last),
  };
}

/**
 * Quick integrity scan over all chunks (+ optional chapter range checks).
 * Throws never — returns a report. Analysis callers convert to errors.
 */
export async function checkSourceIntegrityQuick(
  db: SQLite.SQLiteDatabase,
  sourceId: number,
  expectedCharCount?: number | null,
): Promise<ContinuationSourceIntegrityReport> {
  const issues: ContinuationSourceIntegrityIssue[] = [];

  const [chunkRes] = await db.executeSql(
    `SELECT chunk_index, char_start_offset, char_end_offset, content, content_sha256
      FROM continuation_source_text_chunks
      WHERE source_id = ?
      ORDER BY char_start_offset ASC`,
    [sourceId],
  );

  let cursor = 0;
  let prevLastCode: number | null = null;
  for (let i = 0; i < chunkRes.rows.length; i += 1) {
    const row = chunkRes.rows.item(i);
    const start = Number(row.char_start_offset);
    const end = Number(row.char_end_offset);
    const content: string = row.content ?? '';
    const storedHash: string = row.content_sha256 ?? '';
    const chunkIndex = Number(row.chunk_index);

    if (start !== cursor) {
      pushIssue(issues, {
        code:
          start > cursor ? 'chunk_offset_gap' : 'chunk_offset_overlap',
        sourceId,
        chunkIndex,
        start,
        end,
        detail: `chunk ${chunkIndex}: expected start ${cursor}, got ${start}`,
      });
    }

    const diag = diagnoseChunkContent({
      chunkIndex,
      charStartOffset: start,
      charEndOffset: end,
      content,
      contentSha256: storedHash,
    });

    if (!diag.lengthMatches) {
      pushIssue(issues, {
        code: 'chunk_length_mismatch',
        sourceId,
        chunkIndex,
        start,
        end,
        detail:
          `chunk ${chunkIndex}: declared length ${diag.declaredUtf16Length} ` +
          `!= content.length ${diag.actualUtf16Length}`,
      });
    }
    if (!diag.hashMatches) {
      pushIssue(issues, {
        code: 'chunk_hash_mismatch',
        sourceId,
        chunkIndex,
        start,
        end,
        detail: `chunk ${chunkIndex}: stored hash does not match content`,
      });
    }
    if (diag.endsWithHighSurrogate) {
      pushIssue(issues, {
        code: 'chunk_surrogate_boundary',
        sourceId,
        chunkIndex,
        start,
        end,
        detail: `chunk ${chunkIndex} ends with unpaired high surrogate`,
      });
    }
    if (diag.startsWithLowSurrogate) {
      pushIssue(issues, {
        code: 'chunk_surrogate_boundary',
        sourceId,
        chunkIndex,
        start,
        end,
        detail: `chunk ${chunkIndex} starts with unpaired low surrogate`,
      });
    }
    if (
      prevLastCode != null &&
      isHighSurrogate(prevLastCode) &&
      diag.firstCodeUnit != null &&
      isLowSurrogate(diag.firstCodeUnit)
    ) {
      pushIssue(issues, {
        code: 'chunk_surrogate_boundary',
        sourceId,
        chunkIndex,
        start,
        end,
        detail: `surrogate pair split across chunk boundary before index ${chunkIndex}`,
      });
    }

    prevLastCode = diag.lastCodeUnit;
    cursor = end;
  }

  if (
    expectedCharCount != null &&
    chunkRes.rows.length > 0 &&
    cursor !== expectedCharCount
  ) {
    pushIssue(issues, {
      code: 'continuation_source_integrity_failed',
      sourceId,
      start: cursor,
      end: expectedCharCount,
      detail:
        `last chunk ends at ${cursor}, expected normalized_char_count ${expectedCharCount}`,
    });
  }

  // Chapter range legality (metadata only — no full body re-read).
  const [chapRes] = await db.executeSql(
    `SELECT id, position, source_start_offset, content_start_offset, source_end_offset
      FROM continuation_source_chapters
      WHERE source_id = ?
      ORDER BY position ASC`,
    [sourceId],
  );
  for (let i = 0; i < chapRes.rows.length; i += 1) {
    const ch = chapRes.rows.item(i);
    const ss = Number(ch.source_start_offset);
    const cs = Number(ch.content_start_offset);
    const se = Number(ch.source_end_offset);
    if (
      !Number.isFinite(ss) ||
      !Number.isFinite(cs) ||
      !Number.isFinite(se) ||
      ss < 0 ||
      cs < ss ||
      se < cs
    ) {
      pushIssue(issues, {
        code: 'chapter_range_invalid',
        sourceId,
        chapterId: Number(ch.id),
        start: cs,
        end: se,
        detail:
          `chapter ${ch.id} invalid range ` +
          `sourceStart=${ss} contentStart=${cs} sourceEnd=${se}`,
      });
    }
  }

  return {
    ok: issues.length === 0,
    checkedChunkCount: chunkRes.rows.length,
    checkedChapterCount: chapRes.rows.length,
    issues,
  };
}

/** Assert quick integrity or throw {@link ContinuationSourceIntegrityError}. */
export async function assertSourceIntegrityQuick(
  db: SQLite.SQLiteDatabase,
  sourceId: number,
  expectedCharCount?: number | null,
): Promise<void> {
  const report = await checkSourceIntegrityQuick(
    db,
    sourceId,
    expectedCharCount,
  );
  if (report.ok) return;
  const first = report.issues[0];
  throw new ContinuationSourceIntegrityError(
    first?.code ?? 'continuation_source_integrity_failed',
    `原著源完整性检查失败：${first?.detail ?? '未知问题'}。` +
      `请重新导入原著 TXT（不可通过重试绕过）。`,
    {
      sourceId,
      issueCount: report.issues.length,
      issues: report.issues.slice(0, 8),
    },
  );
}
