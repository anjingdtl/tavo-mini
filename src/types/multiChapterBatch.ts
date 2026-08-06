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
  | 'BATCH_CANCELLED';

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

export const BATCH_MIN_CHAPTERS = 1;
export const BATCH_MAX_CHAPTERS = 10;
export const BATCH_DEFAULT_CHAPTERS = 3;
export const BATCH_DEFAULT_TARGET_WORDS = 3000;
