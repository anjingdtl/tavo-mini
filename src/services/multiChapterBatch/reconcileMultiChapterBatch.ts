/**
 * Multi-chapter batch reconciler (Phase 6) — the ONLY batch entry point.
 *
 * Strictly serial: one chapter at a time; the next chapter starts only after
 * the previous one's body, revision and item state are durably committed.
 * Every decision re-reads SQLite (never UI state). Idempotency guards:
 *   - chapter_id present → never re-create the chapter
 *   - active_pipeline_task_id present → never re-create the task
 *   - task completed → adopt, never regenerate
 *   - body already adopted (fingerprint) → never re-write / re-revision
 *   - item succeeded → advance only
 *   - batch completed → no-op
 */
import * as db from '../database';
import {
  claimBatchLease,
  createBatchChapterForItem,
  createPipelineTaskForBatchItem,
  getBatchById,
  getBatchItems,
  releaseBatchLease,
  updateBatchItem,
  updateBatchStatus,
  setBatchUsageFromRuns,
  commitBatchItemAdoption,
  type MultiChapterBatchItemRow,
  type MultiChapterBatchRow,
} from '../../data/repositories/multiChapterBatchRepository';
import {
  getPipelineTaskResumePayload,
  getPipelineTaskSummaryById,
} from '../../data/repositories/pipelineTaskRepository';
import { getLatestAttemptByTask } from '../../data/repositories/pipelineStageAttemptRepository';
import { getChaptersByProject } from '../../data/repositories/projectRepository';
import {
  determineNextBatchAction,
  type MultiChapterBatchAction,
} from './determineNextBatchAction';
import { adoptPipelineTaskResultAtomic } from './batchAdoption';
import { BatchLeaseSession } from './leaseSession';
import { MultiChapterBatchError } from './errors';
import { usePipelineTaskStore } from '../../store/pipelineTaskStore';
import {
  runOutlineWritingKernel,
  resumeOutlineWritingKernel,
} from '../writing/productionWritingEntry';
import type { StageInfo as PipelineStageInfo } from '../writing/productionWritingEntry';
import { BatchBudgetExceededError } from '../pipeline/reconcile';
import type { PipelineCheckpointStage } from '../pipeline/types';
import type { PipelineMode } from '../../types/pipeline';
import type { PipelineTaskStatus } from '../../types/pipeline';
import type { BatchItemCompletionQuality } from '../../types/multiChapterBatch';
import {
  CURRENT_CONTEXT_BUDGET_VERSION,
  CURRENT_OUTLINE_WORKFLOW_VERSION,
  shouldIncludeBriefCheckpoint,
} from '../pipeline/outlineWorkflowVersion';
import { executeContinuationBatchStep } from './continuationBatchAdapter';
import { setBatchUsageFromContinuationRuns } from './continuationBatchUsage';

export interface BatchProgressInfo {
  batchId: string;
  status: string;
  currentOrdinal: number;
  completedCount: number;
  chapterCount: number;
  itemStatus?: string;
  taskStatus?: string;
  /** Current single-chapter pipeline stage (live heartbeat). */
  stage?: string;
  message?: string;
}

export interface ReconcileMultiChapterBatchOptions {
  /** Lease owner token (instance id). Required for CAS. */
  owner: string;
  leaseMs?: number;
  onProgress?: (info: BatchProgressInfo) => void;
  /** Injectable pipeline runners (tests replace these). */
  runPipeline?: typeof runOutlineWritingKernel;
  resumePipeline?: typeof resumeOutlineWritingKernel;
  maxSteps?: number;
}

const DEFAULT_LEASE_MS = 60_000;
const MAX_STEPS = 200;
const WAIT_CHUNK_MS = 15_000;

/**
 * Batch form modes → single-chapter pipeline modes.
 * UI: 仅草稿 / 快速 / 完整；execution: noReview / twoStage / full.
 */
export function mapBatchModeToPipelineMode(mode: string): PipelineMode {
  if (mode === 'draft_only') return 'noReview';
  if (mode === 'fast') return 'twoStage';
  return 'full';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getErrorMessage(error: any, fallback: string): string {
  return error?.message ? String(error.message) : fallback;
}

/** Load the persisted status of the current item's pipeline task. */
async function loadTaskStatuses(
  item: MultiChapterBatchItemRow | undefined,
): Promise<Record<string, string>> {
  if (!item?.activePipelineTaskId) return {};
  const task = await getPipelineTaskSummaryById(item.activePipelineTaskId);
  return task ? { [item.activePipelineTaskId]: String(task.status) } : {};
}

/** taskId → persisted task error (local fail-fast causes, no LLM attempt). */
async function loadTaskErrors(
  item: MultiChapterBatchItemRow | undefined,
): Promise<Record<string, string | null>> {
  if (!item?.activePipelineTaskId) return {};
  const task = await getPipelineTaskSummaryById(item.activePipelineTaskId);
  return task
    ? { [item.activePipelineTaskId]: task.error ? String(task.error) : null }
    : {};
}

async function loadTaskVersions(
  item: MultiChapterBatchItemRow | undefined,
): Promise<{
  taskWorkflowVersions: Record<string, number>;
  taskContextBudgetVersions: Record<string, number>;
}> {
  if (!item?.activePipelineTaskId) {
    return { taskWorkflowVersions: {}, taskContextBudgetVersions: {} };
  }
  const task = await getPipelineTaskSummaryById(item.activePipelineTaskId);
  if (!task) {
    return { taskWorkflowVersions: {}, taskContextBudgetVersions: {} };
  }
  return {
    taskWorkflowVersions: {
      [item.activePipelineTaskId]: Number(task.outlineWorkflowVersion ?? 1),
    },
    taskContextBudgetVersions: {
      [item.activePipelineTaskId]: Number(task.contextBudgetVersion ?? 1),
    },
  };
}

async function loadLatestAttempts(
  item: MultiChapterBatchItemRow | undefined,
): Promise<Record<string, unknown>> {
  if (!item?.activePipelineTaskId) return {};
  const attempt = await getLatestAttemptByTask(item.activePipelineTaskId);
  return { [item.activePipelineTaskId]: attempt };
}

/** Detect unexpected insertion/reorder at the project tail (doc §25).
 *
 * Two checks (both must pass for the project to be considered unchanged):
 *   1. tail position equals startPosition + completedCount
 *      (user inserted or deleted a tail chapter)
 *   2. expectedTailChapterId (frozen on saveEditedPlan) is still present
 *      and at the expected position — protects against the user deleting
 *      the tail and creating a new chapter at the same position
 *
 * startPosition = -1 is the "empty project" anchor: chapter count grows
 * from 0; expectedTail = -1 + completedCount = completedCount - 1, which is
 * the position of the last adopted chapter. The check degenerates to a
 * pure tail-position check and the id check is skipped when the anchor is
 * unset (legacy batches) or when no chapters exist yet.
 */
async function checkProjectTailDrift(
  batch: MultiChapterBatchRow,
): Promise<boolean> {
  if (batch.startPosition == null) return false;
  const chapters = await getChaptersByProject(batch.projectId);
  if (chapters.length === 0) return false;

  const positions = chapters.map(c => c.position);
  const tail = Math.max(...positions);
  const expectedTail = batch.startPosition + batch.completedCount;
  if (tail !== expectedTail) return true;

  // Tail chapter id identity check. expectedTailChapterId is the chapter
  // id that existed at the tail when saveEditedPlan froze the plan. It is
  // only meaningful while the batch has not appended any chapter of its
  // own — after the first adoption the tail becomes a batch-owned chapter,
  // so the original anchor no longer applies. For legacy batches without
  // an anchor (null), skip the id assertion (position check is enough).
  if (batch.completedCount === 0 && batch.expectedTailChapterId != null) {
    const tailChapter = chapters.find(c => c.position === tail);
    if (!tailChapter || tailChapter.id !== batch.expectedTailChapterId) {
      return true;
    }
  }
  return false;
}

export async function reconcileMultiChapterBatch(
  batchId: string,
  options: ReconcileMultiChapterBatchOptions,
): Promise<void> {
  const owner = options.owner;
  const runPipelineImpl = options.runPipeline ?? runOutlineWritingKernel;
  const resumePipelineImpl = options.resumePipeline ?? resumeOutlineWritingKernel;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;

  const initial = await getBatchById(batchId);
  if (!initial) {
    throw new MultiChapterBatchError('BATCH_NOT_FOUND', '批次不存在');
  }
  if (['completed', 'cancelled', 'failed'].includes(initial.status)) {
    return; // terminal — nothing to do
  }

  const claimed = await claimBatchLease(
    batchId,
    owner,
    leaseMs,
    initial.rowVersion,
  );
  if (!claimed) {
    throw new MultiChapterBatchError(
      'BATCH_LEASE_CONFLICT',
      '批次已被其他执行器占用',
    );
  }

  try {
    const maxSteps = options.maxSteps ?? MAX_STEPS;
    for (let step = 0; step < maxSteps; step += 1) {
      // Re-read EVERYTHING from SQLite before deciding (never UI state).
      const batch = await getBatchById(batchId);
      if (!batch)
        throw new MultiChapterBatchError('BATCH_NOT_FOUND', '批次不存在');
      if (['completed', 'cancelled', 'failed'].includes(batch.status)) {
        return;
      }
      if (batch.status.startsWith('paused_')) {
        return; // user/pause action required
      }
      // Renew the lease on every state-machine step (RB-8): a long single-
      // chapter run must not let the lease expire and admit a second owner.
      // Fail-closed: losing the lease stops progress immediately.
      const renewed = await claimBatchLease(
        batchId,
        owner,
        leaseMs,
        batch.rowVersion,
      );
      if (!renewed) {
        throw new MultiChapterBatchError(
          'BATCH_LEASE_CONFLICT',
          '批次租约已失效，请重新开始',
        );
      }
      const items = await getBatchItems(batchId);
      // Mode split (doc §4.3 / §46): continuation batches execute through the
      // dedicated Continuation V5 adapter; the outline branch below stays
      // exactly as before (never runChapterPipeline for continuation).
      if (batch.writingMode === 'continuation') {
        let handled: 'continue' | 'break' | 'stop';
        try {
          handled = await executeContinuationBatchStep({
            batchId,
            batch,
            items,
            options: {
              owner: options.owner,
              leaseMs: options.leaseMs,
              onProgress: options.onProgress,
            },
          });
        } finally {
          // Continuation V5 owns its request ledger, so refresh the batch
          // counters after every adapter step, including thrown errors,
          // failed runs and state-gate pauses. Waiting until item success made
          // a retryable failure look like 0 spend and allowed the next
          // explicit retry to escape the elastic batch budget.
          try {
            await setBatchUsageFromContinuationRuns(
              batchId,
              await getBatchItems(batchId),
            );
          } catch {
            // Preserve the adapter's original failure. The next foreground
            // refresh/reconcile will retry this durable telemetry fold.
          }
        }
        if (handled === 'stop') return;
        if (handled === 'break') break;
        continue;
      }
      const currentItem = items.find(i => i.ordinal === batch.currentOrdinal);
      const taskStatuses = await loadTaskStatuses(currentItem);
      const taskVersions = await loadTaskVersions(currentItem);
      const taskErrors = await loadTaskErrors(currentItem);
      const latestAttempts = (await loadLatestAttempts(currentItem)) as Record<
        string,
        any
      >;

      const action = determineNextBatchAction({
        batch,
        items,
        taskStatuses,
        taskErrors,
        ...taskVersions,
        latestAttempts,
      });
      console.log(
        `[batch-reconcile] step=${step} batchStatus=${batch.status} ordinal=${
          batch.currentOrdinal
        } action=${action.type} itemStatus=${currentItem?.status} activeTask=${
          currentItem?.activePipelineTaskId ?? 'null'
        } taskStatuses=${JSON.stringify(taskStatuses)}`,
      );

      const handled = await executeBatchAction({
        batchId,
        batch,
        currentItem,
        action,
        options,
        runPipelineImpl,
        resumePipelineImpl,
      });
      if (handled === 'stop') return;
      if (handled === 'break') break;
    }
  } finally {
    try {
      await releaseBatchLease(batchId, owner);
    } catch {
      // lease release failure must not mask pipeline errors
    }
  }
}

async function executeBatchAction(params: {
  batchId: string;
  batch: MultiChapterBatchRow;
  currentItem: MultiChapterBatchItemRow | undefined;
  action: MultiChapterBatchAction;
  options: ReconcileMultiChapterBatchOptions;
  runPipelineImpl: typeof runOutlineWritingKernel;
  resumePipelineImpl: typeof resumeOutlineWritingKernel;
}): Promise<'continue' | 'break' | 'stop'> {
  const { batchId, batch, currentItem, action, options } = params;
  const notify = (message: string) => {
    options.onProgress?.({
      batchId,
      status: batch.status,
      currentOrdinal: batch.currentOrdinal,
      completedCount: batch.completedCount,
      chapterCount: batch.chapterCount,
      itemStatus: currentItem?.status,
      message,
    });
  };

  switch (action.type) {
    case 'plan_batch':
      throw new MultiChapterBatchError(
        'BATCH_PLAN_INVALID',
        '批次尚未规划，请先完成规划并确认',
      );

    case 'wait_for_plan_confirmation':
      notify('等待计划确认');
      return 'stop';

    case 'create_chapter': {
      if (!currentItem) return 'continue';
      if (await checkProjectTailDrift(batch)) {
        await updateBatchStatus(batchId, 'paused_project_changed', {
          errorCode: 'BATCH_PROJECT_CHANGED',
          errorMessage: '项目章节末尾已变化，请确认继续方式',
        });
        return 'stop';
      }
      if (currentItem.chapterId != null) {
        // Idempotent: chapter already created.
        await updateBatchItem(batchId, currentItem.ordinal, {
          status: 'chapter_ready',
        });
        return 'continue';
      }
      await updateBatchItem(batchId, currentItem.ordinal, {
        status: 'creating_chapter',
      });
      const chapters = await getChaptersByProject(batch.projectId);
      const position =
        chapters.length > 0
          ? Math.max(...chapters.map(c => c.position)) + 1
          : 0;
      await createBatchChapterForItem(batchId, currentItem.ordinal, {
        projectId: batch.projectId,
        position,
        title: currentItem.title || `第 ${currentItem.ordinal} 章`,
        // 章节摘要只使用每章独立的计划摘要（列表显示正确）；批次总目标等
        // 指令以结构化方式存 summary_json，仅用于 Draft 生成补充。
        synopsis: currentItem.synopsis,
        summaryJson: JSON.stringify({
          batch_instruction: buildBatchChapterInstruction(batch, currentItem),
        }),
      });
      notify(`已创建第 ${currentItem.ordinal} 章`);
      return 'continue';
    }

    case 'create_pipeline_task': {
      if (!currentItem || currentItem.chapterId == null) return 'continue';
      if (currentItem.activePipelineTaskId != null) {
        // Idempotent: task already bound.
        await updateBatchItem(batchId, currentItem.ordinal, {
          status: 'running_pipeline',
        });
        return 'continue';
      }
      console.log(
        `[batch-reconcile] create_pipeline_task ord=${currentItem.ordinal} itemStatus=${currentItem.status} chapterId=${currentItem.chapterId}`,
      );
      await updateBatchItem(batchId, currentItem.ordinal, {
        status: 'creating_pipeline_task',
      });
      const taskId = `batch_${batchId}_ord${currentItem.ordinal}_${Date.now()}`;
      const now = Date.now();
      const taskWorkflowVersion =
        Number(batch.outlineWorkflowVersion) === CURRENT_OUTLINE_WORKFLOW_VERSION
          ? batch.outlineWorkflowVersion
          : CURRENT_OUTLINE_WORKFLOW_VERSION;
      const taskContextVersion =
        Number(batch.outlineWorkflowVersion) === CURRENT_OUTLINE_WORKFLOW_VERSION
          ? batch.contextBudgetVersion
          : CURRENT_CONTEXT_BUDGET_VERSION;
      const isStructured = shouldIncludeBriefCheckpoint({
        outlineWorkflowVersion: Number(taskWorkflowVersion),
        contextBudgetVersion: Number(taskContextVersion),
      });
      const stages: PipelineCheckpointStage[] = isStructured
        ? ['draft', 'review', 'factCheck', 'brief', 'proof']
        : ['draft', 'review', 'factCheck', 'proof'];
      await createPipelineTaskForBatchItem({
        batchId,
        ordinal: currentItem.ordinal,
        chapterId: currentItem.chapterId,
        task: {
          id: taskId,
          targetType: 'chapter',
          targetId: currentItem.chapterId,
          status: 'idle',
          stageResults: [],
          finalText: null,
          error: null,
          // §4.4: every chapter task of a batch copies the FROZEN batch
          // versions — never re-reads the app default mid-batch.
          outlineWorkflowVersion: taskWorkflowVersion ?? CURRENT_OUTLINE_WORKFLOW_VERSION,
          contextBudgetVersion: taskContextVersion ?? CURRENT_CONTEXT_BUDGET_VERSION,
          createdAt: now,
          updatedAt: now,
          resolvedAt: null,
        },
        stages,
        runNo: currentItem.activeRunNo + 1,
        llmConfigSnapshotJson: '{}',
        reason: 'batch_start',
      });
      // The single-chapter pipeline persists through pipelineTaskStore; the
      // batch creates tasks directly, so register the task in memory too
      // (idempotent) — otherwise persistTaskStage / persistTaskPipelineContext
      // reject the unknown task and the chapter never starts.
      usePipelineTaskStore.getState().registerPersistedTask({
        id: taskId,
        targetType: 'chapter',
        targetId: currentItem.chapterId,
        status: 'idle',
        stageResults: [],
        finalText: null,
        error: null,
        inputFingerprint: null,
        pipelineContextJson: null,
        pipelineContextVersion: null,
        pipelineContextHash: null,
        outlineWorkflowVersion: taskWorkflowVersion ?? CURRENT_OUTLINE_WORKFLOW_VERSION,
        contextBudgetVersion: taskContextVersion ?? CURRENT_CONTEXT_BUDGET_VERSION,
        createdAt: now,
        updatedAt: now,
        resolvedAt: null,
        resolvedAction: null,
      });
      notify(`已创建第 ${currentItem.ordinal} 章流水线任务`);
      return 'continue';
    }

    case 'run_pipeline':
    case 'resume_pipeline': {
      if (
        !currentItem ||
        !currentItem.chapterId ||
        !currentItem.activePipelineTaskId
      ) {
        return 'continue';
      }
      const taskId = currentItem.activePipelineTaskId;
      // Cold-start / process restart: the task row exists but was never
      // registered in the in-memory pipeline store. Register (idempotent) so
      // the single-chapter pipeline's store writes succeed.
      const existingTask = await getPipelineTaskResumePayload(taskId);
      if (existingTask) {
        usePipelineTaskStore.getState().registerPersistedTask({
          id: existingTask.id,
          targetType: (existingTask.targetType || 'chapter') as 'chapter',
          targetId: Number(existingTask.targetId ?? currentItem.chapterId),
          status: (existingTask.status || 'idle') as PipelineTaskStatus,
          stageResults: Array.isArray(existingTask.stageResults)
            ? existingTask.stageResults
            : [],
          finalText: existingTask.finalText ?? null,
          error: existingTask.error ?? null,
          inputFingerprint: existingTask.inputFingerprint ?? null,
          pipelineContextJson: existingTask.pipelineContextJson ?? null,
          pipelineContextVersion: existingTask.pipelineContextVersion ?? null,
          pipelineContextHash: existingTask.pipelineContextHash ?? null,
          outlineWorkflowVersion:
            existingTask.outlineWorkflowVersion != null
              ? Number(existingTask.outlineWorkflowVersion)
              : null,
          contextBudgetVersion:
            existingTask.contextBudgetVersion != null
              ? Number(existingTask.contextBudgetVersion)
              : null,
          createdAt: Number(existingTask.createdAt ?? Date.now()),
          updatedAt: Number(existingTask.updatedAt ?? Date.now()),
          resolvedAt: existingTask.resolvedAt ?? null,
          resolvedAction: existingTask.resolvedAction ?? null,
        });
      }
      const chapter = await db.getChapterById(currentItem.chapterId);
      if (!chapter) {
        await updateBatchStatus(batchId, 'paused_project_changed', {
          errorCode: 'BATCH_PROJECT_CHANGED',
          errorMessage: '当前章节已被删除',
        });
        return 'stop';
      }
      // Live stage heartbeat: forward the single-chapter pipeline stage so
      // the batch notification / run page shows progress (not a frozen text)
      // and the user can tell the batch is alive.
      const notifyStage = (info: PipelineStageInfo | string) => {
        const label = typeof info === 'string' ? info : info?.label;
        const stage = typeof info === 'string' ? undefined : info?.stage;
        if (label) {
          options.onProgress?.({
            batchId,
            status: batch.status,
            currentOrdinal: batch.currentOrdinal,
            completedCount: batch.completedCount,
            chapterCount: batch.chapterCount,
            itemStatus: currentItem?.status,
            stage,
            message: label,
          });
        }
      };
      const currentPipelineMode =
        Number(batch.outlineWorkflowVersion) === CURRENT_OUTLINE_WORKFLOW_VERSION
          ? ('full' as const)
          : mapBatchModeToPipelineMode(batch.pipelineMode);
      const run = () =>
        action.type === 'run_pipeline'
          ? params.runPipelineImpl(taskId, chapter, notifyStage, {
              queueClass: 'pipeline',
              queuePriority: 'background',
              foregroundOwner: 'batch',
              pipelineModeOverride: currentPipelineMode,
              pipelineReasoningEffortOverride: batch.reasoningEffort ?? null,
              contextAutomationPolicyV3:
                batch.contextAutomationPolicySnapshot ?? null,
              batchBudgetGate: { batchId },
            })
          : params.resumePipelineImpl(taskId, chapter, notifyStage, {
              queueClass: 'pipeline',
              queuePriority: 'background',
              foregroundOwner: 'batch',
              pipelineModeOverride: currentPipelineMode,
              pipelineReasoningEffortOverride: batch.reasoningEffort ?? null,
              contextAutomationPolicyV3:
                batch.contextAutomationPolicySnapshot ?? null,
              batchBudgetGate: { batchId },
            });
      // BN-09 / BN-10: the main loop renews the lease on every state-machine
      // step (see `claimBatchLease` at the top of the for-loop). A long
      // single-chapter run (120–180s) outlives the 60s TTL, so CL-05 starts a
      // SERIALIZED heartbeat session for the duration of the run — renew at
      // TTL/3 against the latest rowVersion. If the CAS ever loses to another
      // executor, the session marks itself lost and the batch fails closed
      // (no further LLM requests).
      notify(action.type === 'run_pipeline' ? '开始生成当前章' : '恢复当前章');
      const leaseSession = new BatchLeaseSession(batchId, {
        owner: options.owner,
        leaseMs: options.leaseMs ?? DEFAULT_LEASE_MS,
        readBatch: () => getBatchById(batchId),
        claim: claimBatchLease,
      });
      await leaseSession.start();
      try {
        await run();
        // Fail-closed: if the lease was lost while the request ran, another
        // executor owns the batch — stop immediately.
        leaseSession.assertOwned();
      } catch (error: any) {
        // BN-04: typed batch budget overflow — persist the durable pause
        // BEFORE the generic notify so a process kill mid-handler still
        // leaves the batch in a recoverable state.
        if (error instanceof BatchBudgetExceededError) {
          try {
            await updateBatchItem(batchId, batch.currentOrdinal, {
              status: 'blocked_batch_budget',
              errorCode: 'BATCH_SPEND_BUDGET_BLOCKED',
              errorMessage: error.message,
            });
            await updateBatchStatus(batchId, 'paused_batch_budget', {
              errorCode: 'BATCH_SPEND_BUDGET_BLOCKED',
            });
          } catch {
            // best-effort; the next reconcile loop will redo this.
          }
          return 'stop';
        }
        // 单章 pipeline 异常（网络/超时/模型错误）不中断批次循环：下一轮
        // 决策会依据持久化的 task 状态与 attempt 分类自动进入暂停/等待重试，
        // 保证 UI 与真实状态同步（断点续写闭环）。
        notify(`当前章运行失败：${getErrorMessage(error, '未知错误')}`);
      } finally {
        await leaseSession.stop();
      }
      return 'continue';
    }

    case 'pause_legacy_pipeline':
      await updateBatchItem(batchId, action.ordinal, {
        status: 'failed',
        errorCode: 'BATCH_LEGACY_WORKFLOW_BLOCKED',
        errorMessage: '该章使用旧版流水线，不能继续；请按新版重新创建批次。',
      });
      await updateBatchStatus(batchId, 'paused_user', {
        errorCode: 'BATCH_LEGACY_WORKFLOW_BLOCKED',
        errorMessage: '旧版未完成流水线已停止恢复；已完成章节保留，请按新版重新创建剩余章节。',
      });
      return 'stop';

    case 'pause_legacy_batch':
      await updateBatchStatus(batchId, 'paused_user', {
        errorCode: 'BATCH_LEGACY_WORKFLOW_BLOCKED',
        errorMessage:
          '旧版批次已停止执行；已完成章节保留，请按新版重新创建剩余章节。',
      });
      return 'stop';

    case 'wait_until': {
      const remaining = action.timestamp - Date.now();
      // Persist the durable retry schedule BEFORE sleeping so a process
      // exit / cold start can recover from SQLite — the in-memory watchdog
      // is the only thing that knows about `Date.now()`, but the batch
      // UI / cold-start reconciler must read the same source of truth.
      try {
        await updateBatchItem(batchId, batch.currentOrdinal, {
          status: 'waiting_retry',
          nextRetryAt: action.timestamp,
        });
        // Batch header mirrors the waiting state so a paused_* watchdog /
        // cold-start scan can distinguish "running but waiting" from
        // "actively driving" without reading items.
        await updateBatchStatus(batchId, 'waiting_retry');
      } catch {
        // non-fatal — best-effort durability; the item stage attempts
        // already carry nextRetryAt.
      }
      if (remaining > 0) {
        // Cap the in-process wait so the JS thread is not pinned for a
        // long backoff; the page watchdog + cold-start resume re-drive.
        await sleep(Math.min(remaining, WAIT_CHUNK_MS));
        if (Date.now() < action.timestamp) {
          return 'stop';
        }
      }
      return 'continue';
    }

    case 'pause_unknown_outcome':
      await updateBatchItem(batchId, action.ordinal, {
        status: 'outcome_unknown',
        errorCode: 'BATCH_LLM_OUTCOME_UNKNOWN',
        errorMessage: '请求可能已执行，结果未知；请确认后重新执行或更换模型',
      });
      await updateBatchStatus(batchId, 'paused_timeout_unknown', {
        errorCode: 'BATCH_LLM_OUTCOME_UNKNOWN',
      });
      return 'stop';

    case 'pause_task_failed': {
      // 本地确定性失败（未发出任何请求，如上下文/风格校验拦截）：
      // 展示真实原因，不用"结果未知"话术与重复费用警告误导用户。
      const message =
        action.errorMessage || '章节任务在本地校验阶段失败，请查看任务详情';
      await updateBatchItem(batchId, action.ordinal, {
        status: 'failed',
        errorCode: 'BATCH_PIPELINE_FAILED',
        errorMessage: message,
      });
      await updateBatchStatus(batchId, 'paused_user', {
        errorCode: 'BATCH_PIPELINE_FAILED',
        errorMessage: message,
      });
      return 'stop';
    }

    case 'pause_response_invalid':
      await updateBatchItem(batchId, action.ordinal, {
        status: 'failed',
        errorCode: 'BATCH_PIPELINE_FAILED',
        errorMessage:
          '模型已返回，但结构化审查合同无效；已保留已完成阶段，请从失败节点重试，不属于结果未知',
      });
      await updateBatchStatus(batchId, 'paused_user', {
        errorCode: 'BATCH_PIPELINE_FAILED',
        errorMessage: '结构化审查合同无效，请检查模型兼容性后从失败节点重试',
      });
      return 'stop';

    case 'pause_account_quota':
      await updateBatchItem(batchId, action.ordinal, {
        status: 'blocked_account_quota',
        errorCode: 'BATCH_ACCOUNT_QUOTA_BLOCKED',
        errorMessage: '账户额度不足，请充值或更换模型后继续',
      });
      await updateBatchStatus(batchId, 'paused_account_quota', {
        errorCode: 'BATCH_ACCOUNT_QUOTA_BLOCKED',
      });
      return 'stop';

    case 'pause_context_budget':
      await updateBatchItem(batchId, action.ordinal, {
        status: 'blocked_context_budget',
        errorCode: 'BATCH_CONTEXT_BUDGET_BLOCKED',
        errorMessage: '上下文预算不足，模型未调用；请重新弹性编译或更换模型',
      });
      await updateBatchStatus(batchId, 'paused_context_budget', {
        errorCode: 'BATCH_CONTEXT_BUDGET_BLOCKED',
      });
      return 'stop';

    case 'pause_batch_budget':
      await updateBatchItem(batchId, action.ordinal, {
        status: 'blocked_batch_budget',
        errorCode: 'BATCH_SPEND_BUDGET_BLOCKED',
        errorMessage: '批次消耗预算已达上限',
      });
      await updateBatchStatus(batchId, 'paused_batch_budget', {
        errorCode: 'BATCH_SPEND_BUDGET_BLOCKED',
      });
      return 'stop';

    case 'pause_project_changed':
      await updateBatchStatus(batchId, 'paused_project_changed', {
        errorCode: 'BATCH_PROJECT_CHANGED',
      });
      return 'stop';

    case 'adopt_full_result':
    case 'adopt_draft_result': {
      if (currentItem) {
        console.log(
          `[batch-reconcile] adopt ord=${currentItem.ordinal} itemStatus=${
            currentItem.status
          } activeTask=${currentItem.activePipelineTaskId} fp=${
            currentItem.adoptionFingerprint ?? 'null'
          }`,
        );
      }
      return adoptAndCommit(params);
    }

    case 'verify_adoption': {
      if (!currentItem?.chapterId) return 'continue';
      const chapter = await db.getChapterById(currentItem.chapterId);
      const bodyOk = Boolean(
        chapter?.content && String(chapter.content).trim(),
      );
      const fingerprintOk = Boolean(currentItem.adoptionFingerprint);
      if (bodyOk && fingerprintOk) {
        // Commit is idempotent — safe to re-run after a crash.
        await commitBatchItemAdoption({
          batchId,
          ordinal: currentItem.ordinal,
          chapterCount: batch.chapterCount,
          completionQuality: currentItem.completionQuality ?? 'full_pipeline',
          adoptionFingerprint: currentItem.adoptionFingerprint || '',
          adoptedRevisionId: currentItem.adoptedRevisionId,
        });
        return 'continue';
      }
      // Body never landed — re-adopt from the completed task.
      if (currentItem.activePipelineTaskId) {
        return adoptAndCommit(params);
      }
      return 'continue';
    }

    case 'advance':
      return 'continue';

    case 'complete_batch':
      await updateBatchStatus(batchId, 'completed', {
        completedAt: Date.now(),
      });
      return 'stop';

    case 'no_op':
      return 'break';
  }
}

async function adoptAndCommit(params: {
  batchId: string;
  batch: MultiChapterBatchRow;
  currentItem: MultiChapterBatchItemRow | undefined;
  action: MultiChapterBatchAction;
  options: ReconcileMultiChapterBatchOptions;
}): Promise<'continue' | 'break' | 'stop'> {
  const { batchId, batch, currentItem, action } = params;
  if (!currentItem?.chapterId || !currentItem.activePipelineTaskId) {
    return 'continue';
  }
  const taskId = currentItem.activePipelineTaskId;

  const quality: BatchItemCompletionQuality =
    action.type === 'adopt_draft_result' ? 'draft_only' : 'full_pipeline';

  // CL-07: ONE transaction closes the adoption loop — old-body revision,
  // chapter.content, pipeline revision, item fingerprint/adoptedRevisionId
  // AND batch counters. A crash mid-adoption rolls back everything; the
  // idempotency fingerprint still makes repeated reconcile a no-op.
  const adopted = await adoptPipelineTaskResultAtomic({
    taskId,
    chapterId: currentItem.chapterId,
    source: 'multi_chapter_batch',
    batchId,
    ordinal: currentItem.ordinal,
    completionQuality: quality,
    chapterCount: batch.chapterCount,
  });
  void adopted;

  // Cross-task, cross-run, crash-safe usage aggregation (BN-03). SET
  // (not increment) — repeated reconcile produces the same value.
  try {
    await setBatchUsageFromRuns(batchId);
  } catch {
    // non-fatal — batch header is informational; per-attempt billing
    // still recorded in pipeline_stage_attempts.
  }
  return 'continue';
}

/** Build the structured batch writing instruction (stored in summary_json). */
export function buildBatchChapterInstruction(
  batch: MultiChapterBatchRow,
  item: MultiChapterBatchItemRow,
): string {
  const beats = (() => {
    try {
      const parsed = JSON.parse(item.keyBeatsJson || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })() as string[];
  const parts: string[] = [];
  if (batch.sourcePrompt) {
    parts.push(`【批次总目标】\n${batch.sourcePrompt}`);
  }
  if (beats.length > 0) {
    parts.push(`【必须发生】\n${beats.map(b => `- ${b}`).join('\n')}`);
  }
  if (item.carryIn) parts.push(`【承接前文】\n${item.carryIn}`);
  if (item.carryOut) parts.push(`【交给下一章】\n${item.carryOut}`);
  parts.push(`【目标字数】\n约 ${item.targetWords} 字`);
  return parts.join('\n\n');
}
