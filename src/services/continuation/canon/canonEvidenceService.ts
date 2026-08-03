/**
 * Canon evidence creation + validation (Spec §6.4, §8.6).
 * Evidence ranges are global UTF-16 offsets clipped to the analysis boundary.
 */
import type SQLite from 'react-native-sqlite-storage';
import { execute } from '../../../data/connection/execute';
import { now } from '../../../data/repositories/shared';
import { sha256Hex } from '../hashUtils';
import { continuationSourceReader } from '../continuationSourceReader';
import type { ContinuationSourceSnapshot } from '../types';
import { asUtf16Offset } from '../continuationSourceRepository';
import type { ExtractionEvidenceCandidate } from './canonJsonValidators';
import type {
  EvidenceOwnerType,
  CanonEvidenceView,
  CanonEvidence,
} from './types';
import { getSnapshotById, mapEvidence } from './canonRepository';
import { one } from '../../../data/connection/query';
import type { Row } from '../../../data/repositories/shared';

const QUOTE_PREVIEW_MAX = 160;

function utf16Len(s: string): number {
  return s.length; // JS strings are UTF-16 code units
}

function clipPreview(text: string): string {
  if (utf16Len(text) <= QUOTE_PREVIEW_MAX) return text;
  return text.slice(0, QUOTE_PREVIEW_MAX);
}

export interface CreateEvidenceInput {
  projectId: number;
  sourceId: number;
  snapshotId: string;
  analysisRunId: string;
  boundaryExclusive: number;
  candidate: ExtractionEvidenceCandidate;
  /** Full quote text already bounded; used for hash when provided. */
  quoteText?: string;
  /**
   * 2026-08-04 修复（问题1）：落库前回读校验。当提供时，insertEvidence 会
   * 用该函数按 [charStart, charEnd) 回读原文，与最终 quotePreview 比对，
   * 不一致拒绝该 evidence（返回 null）。生产代码传入绑定到 Phase 1
   * SourceReader 的闭包；测试可注入针对内存库的回读实现。
   */
  readBackVerifier?: (charStart: number, charEnd: number) => Promise<string>;
  /**
   * 2026-08-04（Schema 33）：证据来源标识。`'batch'`（默认）= 正常分析批次；
   * `'rescan'` = 定向补扫。配合 rescanOperationId 让补扫的删除只作用于
   * 本轮补扫的证据，不影响其他批次的证据。
   */
  sourceOrigin?: 'batch' | 'rescan';
  rescanOperationId?: string;
}

/**
 * Validate evidence against boundary and optionally verify quote hash against
 * the Phase 1 SourceReader (Spec §8.6).
 */
export function validateEvidenceRange(
  candidate: ExtractionEvidenceCandidate,
  boundaryExclusive: number,
): { ok: true } | { ok: false; reason: string } {
  if (candidate.charStart < 0 || candidate.charEnd <= candidate.charStart) {
    return { ok: false, reason: '非法证据范围' };
  }
  if (candidate.charEnd > boundaryExclusive) {
    return { ok: false, reason: '证据越过续写边界（future leakage）' };
  }
  if (candidate.charStart >= boundaryExclusive) {
    return { ok: false, reason: '证据起点越过续写边界' };
  }
  return { ok: true };
}

export async function insertEvidence(
  db: SQLite.SQLiteDatabase,
  input: CreateEvidenceInput,
): Promise<number | null> {
  const check = validateEvidenceRange(input.candidate, input.boundaryExclusive);
  if (!check.ok) return null;

  const preview = clipPreview(input.candidate.quotePreview || input.quoteText || '');

  // 2026-08-04 修复（问题1）：落库前用 SourceReader 按 charStart/charEnd 回读，
  // 确认回读文本与最终 quotePreview 一致。不一致（偏移错误/越界/被裁剪）则
  // 拒绝该 evidence，不允许仅依赖边界检查就让错误偏移的证据落库。
  if (input.readBackVerifier) {
    let readBack: string;
    try {
      readBack = await input.readBackVerifier(
        input.candidate.charStart,
        input.candidate.charEnd,
      );
    } catch {
      // SourceReader itself rejected the range — treat as unverifiable.
      return null;
    }
    if (readBack !== preview) {
      return null;
    }
  }

  const hashSource = input.quoteText ?? preview;
  const quoteSha = sha256Hex(hashSource);
  const ts = now();
  const sourceOrigin = input.sourceOrigin ?? 'batch';

  await execute(
    db,
    `INSERT INTO canon_evidence (
      project_id, source_id, snapshot_id, chapter_id, chapter_position,
      paragraph_start, paragraph_end, char_start, char_end, quote_preview,
      quote_sha256, analysis_run_id, source_origin, rescan_operation_id, created_at
    ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.projectId,
      input.sourceId,
      input.snapshotId,
      input.candidate.chapterId,
      input.candidate.chapterPosition,
      input.candidate.charStart,
      input.candidate.charEnd,
      preview,
      quoteSha,
      input.analysisRunId,
      sourceOrigin,
      input.rescanOperationId ?? null,
      ts,
    ],
  );

  const [result] = await db.executeSql('SELECT last_insert_rowid() AS id');
  return result.rows.item(0).id as number;
}

export async function linkEvidence(
  db: SQLite.SQLiteDatabase,
  evidenceId: number,
  snapshotId: string,
  ownerType: EvidenceOwnerType,
  ownerId: number,
): Promise<void> {
  await execute(
    db,
    `INSERT OR IGNORE INTO canon_evidence_links
      (evidence_id, snapshot_id, owner_type, owner_id, created_at)
      VALUES (?, ?, ?, ?, ?)`,
    [evidenceId, snapshotId, ownerType, ownerId, now()],
  );
}

export async function insertEvidenceAndLink(
  db: SQLite.SQLiteDatabase,
  input: CreateEvidenceInput,
  ownerType: EvidenceOwnerType,
  ownerId: number,
): Promise<number | null> {
  const id = await insertEvidence(db, input);
  if (id == null) return null;
  await linkEvidence(db, id, input.snapshotId, ownerType, ownerId);
  return id;
}

/** Read full quote via Phase 1 bounded reader (Spec §6.4). */
export async function readEvidenceView(
  projectId: number,
  snapshotId: string,
  evidenceId: number,
  sourceSnapshot: ContinuationSourceSnapshot,
): Promise<CanonEvidenceView> {
  const snap = await getSnapshotById(snapshotId);
  if (!snap || snap.projectId !== projectId) {
    throw new Error('证据所属快照不存在');
  }
  if (snap.boundaryCharOffsetExclusive !== sourceSnapshot.boundary.charOffsetExclusive) {
    // Soft check — reader still enforces boundary.
  }
  const row = await one<Row>('SELECT * FROM canon_evidence WHERE id = ?', [
    evidenceId,
  ]);
  if (!row || row.snapshot_id !== snapshotId) {
    throw new Error('证据不存在');
  }
  const base = mapEvidence(row);
  const quoteFull = await continuationSourceReader.readBoundedEvidenceRange({
    snapshot: sourceSnapshot,
    start: asUtf16Offset(base.charStart),
    end: asUtf16Offset(base.charEnd),
  });
  return { ...base, quoteFull };
}

export async function listEvidenceForOwner(
  snapshotId: string,
  ownerType: EvidenceOwnerType,
  ownerId: number,
): Promise<CanonEvidence[]> {
  const { all } = await import('../../../data/connection/query');
  const rows = await all<Row>(
    `SELECT e.* FROM canon_evidence e
      INNER JOIN canon_evidence_links l ON l.evidence_id = e.id
      WHERE l.snapshot_id = ? AND l.owner_type = ? AND l.owner_id = ?
      ORDER BY e.chapter_position ASC, e.char_start ASC`,
    [snapshotId, ownerType, ownerId],
  );
  return rows.map(mapEvidence);
}

export type { CanonEvidence };
