/**
 * Multi-chapter batch writing-mode helpers (doc §5 / §6 / §14).
 *
 * The batch shell is shared between two execution kernels:
 *   outline      → existing runChapterPipeline path (unchanged)
 *   continuation → Continuation V5 execution adapter
 *
 * This module owns the frozen-mode payloads (anchor / execution policy) and
 * their strict decode helpers. Decode failures fail closed: a continuation
 * batch with an unreadable anchor cannot run drift checks, so callers pause
 * instead of continuing blindly.
 */
import {
  CONTINUATION_BATCH_DEFAULT_STATE_GATE_MAX_ATTEMPTS,
  CONTINUATION_BATCH_DEFAULT_STATE_GATE_POLL_MS,
} from '../../types/multiChapterBatch';
import type {
  ContinuationBatchAnchorV1,
  ContinuationBatchExecutionPolicyV1,
  MultiChapterWritingMode,
} from '../../types/multiChapterBatch';

export function isContinuationBatch(batch: {
  writingMode: unknown;
}): boolean {
  return batch.writingMode === 'continuation';
}

export function encodeContinuationBatchAnchor(
  anchor: ContinuationBatchAnchorV1,
): string {
  return JSON.stringify(anchor);
}

export function decodeContinuationBatchAnchor(
  raw: string | null | undefined,
): ContinuationBatchAnchorV1 | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ContinuationBatchAnchorV1>;
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.sourceId !== 'number' ||
      typeof parsed.sourceVersion !== 'number' ||
      typeof parsed.sourceSha256 !== 'string' ||
      typeof parsed.canonSnapshotId !== 'string' ||
      typeof parsed.canonRevision !== 'number' ||
      typeof parsed.startingContinuationTailPosition !== 'number'
    ) {
      return null;
    }
    return {
      schemaVersion: 1,
      sourceId: parsed.sourceId,
      sourceVersion: parsed.sourceVersion,
      sourceSha256: parsed.sourceSha256,
      boundaryPosition:
        parsed.boundaryPosition == null
          ? null
          : Number(parsed.boundaryPosition),
      boundaryChapterId:
        parsed.boundaryChapterId == null ? null : Number(parsed.boundaryChapterId),
      boundaryCharOffsetExclusive:
        parsed.boundaryCharOffsetExclusive == null
          ? null
          : Number(parsed.boundaryCharOffsetExclusive),
      canonSnapshotId: parsed.canonSnapshotId,
      canonRevision: Number(parsed.canonRevision),
      startingContinuationTailPosition: Number(
        parsed.startingContinuationTailPosition,
      ),
      startingContinuationTailChapterId:
        parsed.startingContinuationTailChapterId == null
          ? null
          : Number(parsed.startingContinuationTailChapterId),
    };
  } catch {
    return null;
  }
}

export function defaultContinuationBatchExecutionPolicy(): ContinuationBatchExecutionPolicyV1 {
  return {
    schemaVersion: 1,
    autoAdoptEligibleFinal: true,
    pauseOnSoftWarning: true,
    stateGatePollIntervalMs: CONTINUATION_BATCH_DEFAULT_STATE_GATE_POLL_MS,
    stateGateMaxAttempts: CONTINUATION_BATCH_DEFAULT_STATE_GATE_MAX_ATTEMPTS,
  };
}

export function encodeContinuationBatchExecutionPolicy(
  policy: ContinuationBatchExecutionPolicyV1,
): string {
  return JSON.stringify(policy);
}

export function decodeContinuationBatchExecutionPolicy(
  raw: string | null | undefined,
): ContinuationBatchExecutionPolicyV1 {
  const fallback = defaultContinuationBatchExecutionPolicy();
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<ContinuationBatchExecutionPolicyV1>;
    return {
      schemaVersion: 1,
      // Frozen-on purpose (doc §14): the conservative v1 policy never allows
      // disabling the safety pauses via corrupt persisted JSON.
      autoAdoptEligibleFinal: true,
      pauseOnSoftWarning: true,
      stateGatePollIntervalMs:
        typeof parsed.stateGatePollIntervalMs === 'number' &&
        parsed.stateGatePollIntervalMs >= 200
          ? parsed.stateGatePollIntervalMs
          : fallback.stateGatePollIntervalMs,
      stateGateMaxAttempts:
        typeof parsed.stateGateMaxAttempts === 'number' &&
        parsed.stateGateMaxAttempts >= 1
          ? parsed.stateGateMaxAttempts
          : fallback.stateGateMaxAttempts,
    };
  } catch {
    return fallback;
  }
}

export function normalizeWritingMode(value: unknown): MultiChapterWritingMode {
  return value === 'continuation' ? 'continuation' : 'outline';
}
