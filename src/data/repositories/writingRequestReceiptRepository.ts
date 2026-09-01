import type SQLite from 'react-native-sqlite-storage';
import { openDatabase } from '../connection/openDatabase';
import {
  completeWritingRequestReceipt,
  compactWritingRequestReceipt,
  type WritingRequestReceipt,
} from '../../services/writing/contracts/writingRequestReceipt';

export type WritingRequestReceiptPreviewState =
  | 'started'
  | 'pending'
  | 'applied'
  | 'discarded'
  | 'failed';

export interface WritingRequestReceiptActionBinding {
  receipt: WritingRequestReceipt;
  projectId: number;
  actionId: string;
  previewId: string;
  candidateKind: 'chapter' | 'pipeline_task' | 'continuation_run';
  candidateId: string;
  candidateProjectId: number;
  candidateChapterId: number;
  actionKind: 'targeted_revision' | 'whole_chapter_rewrite';
  instructionFingerprint: string;
  baseBodyFingerprint: string;
  candidateBodyFingerprint?: string | null;
  previewState: WritingRequestReceiptPreviewState;
  /** Keep the first durable row timestamp stable across lifecycle updates. */
  createdAt?: number;
}

function receiptCreatedAt(input: WritingRequestReceiptActionBinding): number {
  const candidate =
    input.createdAt ??
    input.receipt.timings.queuedAt ??
    input.receipt.timings.dispatchStartedAt ??
    Date.now();
  return Number.isFinite(Number(candidate)) ? Number(candidate) : Date.now();
}

function receiptParams(input: WritingRequestReceiptActionBinding): unknown[] {
  return [
    input.receipt.requestId,
    input.projectId,
    input.actionId,
    input.previewId,
    input.candidateKind,
    input.candidateId,
    input.candidateProjectId,
    input.candidateChapterId,
    input.actionKind,
    input.instructionFingerprint,
    input.baseBodyFingerprint,
    input.candidateBodyFingerprint ?? null,
    input.previewState,
    JSON.stringify(compactWritingRequestReceipt(input.receipt)),
    receiptCreatedAt(input),
    Date.now(),
  ];
}

/**
 * Persist the one common receipt and its bounded User Revision action audit.
 * The JSON payload is compacted before it crosses the SQLite boundary, so a
 * caller cannot accidentally turn this ledger into a prompt/body store.
 */
export async function upsertWritingRequestReceipt(
  input: WritingRequestReceiptActionBinding,
  database?: SQLite.SQLiteDatabase,
): Promise<void> {
  const db = database ?? (await openDatabase());
  await db.executeSql(
    `INSERT INTO writing_request_receipts (
      request_id, project_id, action_id, preview_id, candidate_kind,
      candidate_id, candidate_project_id, candidate_chapter_id, action_kind,
      instruction_fingerprint, base_body_fingerprint,
      candidate_body_fingerprint, preview_state, receipt_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(request_id) DO UPDATE SET
      project_id = excluded.project_id,
      action_id = excluded.action_id,
      preview_id = excluded.preview_id,
      candidate_kind = excluded.candidate_kind,
      candidate_id = excluded.candidate_id,
      candidate_project_id = excluded.candidate_project_id,
      candidate_chapter_id = excluded.candidate_chapter_id,
      action_kind = excluded.action_kind,
      instruction_fingerprint = excluded.instruction_fingerprint,
      base_body_fingerprint = excluded.base_body_fingerprint,
      candidate_body_fingerprint = excluded.candidate_body_fingerprint,
      preview_state = excluded.preview_state,
      receipt_json = excluded.receipt_json,
      updated_at = excluded.updated_at`,
    receiptParams(input) as any[],
  );
}

/**
 * A process can be killed at any point around a User Revision request. On the
 * next startup, settle started rows without creating a retry. A started row
 * with a recorded physical dispatch becomes outcome_unknown. A successful
 * pending row represents an in-memory preview whose candidate cannot be
 * reconstructed after process death, so close only its preview ledger state
 * while preserving the recorded provider outcome.
 */
export async function markOpenWritingRequestReceiptsOutcomeUnknownOnStartup(
  database?: SQLite.SQLiteDatabase,
): Promise<number> {
  const db = database ?? (await openDatabase());
  const [result] = await db.executeSql(
    `SELECT request_id, preview_state, receipt_json
       FROM writing_request_receipts
      WHERE preview_state IN ('started', 'pending')`,
  );
  let updated = 0;
  for (let index = 0; index < result.rows.length; index += 1) {
    const row = result.rows.item(index);
    const requestId = String(row.request_id);
    const receiptJson = String(row.receipt_json || '');
    let receipt: WritingRequestReceipt;
    try {
      receipt = JSON.parse(receiptJson) as WritingRequestReceipt;
    } catch {
      // A malformed receipt is itself a durable failure. Do not overwrite it
      // with guessed call facts; startup validation/reporting can surface it.
      continue;
    }

    if (
      String(row.preview_state || '') === 'pending' &&
      receipt.outcome === 'succeeded'
    ) {
      // The candidate body is intentionally memory-only. A force-stop after
      // provider success cannot safely resume Apply/Discard, so fail closed
      // instead of leaving an action permanently pending or retrying it.
      const [write] = await db.executeSql(
        `UPDATE writing_request_receipts
            SET preview_state = 'failed', updated_at = ?
          WHERE request_id = ?
            AND preview_state = 'pending'
            AND receipt_json = ?`,
        [Date.now(), requestId, receiptJson],
      );
      updated += write.rowsAffected ?? 0;
      continue;
    }

    if (receipt.outcome !== 'started') continue;
    const crossedProviderBoundary =
      Number(receipt.physicalRequestCount || 0) > 0 ||
      receipt.requestMayHaveExecuted === true;
    const settled = completeWritingRequestReceipt(receipt, {
      outcome: crossedProviderBoundary ? 'outcome_unknown' : 'cancelled',
      failurePhase: crossedProviderBoundary ? 'outcome_unknown' : 'queue',
      requestMayHaveExecuted: crossedProviderBoundary,
    });
    const [write] = await db.executeSql(
      `UPDATE writing_request_receipts
          SET preview_state = 'failed', receipt_json = ?, updated_at = ?
        WHERE request_id = ? AND receipt_json = ?`,
      [
        JSON.stringify(compactWritingRequestReceipt(settled)),
        Date.now(),
        requestId,
        receiptJson,
      ],
    );
    updated += write.rowsAffected ?? 0;
  }
  return updated;
}
