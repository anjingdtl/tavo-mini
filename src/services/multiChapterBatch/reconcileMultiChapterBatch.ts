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
  incrementBatchUsage,
  commitBatchItemAdoption,
  type MultiChapterBatchItemRow,
  type MultiChapterBatchRow,
} from '../../data/repositories/multiChapterBatchRepository';
import { getPipelineTaskById } from '../../data/repositories/pipelineTaskRepository';
import { getLatestAttemptByTask } from '../../data/repositories/pipelineStageAttemptRepository';
import { getChaptersByProject } from '../../data/repositories/projectRepository';
import {
  determineNextBatchAction,
  type MultiChapterBatchAction,
} from './determineNextBatchAction';
import { adoptPipelineTaskResult } from './batchAdoption';
import { MultiChapterBatchError } from './errors';
import { runChapterPipeline, resumePipeline } from '../pipelineRunner';
import type { PipelineCheckpointStage } from '../pipeline/types';
import type { BatchItemCompletionQuality } from '../../types/multiChapterBatch';

export interface BatchProgressInfo {
  batchId: string;
  status: string;
  currentOrdinal: number;
  completedCount: number;
  chapterCount: number;
  itemStatus?: string;
  taskStatus?: string;
  message?: string;
}

export interface ReconcileMultiChapterBatchOptions {
  /** Lease owner token (instance id). Required for CAS. */
  owner: string;
  leaseMs?: number;
  onProgress?: (info: BatchProgressInfo) => void;
  /** Injectable pipeline runners (tests replace these). */
  runPipeline?: typeof runChapterPipeline;
  resumePipeline?: typeof resumePipeline;
  maxSteps?: number;
}

const DEFAULT_LEASE_MS = 60_000;
const MAX_STEPS = 200;
const WAIT_CHUNK_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Load the persisted status of the current item's pipeline task. */
async function loadTaskStatuses(
  item: MultiChapterBatchItemRow | undefined,
): Promise<Record<string, string>> {
  if (!item?.activePipelineTaskId) return {};
  const task = await getPipelineTaskById(item.activePipelineTaskId);
  return task ? { [item.activePipelineTaskId]: String(task.status) } : {};
}

async function loadLatestAttempts(
  item: MultiChapterBatchItemRow | undefined,
): Promise<Record<string, unknown>> {
  if (!item?.activePipelineTaskId) return {};
  const attempt = await getLatestAttemptByTask(item.activePipelineTaskId);
  return { [item.activePipelineTaskId]: attempt };
}

/** Detect unexpected insertion/reorder at the project tail (doc §25). */
async function checkProjectTailDrift(batch: MultiChapterBatchRow): Promise<boolean> {
  if (batch.startPosition == null) return false;
  const chapters = await getChaptersByProject(batch.projectId);
  const tail = chapters.length > 0
    ? Math.max(...chapters.map(c => c.position))
    : -1;
  const expectedTail = batch.startPosition + batch.completedCount;
  return tail !== expectedTail;
}

export async function reconcileMultiChapterBatch(
  batchId: string,
  options: ReconcileMultiChapterBatchOptions,
): Promise<void> {
  const owner = options.owner;
  const runPipelineImpl = options.runPipeline ?? runChapterPipeline;
  const resumePipelineImpl = options.resumePipeline ?? resumePipeline;
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
      if (!batch) throw new MultiChapterBatchError('BATCH_NOT_FOUND', '批次不存在');
      if (['completed', 'cancelled', 'failed'].includes(batch.status)) {
        return;
      }
      if (batch.status.startsWith('paused_')) {
        return; // user/pause action required
      }
      const items = await getBatchItems(batchId);
      const currentItem = items.find(i => i.ordinal === batch.currentOrdinal);
      const taskStatuses = await loadTaskStatuses(currentItem);
      const latestAttempts = (await loadLatestAttempts(currentItem)) as Record<
        string,
        any
      >;

      const action = determineNextBatchAction({
        batch,
        items,
        taskStatuses,
        latestAttempts,
      });

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
  runPipelineImpl: typeof runChapterPipeline;
  resumePipelineImpl: typeof resumePipeline;
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
        synopsis: buildChapterSynopsis(batch, currentItem),
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
      await updateBatchItem(batchId, currentItem.ordinal, {
        status: 'creating_pipeline_task',
      });
      const taskId = `batch_${batchId}_ord${currentItem.ordinal}_${Date.now()}`;
      const now = Date.now();
      const stages: PipelineCheckpointStage[] = ['draft', 'review', 'factCheck', 'proof'];
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
          createdAt: now,
          updatedAt: now,
          resolvedAt: null,
        },
        stages,
        runNo: currentItem.activeRunNo + 1,
        llmConfigSnapshotJson: '{}',
        reason: 'batch_start',
      });
      notify(`已创建第 ${currentItem.ordinal} 章流水线任务`);
      return 'continue';
    }

    case 'run_pipeline':
    case 'resume_pipeline': {
      if (!currentItem || !currentItem.chapterId || !currentItem.activePipelineTaskId) {
        return 'continue';
      }
      const chapter = await db.getChapterById(currentItem.chapterId);
      if (!chapter) {
        await updateBatchStatus(batchId, 'paused_project_changed', {
          errorCode: 'BATCH_PROJECT_CHANGED',
          errorMessage: '当前章节已被删除',
        });
        return 'stop';
      }
      const taskId = currentItem.activePipelineTaskId;
      const run = () =>
        action.type === 'run_pipeline'
          ? params.runPipelineImpl(taskId, chapter, undefined, {
              queueClass: 'pipeline',
              queuePriority: 'background',
            })
          : params.resumePipelineImpl(taskId, chapter, undefined, {
              queueClass: 'pipeline',
              queuePriority: 'background',
            });
      notify(action.type === 'run_pipeline' ? '开始生成当前章' : '恢复当前章');
      await run();
      return 'continue';
    }

    case 'wait_until': {
      const remaining = action.timestamp - Date.now();
      if (remaining > 0) {
        await sleep(Math.min(remaining, WAIT_CHUNK_MS));
        if (Date.now() < action.timestamp) {
          // Still not due — hand back; next reconcile (or cold start) re-checks
          // the persisted next_retry_at.
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
    case 'adopt_draft_result':
      return adoptAndCommit(params);

    case 'verify_adoption': {
      if (!currentItem?.chapterId) return 'continue';
      const chapter = await db.getChapterById(currentItem.chapterId);
      const bodyOk = Boolean(chapter?.content && String(chapter.content).trim());
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
  const task = await getPipelineTaskById(taskId);
  if (!task) return 'continue';

  const quality: BatchItemCompletionQuality =
    action.type === 'adopt_draft_result' ? 'draft_only' : 'full_pipeline';

  const adopted = await adoptPipelineTaskResult({
    taskId,
    chapterId: currentItem.chapterId,
    source: 'multi_chapter_batch',
    batchId,
    ordinal: currentItem.ordinal,
    completionQuality: quality,
  });

  // Persist the idempotency fingerprint BEFORE committing counters.
  await updateBatchItem(batchId, currentItem.ordinal, {
    status: 'adopting',
    adoptionFingerprint: adopted.adoptionFingerprint,
    adoptedRevisionId: adopted.adoptedRevisionId,
    completionQuality: quality,
  });
  await commitBatchItemAdoption({
    batchId,
    ordinal: currentItem.ordinal,
    chapterCount: batch.chapterCount,
    completionQuality: quality,
    adoptionFingerprint: adopted.adoptionFingerprint,
    adoptedRevisionId: adopted.adoptedRevisionId,
  });

  // Reflect pipeline token usage into the batch budget.
  try {
    const usage = summarizeTaskUsage(task);
    await incrementBatchUsage(batchId, usage);
  } catch {
    // non-fatal
  }
  return 'continue';
}

function summarizeTaskUsage(task: any): {
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
} {
  const stages = Array.isArray(task.stageResults) ? task.stageResults : [];
  let llmCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const stage of stages) {
    if (stage?.status === 'success' || stage?.status === 'succeeded') {
      llmCalls += 1;
      inputTokens += Number(stage.tokens?.input ?? 0);
      outputTokens += Number(stage.tokens?.output ?? 0);
    }
  }
  return { llmCalls, inputTokens, outputTokens };
}

/** Build the structured chapter synopsis from plan item (doc §8). */
export function buildChapterSynopsis(
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
  const parts = [
    `【批次总目标】\n${batch.sourcePrompt}`,
    `【本章目标】\n${item.synopsis}`,
  ];
  if (beats.length > 0) {
    parts.push(`【必须发生】\n${beats.map(b => `- ${b}`).join('\n')}`);
  }
  if (item.carryIn) parts.push(`【承接前文】\n${item.carryIn}`);
  if (item.carryOut) parts.push(`【交给下一章】\n${item.carryOut}`);
  parts.push(`【目标字数】\n约 ${item.targetWords} 字`);
  return parts.join('\n\n');
}
