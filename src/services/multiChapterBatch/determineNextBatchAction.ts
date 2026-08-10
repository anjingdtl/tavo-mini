/**
 * Pure multi-chapter batch state-machine decision (Phase 6).
 *
 * Single source of truth for "what should happen next". MUST NOT read live
 * settings, call LLM, or touch SQLite beyond the data passed in — the
 * reconciler reloads SQLite state before EVERY decision.
 *
 * Invariant: given the same persisted batch + items, always returns the same
 * action (idempotent plan). Execution CAS lives outside this function.
 */
import type {
  MultiChapterBatchItemRow,
  MultiChapterBatchRow,
} from '../../data/repositories/multiChapterBatchRepository';
import type { PipelineStageAttemptRow } from '../../data/repositories/pipelineStageAttemptRepository';
import {
  CURRENT_CONTEXT_BUDGET_VERSION,
  CURRENT_OUTLINE_WORKFLOW_VERSION,
} from '../pipeline/outlineWorkflowVersion';

export type MultiChapterBatchAction =
  | { type: 'plan_batch' }
  | { type: 'wait_for_plan_confirmation' }
  | { type: 'create_chapter'; ordinal: number }
  | { type: 'create_pipeline_task'; ordinal: number }
  | { type: 'run_pipeline'; ordinal: number }
  | { type: 'resume_pipeline'; ordinal: number }
  | { type: 'pause_legacy_pipeline'; ordinal: number }
  | { type: 'pause_legacy_batch' }
  | { type: 'wait_until'; timestamp: number }
  | { type: 'pause_unknown_outcome'; ordinal: number }
  | { type: 'pause_response_invalid'; ordinal: number }
  | { type: 'pause_account_quota'; ordinal: number }
  | { type: 'pause_context_budget'; ordinal: number }
  | { type: 'pause_batch_budget'; ordinal: number }
  | { type: 'pause_project_changed'; ordinal: number }
  | { type: 'adopt_full_result'; ordinal: number }
  | { type: 'adopt_draft_result'; ordinal: number }
  | { type: 'verify_adoption'; ordinal: number }
  | { type: 'advance'; ordinal: number }
  | { type: 'complete_batch' }
  | { type: 'no_op'; reason: string };

export interface DetermineBatchActionInput {
  batch: MultiChapterBatchRow;
  items: MultiChapterBatchItemRow[];
  /** taskId → persisted pipeline task status (from SQLite, not UI). */
  taskStatuses?: Record<string, string>;
  /** taskId → frozen workflow version, used to block old Resume paths. */
  taskWorkflowVersions?: Record<string, number>;
  /** taskId → frozen context budget version, used to block old Resume paths. */
  taskContextBudgetVersions?: Record<string, number>;
  /** Latest attempt per task for the current item (failure-driven). */
  latestAttempts?: Record<string, PipelineStageAttemptRow | null>;
  /** Effective batch budget check (max vs used). */
  budget?: {
    maxLlmCalls: number | null;
    maxInputTokens: number | null;
    maxOutputTokens: number | null;
    usedLlmCalls: number;
    usedInputTokens: number;
    usedOutputTokens: number;
  };
}

const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'failed']);
const PAUSED_STATUSES = new Set([
  'paused_user',
  'paused_timeout_unknown',
  'paused_account_quota',
  'paused_context_budget',
  'paused_batch_budget',
  'paused_project_changed',
]);

export function determineNextBatchAction(
  input: DetermineBatchActionInput,
): MultiChapterBatchAction {
  const { batch } = input;

  if (TERMINAL_STATUSES.has(batch.status)) {
    return { type: 'no_op', reason: `batch_terminal:${batch.status}` };
  }
  if (PAUSED_STATUSES.has(batch.status)) {
    return { type: 'no_op', reason: `batch_paused:${batch.status}` };
  }
  if (
    Number(batch.outlineWorkflowVersion) !== CURRENT_OUTLINE_WORKFLOW_VERSION ||
    Number(batch.contextBudgetVersion) !== CURRENT_CONTEXT_BUDGET_VERSION
  ) {
    return { type: 'pause_legacy_batch' };
  }
  if (batch.status === 'draft') {
    // Created but never planned — planner must run (UI flow) before confirm.
    return { type: 'plan_batch' };
  }
  if (batch.status === 'planning') {
    return { type: 'wait_for_plan_confirmation' };
  }
  if (batch.status === 'waiting_retry') {
    // Item-level next_retry_at decides; the item branch below handles it.
  }

  // --- batch budget hard caps (checked before each chapter) ----------------
  const budget = input.budget ?? {
    maxLlmCalls: batch.maxLlmCalls,
    maxInputTokens: batch.maxInputTokens,
    maxOutputTokens: batch.maxOutputTokens,
    usedLlmCalls: batch.usedLlmCalls,
    usedInputTokens: batch.usedInputTokens,
    usedOutputTokens: batch.usedOutputTokens,
  };
  if (
    (budget.maxLlmCalls != null && budget.usedLlmCalls >= budget.maxLlmCalls) ||
    (budget.maxInputTokens != null &&
      budget.usedInputTokens >= budget.maxInputTokens) ||
    (budget.maxOutputTokens != null &&
      budget.usedOutputTokens >= budget.maxOutputTokens)
  ) {
    return { type: 'pause_batch_budget', ordinal: batch.currentOrdinal };
  }

  const currentItem = input.items.find(i => i.ordinal === batch.currentOrdinal);
  if (!currentItem) {
    // All items consumed → completed (or counts drifted — fail closed).
    if (batch.completedCount >= batch.chapterCount) {
      return { type: 'complete_batch' };
    }
    return {
      type: 'no_op',
      reason: `missing_item:${batch.currentOrdinal}`,
    };
  }

  return decideItemAction(input, currentItem);
}

function decideItemAction(
  input: DetermineBatchActionInput,
  item: MultiChapterBatchItemRow,
): MultiChapterBatchAction {
  const ordinal = item.ordinal;

  switch (item.status) {
    case 'pending':
    case 'creating_chapter':
      return item.chapterId == null
        ? { type: 'create_chapter', ordinal }
        : { type: 'create_pipeline_task', ordinal };

    case 'chapter_ready':
      if (isLegacyIncompleteTask(input, item.activePipelineTaskId)) {
        return { type: 'pause_legacy_pipeline', ordinal };
      }
      return item.activePipelineTaskId == null
        ? { type: 'create_pipeline_task', ordinal }
        : { type: 'run_pipeline', ordinal };

    case 'creating_pipeline_task':
      if (isLegacyIncompleteTask(input, item.activePipelineTaskId)) {
        return { type: 'pause_legacy_pipeline', ordinal };
      }
      return item.activePipelineTaskId == null
        ? { type: 'create_pipeline_task', ordinal }
        : { type: 'run_pipeline', ordinal };

    case 'running_pipeline':
      return decideRunningPipeline(input, item);

    case 'waiting_retry': {
      if (isLegacyIncompleteTask(input, item.activePipelineTaskId)) {
        return { type: 'pause_legacy_pipeline', ordinal };
      }
      const retryAt = item.nextRetryAt ?? 0;
      if (retryAt <= Date.now()) {
        return { type: 'run_pipeline', ordinal };
      }
      return { type: 'wait_until', timestamp: retryAt };
    }

    case 'outcome_unknown':
      return { type: 'pause_unknown_outcome', ordinal };
    case 'blocked_context_budget':
      return { type: 'pause_context_budget', ordinal };
    case 'blocked_account_quota':
      return { type: 'pause_account_quota', ordinal };
    case 'blocked_batch_budget':
      return { type: 'pause_batch_budget', ordinal };

    case 'adopting':
      return { type: 'verify_adoption', ordinal };

    case 'succeeded':
    case 'succeeded_with_draft':
    case 'succeeded_with_user_text':
      return { type: 'advance', ordinal };

    case 'failed':
      return decideFailedItem(input, item);

    case 'cancelled':
      return { type: 'no_op', reason: 'item_cancelled' };
  }
}

function decideRunningPipeline(
  input: DetermineBatchActionInput,
  item: MultiChapterBatchItemRow,
): MultiChapterBatchAction {
  const ordinal = item.ordinal;
  // Chapter deleted by the user (FK SET NULL) — fail closed, never recreate.
  if (item.chapterId == null) {
    return { type: 'pause_project_changed', ordinal };
  }
  const taskId = item.activePipelineTaskId;
  if (!taskId) {
    return { type: 'create_pipeline_task', ordinal };
  }
  const taskStatus = input.taskStatuses?.[taskId];
  if (!taskStatus) {
    // Unknown task (deleted externally) — fail closed, never auto-recreate.
    return { type: 'pause_unknown_outcome', ordinal };
  }
  if (isLegacyIncompleteTask(input, taskId)) {
    return { type: 'pause_legacy_pipeline', ordinal };
  }
  if (taskStatus === 'idle' || taskStatus === 'queued') {
    // Task created but never started → first run.
    return { type: 'run_pipeline', ordinal };
  }
  if (
    taskStatus === 'drafting' ||
    taskStatus === 'reviewing' ||
    taskStatus === 'factChecking' ||
    taskStatus === 'proofing' ||
    taskStatus === 'interrupted'
  ) {
    if (isLegacyIncompleteTask(input, taskId)) {
      return { type: 'pause_legacy_pipeline', ordinal };
    }
    // Already started (or process-dead mid-run) → resume.
    return { type: 'resume_pipeline', ordinal };
  }
  if (taskStatus === 'completed') {
    return { type: 'adopt_full_result', ordinal };
  }
  if (taskStatus === 'failed' || taskStatus === 'cancelled') {
    return decideFailedItem(input, item);
  }
  return { type: 'no_op', reason: `task_status:${taskStatus}` };
}

function decideFailedItem(
  input: DetermineBatchActionInput,
  item: MultiChapterBatchItemRow,
): MultiChapterBatchAction {
  const ordinal = item.ordinal;
  const taskId = item.activePipelineTaskId;
  if (!taskId) {
    return { type: 'pause_unknown_outcome', ordinal };
  }
  if (isLegacyIncompleteTask(input, taskId)) {
    return { type: 'pause_legacy_pipeline', ordinal };
  }
  const latest = input.latestAttempts?.[taskId] ?? null;
  const failureClass = latest?.failureClass;
  const attemptNo = latest?.attemptNo ?? 0;

  if (failureClass === 'outcome_unknown') {
    return { type: 'pause_unknown_outcome', ordinal };
  }
  if (failureClass === 'response_invalid') {
    return { type: 'pause_response_invalid', ordinal };
  }
  if (failureClass === 'account_quota') {
    return { type: 'pause_account_quota', ordinal };
  }
  if (failureClass === 'context_error' || failureClass === 'blocked') {
    return { type: 'pause_context_budget', ordinal };
  }
  if (failureClass === 'safe_retry' || failureClass === 'rate_limit') {
    const nextRetryAt = latest?.nextRetryAt ?? Date.now();
    const canRetry = latest?.status === 'safe_to_retry' && attemptNo <= 3;
    if (canRetry && nextRetryAt > Date.now()) {
      return { type: 'wait_until', timestamp: nextRetryAt };
    }
    if (canRetry) {
      return { type: 'run_pipeline', ordinal };
    }
    // Retry budget exhausted → pause for the user.
    return { type: 'pause_unknown_outcome', ordinal };
  }
  // Generic failure without classification → pause for the user.
  return { type: 'pause_unknown_outcome', ordinal };
}

function isLegacyIncompleteTask(
  input: DetermineBatchActionInput,
  taskId: string | null,
): boolean {
  if (!taskId || !input.taskWorkflowVersions) return false;
  const status = input.taskStatuses?.[taskId];
  return (
    (Number(input.taskWorkflowVersions[taskId]) !==
      CURRENT_OUTLINE_WORKFLOW_VERSION ||
      Boolean(
        input.taskContextBudgetVersions &&
          Number(input.taskContextBudgetVersions[taskId]) !==
            CURRENT_CONTEXT_BUDGET_VERSION,
      )) &&
    status !== 'completed' &&
    status !== 'cancelled'
  );
}
