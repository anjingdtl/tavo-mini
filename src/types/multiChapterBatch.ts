/**
 * Multi-chapter batch domain types (Schema 42).
 *
 * The batch orchestrator is an OUTER orchestrator only: each chapter still
 * runs through the existing single-chapter pipeline. Batch state is the
 * durable source of truth — never an in-memory loop.
 */

export type MultiChapterBatchStatus =
  | 'draft'
  | 'planning'
  | 'ready'
  | 'running'
  | 'waiting_retry'
  | 'paused_user'
  | 'paused_timeout_unknown'
  | 'paused_account_quota'
  | 'paused_context_budget'
  | 'paused_batch_budget'
  | 'paused_project_changed'
  | 'failed'
  | 'cancelled'
  | 'completed';

export type MultiChapterBatchItemStatus =
  | 'pending'
  | 'creating_chapter'
  | 'chapter_ready'
  | 'creating_pipeline_task'
  | 'running_pipeline'
  | 'waiting_retry'
  | 'outcome_unknown'
  | 'blocked_context_budget'
  | 'blocked_account_quota'
  | 'blocked_batch_budget'
  | 'adopting'
  | 'succeeded'
  | 'succeeded_with_draft'
  | 'succeeded_with_user_text'
  | 'failed'
  | 'cancelled';

export type BatchItemCompletionQuality =
  | 'full_pipeline'
  | 'draft_only'
  | 'user_supplied';

export type MultiChapterBatchErrorCode =
  | 'BATCH_NOT_FOUND'
  | 'BATCH_ALREADY_RUNNING'
  | 'BATCH_LEASE_CONFLICT'
  | 'BATCH_PLAN_INVALID'
  | 'BATCH_PLAN_COUNT_MISMATCH'
  | 'BATCH_PROJECT_NOT_OUTLINE'
  | 'BATCH_PROJECT_CHANGED'
  | 'BATCH_CHAPTER_CREATE_FAILED'
  | 'BATCH_PIPELINE_TASK_CREATE_FAILED'
  | 'BATCH_PIPELINE_FAILED'
  | 'BATCH_ADOPTION_FAILED'
  | 'BATCH_ADOPTION_MISMATCH'
  | 'BATCH_CONTEXT_BUDGET_BLOCKED'
  | 'BATCH_ACCOUNT_QUOTA_BLOCKED'
  | 'BATCH_SPEND_BUDGET_BLOCKED'
  | 'BATCH_LLM_OUTCOME_UNKNOWN'
  | 'BATCH_RETRY_EXHAUSTED'
  | 'BATCH_CANCELLED'
  | 'BATCH_INTERRUPTED'
  // Continuation-batch specific codes (Schema 53). Mode-aware: only written
  // on batches whose writing_mode = 'continuation'.
  | 'BATCH_PROJECT_MODE_MISMATCH'
  | 'BATCH_CONTINUATION_SOURCE_CHANGED'
  | 'BATCH_CONTINUATION_BOUNDARY_CHANGED'
  | 'BATCH_CONTINUATION_CANON_CHANGED'
  | 'BATCH_CONTINUATION_RUN_FAILED'
  | 'BATCH_CONTINUATION_RUN_OUTDATED'
  | 'BATCH_CONTINUATION_FINAL_REJECTED'
  | 'BATCH_CONTINUATION_FINAL_NEEDS_REVIEW'
  | 'BATCH_CONTINUATION_ADOPTION_FAILED'
  | 'BATCH_CONTINUATION_FINALIZE_FAILED'
  | 'BATCH_CONTINUATION_STATE_SYNC_WAIT'
  | 'BATCH_CONTINUATION_STATE_SYNC_FAILED'
  | 'BATCH_CONTINUATION_STATE_SYNC_TIMEOUT'
  | 'BATCH_CONTINUATION_CHAPTER_CONFLICT';

/** Planner output item (strict JSON contract). */
export interface BatchChapterPlanItem {
  ordinal: number;
  title: string;
  synopsis: string;
  keyBeats: string[];
  carryIn: string;
  carryOut: string;
  targetWords: number;
}

export interface BatchChapterPlan {
  chapters: BatchChapterPlanItem[];
}

/** Batch budget (user-set hard caps). Null = unlimited. */
export interface BatchBudget {
  maxLlmCalls?: number | null;
  maxInputTokens?: number | null;
  maxOutputTokens?: number | null;
}

export type BatchPipelineMode = 'draft_only' | 'fast' | 'full';

/**
 * Batch writing mode (Schema 53). `outline` is the historical default and
 * keeps running through runChapterPipeline; `continuation` routes each item
 * through the Continuation V5 execution adapter instead. Old rows read as
 * `outline` via the column default.
 */
export type MultiChapterWritingMode = 'outline' | 'continuation';

/**
 * Frozen planning anchor for a continuation batch (doc §6.1). Captured once
 * at plan confirmation so drift protection can compare the live Source /
 * Canon / continuation tail against what the plan was built on. It is NOT a
 * per-chapter V5 snapshot — each chapter still freezes its own context via
 * startContinuationRun.
 */
export interface ContinuationBatchAnchorV1 {
  schemaVersion: 1;
  sourceId: number;
  sourceVersion: number;
  sourceSha256: string;
  /** 0-based source chapter position of the boundary chapter (reader domain). */
  boundaryPosition: number | null;
  boundaryChapterId: number | null;
  boundaryCharOffsetExclusive: number | null;
  canonSnapshotId: string;
  canonRevision: number;
  /** Continuation tail frozen at plan confirmation; -1 = no chapters yet. */
  startingContinuationTailPosition: number;
  startingContinuationTailChapterId: number | null;
}

/**
 * Frozen execution policy for a continuation batch (doc §14). First release
 * is intentionally conservative: eligible finals are adopted automatically,
 * anything requiring human confirmation pauses the batch.
 */
export interface ContinuationBatchExecutionPolicyV1 {
  schemaVersion: 1;
  autoAdoptEligibleFinal: true;
  pauseOnSoftWarning: true;
  /** State-gate bounded polling interval (ms). */
  stateGatePollIntervalMs: number;
  /** State-gate attempts before the batch pauses with a timeout. */
  stateGateMaxAttempts: number;
}

export const CONTINUATION_BATCH_DEFAULT_STATE_GATE_POLL_MS = 5000;
export const CONTINUATION_BATCH_DEFAULT_STATE_GATE_MAX_ATTEMPTS = 60;

export const BATCH_MIN_CHAPTERS = 1;
export const BATCH_MAX_CHAPTERS = 10;
export const BATCH_DEFAULT_CHAPTERS = 3;
export const BATCH_DEFAULT_TARGET_WORDS = 3000;
