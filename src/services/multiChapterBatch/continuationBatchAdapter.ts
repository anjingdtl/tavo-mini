/**
 * Continuation batch execution adapter (doc §11–§26).
 *
 * Mode-aware execution kernel for batches with writing_mode='continuation'.
 * The outline reconciler delegates each state-machine step here; the outline
 * branch itself stays untouched. Per chapter the adapter drives:
 *
 *   create chapter (continuation numbering)
 *   → startContinuationRun (V5, current-chapter instruction ONLY)
 *   → atomic bind active_continuation_run_id
 *   → observe (interrupted ⇒ restart through Writing Kernel)
 *   → eligible final ⇒ adoptArtifactAsDraft (never force / never open-checks)
 *   → finalizeContinuationChapter
 *   → state freshness gate
 *   → commit item success + advance
 *
 * Hard invariants (doc §23, §25, §33):
 *   - never a second run while active_continuation_run_id is set;
 *   - no auto retry after failed/awaiting_regeneration — new runs require
 *     explicit user resume;
 *   - strictly one chapter at a time (single lease + single currentOrdinal);
 *   - the adapter never compiles V5 prompts itself.
 */
import {
  getBatchItem,
  getBatchItems,
  getBatchById,
  updateBatchItem,
  updateBatchStatus,
  createBatchChapterForItem,
  bindContinuationRunForItem,
  claimBatchLease,
  commitBatchItemAdoption,
  type MultiChapterBatchRow,
  type MultiChapterBatchItemRow,
} from '../../data/repositories/multiChapterBatchRepository';
import {
  cancelContinuationRun,
  adoptArtifactAsDraft,
  finalizeContinuationChapter,
} from '../writing/persist/continuationAdoption';
import { runContinuationWritingKernel } from '../writing';
import { createContinuationBatchTraceId } from '../continuation/generation/continuationGenerationTrace';
import type { StageLlmCaller } from '../writing/scenario/continuationWritingTypes';
import {
  getRunById,
  listRunsForProject,
  getLatestArtifactForStage,
  listChecksForArtifact,
  contentRevisionHash,
} from '../continuation/generation/generationRepository';
import type {
  ContinuationGenerationRun,
  ContinuationArtifact,
} from '../continuation/generation/types';
import {
  ContinuationConflictError,
  ContinuationOutdatedError,
} from '../continuation/generation/types';
import * as db from '../database';
import { sha256Hex } from '../continuation/hashUtils';
import { MultiChapterBatchError } from './errors';
import { BatchLeaseSession } from './leaseSession';
import {
  decodeContinuationBatchAnchor,
  decodeContinuationBatchExecutionPolicy,
} from './batchMode';
import { buildContinuationBatchChapterInstruction } from './continuationBatchInstruction';
import {
  checkNextChapterReady,
  checkContinuationTailDrift,
  accelerateContinuationOutbox,
} from './continuationBatchStateGate';
import { setBatchUsageFromContinuationRuns } from './continuationBatchUsage';
import {
  getNextContinuationChapterPosition,
  getContinuationChapterNumbering,
  isAutoChapterTitle,
} from '../continuation/chapterNumbering/continuationChapterNumbering';
import { continuationSourceReader } from '../continuation/continuationSourceReader';
import { CanonQueryService } from '../continuation/canon/canonQueryService';
import type { ContinuationBatchAnchorV1 } from '../../types/multiChapterBatch';
import type { ReconcileProgressSink } from './continuationBatchTypes';

export type { ReconcileProgressSink };

const RUN_OBSERVE_POLL_MS = 1500;
const RUN_OBSERVE_TIMEOUT_MS = 20 * 60 * 1000;

export interface ContinuationBatchStepOptions {
  owner: string;
  leaseMs?: number;
  onProgress?: ReconcileProgressSink;
  /** Test injector forwarded to the Writing Kernel continuation driver. */
  callStage?: StageLlmCaller;
  /** Test injector for the bounded observe sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getErrorMessage(error: any, fallback: string): string {
  return error?.message ? String(error.message) : fallback;
}

export type ContinuationStepResult = 'continue' | 'break' | 'stop';

/** Adoption fingerprint for a continuation item (doc §23 idempotency). */
export function computeContinuationAdoptionFingerprint(params: {
  batchId: string;
  ordinal: number;
  chapterId: number;
  continuationRunId: string;
  finalContentHash: string;
}): string {
  return sha256Hex(
    [
      params.batchId,
      params.ordinal,
      params.chapterId,
      params.continuationRunId,
      params.finalContentHash,
    ].join('|'),
  ).slice(0, 32);
}

/**
 * Internal observation type (doc §12). Maps a ContinuationRunState onto the
 * batch's mode-aware item lifecycle.
 */
export type BatchExecutionObservation =
  | { status: 'running'; stage?: string }
  | { status: 'awaiting_adoption'; runId: string }
  | { status: 'awaiting_regeneration'; reason: string }
  | { status: 'failed'; reason: string }
  | { status: 'outdated'; reason: string }
  | { status: 'cancelled'; reason: string }
  | { status: 'interrupted'; reason: string }
  | { status: 'adopted'; runId: string }
  | { status: 'abandoned'; reason: string };

export function observeContinuationRun(
  run: Pick<ContinuationGenerationRun, 'state' | 'stage' | 'completionReason' | 'errorMessage'>,
): BatchExecutionObservation {
  switch (run.state) {
    case 'queued':
    case 'running':
      return { status: 'running', stage: run.stage };
    case 'awaiting_user':
      return { status: 'awaiting_adoption', runId: '' };
    case 'awaiting_regeneration':
      return { status: 'awaiting_regeneration', reason: run.errorMessage || '最终稿未形成可交付结果' };
    case 'failed':
      return { status: 'failed', reason: run.errorMessage || '续写运行失败' };
    case 'outdated':
      return { status: 'outdated', reason: run.errorMessage || '原著或 Canon 已更新' };
    case 'cancelled':
      return { status: 'cancelled', reason: run.errorMessage || '续写已取消' };
    case 'interrupted':
      return { status: 'interrupted', reason: run.errorMessage || '续写被中断' };
    case 'completed':
      return run.completionReason === 'adopted'
        ? { status: 'adopted', runId: '' }
        : { status: 'abandoned', reason: '续写结果已被放弃' };
  }
}

interface AnchorDriftResult {
  ok: boolean;
  errorCode?: string;
  message?: string;
}

/** Pre-start drift guard (doc §20): anchor vs live Source/Canon/tail.
 *
 * `inFlightChapters` counts the current item's created-but-unfinished
 * chapter so the tail expectation stays correct mid-chapter.
 */
export async function checkContinuationAnchorDrift(params: {
  projectId: number;
  anchor: ContinuationBatchAnchorV1 | null;
  completedCount: number;
  inFlightChapters?: number;
}): Promise<AnchorDriftResult> {
  const { anchor } = params;
  if (!anchor) {
    return {
      ok: false,
      errorCode: 'BATCH_PROJECT_CHANGED',
      message: '续写批次锚点缺失，无法继续执行',
    };
  }
  if (
    await checkContinuationTailDrift({
      projectId: params.projectId,
      anchor,
      completedCount: params.completedCount,
      inFlightChapters: params.inFlightChapters ?? 0,
    })
  ) {
    return {
      ok: false,
      errorCode: 'BATCH_PROJECT_CHANGED',
      message: '项目章节末尾已变化，请确认继续方式',
    };
  }
  try {
    const snapshot = await continuationSourceReader.getSnapshot(params.projectId);
    if (Number(snapshot.sourceId) !== Number(anchor.sourceId)) {
      return {
        ok: false,
        errorCode: 'BATCH_CONTINUATION_SOURCE_CHANGED',
        message: '续写原著源已更换，批次已停止',
      };
    }
    if (
      Number(snapshot.sourceVersion) !== Number(anchor.sourceVersion) ||
      snapshot.normalizedSha256 !== anchor.sourceSha256
    ) {
      return {
        ok: false,
        errorCode: 'BATCH_CONTINUATION_SOURCE_CHANGED',
        message: '续写原著内容已更新，批次已停止',
      };
    }
    if (
      Number(snapshot.boundary.chapterPosition) !== Number(anchor.boundaryPosition) ||
      Number(snapshot.boundary.charOffsetExclusive) !==
        Number(anchor.boundaryCharOffsetExclusive)
    ) {
      return {
        ok: false,
        errorCode: 'BATCH_CONTINUATION_BOUNDARY_CHANGED',
        message: '续写起点（边界）已变化，批次已停止',
      };
    }
  } catch {
    return {
      ok: false,
      errorCode: 'BATCH_CONTINUATION_SOURCE_CHANGED',
      message: '续写原著源不可用，批次已停止',
    };
  }
  try {
    const canon = await CanonQueryService.getActiveSnapshot(params.projectId);
    if (String(canon.id) !== String(anchor.canonSnapshotId)) {
      return {
        ok: false,
        errorCode: 'BATCH_CONTINUATION_CANON_CHANGED',
        message: 'Canon 快照已变化，批次已停止',
      };
    }
    if (Number(canon.revision) !== Number(anchor.canonRevision)) {
      return {
        ok: false,
        errorCode: 'BATCH_CONTINUATION_CANON_CHANGED',
        message: 'Canon 版本已变化，批次已停止',
      };
    }
  } catch {
    return {
      ok: false,
      errorCode: 'BATCH_CONTINUATION_CANON_CHANGED',
      message: 'Canon 快照不可用，批次已停止',
    };
  }
  return { ok: true };
}

/**
 * One state-machine step for a continuation batch. Called from the outline
 * reconciler loop (which owns the lease, terminal/pause short-circuits and
 * step budget).
 */
export async function executeContinuationBatchStep(params: {
  batchId: string;
  batch: MultiChapterBatchRow;
  items: MultiChapterBatchItemRow[];
  options: ContinuationBatchStepOptions;
}): Promise<ContinuationStepResult> {
  const { batchId, batch, items, options } = params;
  const notify = (message: string, stage?: string) => {
    options.onProgress?.({
      batchId,
      status: batch.status,
      currentOrdinal: batch.currentOrdinal,
      completedCount: batch.completedCount,
      chapterCount: batch.chapterCount,
      stage,
      message,
    });
  };

  if (batch.status === 'draft') {
    throw new MultiChapterBatchError(
      'BATCH_PLAN_INVALID',
      '批次尚未规划，请先完成规划并确认',
    );
  }
  if (batch.status === 'planning') {
    notify('等待计划确认');
    return 'stop';
  }

  // Batch budget hard caps — same policy as the outline path (doc §26 keeps
  // the caps; only the aggregation source differs).
  if (
    (batch.maxLlmCalls != null && batch.usedLlmCalls >= batch.maxLlmCalls) ||
    (batch.maxInputTokens != null && batch.usedInputTokens >= batch.maxInputTokens) ||
    (batch.maxOutputTokens != null && batch.usedOutputTokens >= batch.maxOutputTokens)
  ) {
    await updateBatchItem(batchId, batch.currentOrdinal, {
      status: 'blocked_batch_budget',
      errorCode: 'BATCH_SPEND_BUDGET_BLOCKED',
      errorMessage: '批次消耗预算已达上限',
    });
    await updateBatchStatus(batchId, 'paused_batch_budget', {
      errorCode: 'BATCH_SPEND_BUDGET_BLOCKED',
    });
    return 'stop';
  }

  const currentItem = items.find(i => i.ordinal === batch.currentOrdinal);
  if (!currentItem) {
    if (batch.completedCount >= batch.chapterCount) {
      await setBatchUsageFromContinuationRuns(batchId, items).catch(() => {});
      await updateBatchStatus(batchId, 'completed', { completedAt: Date.now() });
      return 'stop';
    }
    return 'break';
  }

  return executeContinuationItemStep({
    batchId,
    batch,
    currentItem,
    options,
    notify,
  });
}

async function pauseBatchForItem(
  batchId: string,
  item: MultiChapterBatchItemRow,
  errorCode: string,
  message: string,
  batchStatus: 'paused_user' | 'paused_project_changed' = 'paused_user',
): Promise<ContinuationStepResult> {
  await updateBatchItem(batchId, item.ordinal, {
    status: 'failed',
    errorCode,
    errorMessage: message,
    nextRetryAt: null,
  });
  await updateBatchStatus(batchId, batchStatus, { errorCode, errorMessage: message });
  return 'stop';
}

async function executeContinuationItemStep(params: {
  batchId: string;
  batch: MultiChapterBatchRow;
  currentItem: MultiChapterBatchItemRow;
  options: ContinuationBatchStepOptions;
  notify: (message: string, stage?: string) => void;
}): Promise<ContinuationStepResult> {
  const { batchId, batch, currentItem, options, notify } = params;
  const anchor = decodeContinuationBatchAnchor(batch.continuationAnchorJson);
  const policy = decodeContinuationBatchExecutionPolicy(
    batch.continuationExecutionPolicyJson,
  );

  switch (currentItem.status) {
    case 'pending':
    case 'creating_chapter': {
      if (currentItem.chapterId != null) {
        await updateBatchItem(batchId, currentItem.ordinal, {
          status: 'chapter_ready',
        });
        return 'continue';
      }
      const drift = await checkContinuationAnchorDrift({
        projectId: batch.projectId,
        anchor,
        completedCount: batch.completedCount,
      });
      if (!drift.ok) {
        return pauseBatchForItem(
          batchId,
          currentItem,
          drift.errorCode || 'BATCH_PROJECT_CHANGED',
          drift.message || '项目状态已变化',
          'paused_project_changed',
        );
      }
      await updateBatchItem(batchId, currentItem.ordinal, {
        status: 'creating_chapter',
      });
      // Continuation numbering (doc §10): position from max+1, display title
      // from the boundary-aware numbering service. Planner custom titles are
      // preserved; pure auto titles follow the continuation numbering.
      const position = await getNextContinuationChapterPosition(batch.projectId);
      const numbering = await getContinuationChapterNumbering(batch.projectId);
      const title =
        currentItem.title && !isAutoChapterTitle(currentItem.title)
          ? currentItem.title
          : numbering.getDefaultTitle(position);
      await createBatchChapterForItem(batchId, currentItem.ordinal, {
        projectId: batch.projectId,
        position: Number(position),
        title,
        synopsis: currentItem.synopsis,
        summaryJson: JSON.stringify({
          batch_instruction: buildContinuationBatchChapterInstruction(
            batch,
            currentItem,
          ),
        }),
      });
      notify(`已创建续写章节（批次 ${currentItem.ordinal}/${batch.chapterCount}）`);
      return 'continue';
    }

    case 'chapter_ready':
    case 'creating_pipeline_task': {
      if (currentItem.activeContinuationRunId != null) {
        await updateBatchItem(batchId, currentItem.ordinal, {
          status: 'running_pipeline',
        });
        return 'continue';
      }
      if (currentItem.chapterId == null) {
        await updateBatchItem(batchId, currentItem.ordinal, { status: 'pending' });
        return 'continue';
      }
      // FI-02 crash window recovery: a run row may exist for this chapter
      // even though the binding never landed. Re-adopt the newest run for
      // the chapter instead of creating a second one (doc §22 case B/C).
      // chapter_ready = rearm semantics (terminal runs were explicitly
      // abandoned); creating_pipeline_task = mid-start crash semantics.
      const recovered = await recoverUnboundRunForChapter(
        {
          batchId,
          batch,
          item: currentItem,
        },
        currentItem.status === 'chapter_ready' ? 'rearm' : 'recovery',
      );
      if (recovered === 'handled') {
        return 'continue';
      }
      if (recovered === 'pause') {
        return 'stop';
      }
      const drift = await checkContinuationAnchorDrift({
        projectId: batch.projectId,
        anchor,
        completedCount: batch.completedCount,
        // The current item's chapter already exists at the tail.
        inFlightChapters: 1,
      });
      if (!drift.ok) {
        return pauseBatchForItem(
          batchId,
          currentItem,
          drift.errorCode || 'BATCH_PROJECT_CHANGED',
          drift.message || '项目状态已变化',
          'paused_project_changed',
        );
      }
      const chapter = await db.getChapterById(currentItem.chapterId);
      if (!chapter) {
        return pauseBatchForItem(
          batchId,
          currentItem,
          'BATCH_PROJECT_CHANGED',
          '当前章节已被删除',
          'paused_project_changed',
        );
      }
      await updateBatchItem(batchId, currentItem.ordinal, {
        status: 'creating_pipeline_task',
      });
      notify(
        `开始生成第 ${currentItem.ordinal}/${batch.chapterCount} 章续写`,
        'draft_writer',
      );
      // Current-chapter projection ONLY (doc §8): future item details never
      // enter the instruction.
      const userInstruction = buildContinuationBatchChapterInstruction(
        batch,
        currentItem,
      );
      const run = await runContinuationWritingKernel({
        projectId: batch.projectId,
        chapterId: currentItem.chapterId,
        targetPosition: Number(chapter.position),
        userInstruction,
        currentChapterContent: '',
        callStage: options.callStage,
        batchTraceId: createContinuationBatchTraceId(batchId),
        chapterOrdinal: currentItem.ordinal,
        chapterCount: batch.chapterCount,
        // Batch-frozen One-Shot (极速) profile (Schema 54).
        executionProfile:
          batch.executionProfile === 'one_shot' ? 'one_shot' : 'standard',
      });
      const bound = await bindContinuationRunForItem({
        batchId,
        ordinal: currentItem.ordinal,
        chapterId: currentItem.chapterId,
        continuationRunId: run.id,
        status: 'running_pipeline',
      });
      if (!bound) {
        // Another binding landed concurrently — the just-created run must
        // not survive as an orphan; cancel it (no adoption has happened).
        await cancelContinuationRun(run.id).catch(() => {});
        return 'continue';
      }
      return 'continue';
    }

    case 'running_pipeline':
    case 'waiting_retry':
    case 'outcome_unknown': {
      if (currentItem.chapterId == null) {
        return pauseBatchForItem(
          batchId,
          currentItem,
          'BATCH_PROJECT_CHANGED',
          '当前章节已被删除',
          'paused_project_changed',
        );
      }
      if (currentItem.activeContinuationRunId == null) {
        await updateBatchItem(batchId, currentItem.ordinal, {
          status: 'chapter_ready',
        });
        return 'continue';
      }
      return driveRunToSettlement({
        batchId,
        batch,
        item: currentItem,
        anchor,
        policy,
        options,
        notify,
      });
    }

    case 'adopting': {
      return finalizeAndGate({
        batchId,
        batch,
        item: currentItem,
        anchor,
        policy,
        options,
        notify,
      });
    }

    case 'succeeded':
    case 'succeeded_with_draft':
    case 'succeeded_with_user_text':
      notify(`第 ${currentItem.ordinal}/${batch.chapterCount} 章完成`);
      return 'continue';

    case 'failed':
      // Batch-level pause already persisted by the failure path.
      return 'stop';

    case 'blocked_context_budget':
    case 'blocked_account_quota':
    case 'blocked_batch_budget':
      return 'stop';

    case 'cancelled':
      return 'break';
  }
}

/**
 * FI-02 recovery: item unbound but a run row exists for its chapter.
 *  - 'recovery' (item was mid-start when the process died): rebind live /
 *    adopted runs; a terminal-unusable run pauses for the user.
 *  - 'rearm' (user explicitly resumed and the binding was deliberately
 *    cleared): terminal-unusable runs are skipped — a fresh run may start.
 * Returns 'handled' when the item state was repaired, 'pause' when the found
 * run is terminal-unusable, 'none' when no usable run exists.
 */
async function recoverUnboundRunForChapter(
  params: {
    batchId: string;
    batch: MultiChapterBatchRow;
    item: MultiChapterBatchItemRow;
  },
  mode: 'recovery' | 'rearm' = 'recovery',
): Promise<'handled' | 'pause' | 'none'> {
  const { batchId, batch, item } = params;
  if (item.chapterId == null) return 'none';
  const runs = await listRunsForProject(batch.projectId, 50);
  const chapterRuns = runs
    .filter(run => Number(run.chapterId) === Number(item.chapterId))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  if (chapterRuns.length === 0) return 'none';
  const newest = chapterRuns[0];
  const reusableOnThisPass =
    newest.state === 'queued' ||
    newest.state === 'running' ||
    newest.state === 'awaiting_user' ||
    newest.state === 'interrupted' ||
    (newest.state === 'awaiting_regeneration' && mode !== 'rearm');
  if (reusableOnThisPass) {
    const bound = await bindContinuationRunForItem({
      batchId,
      ordinal: item.ordinal,
      chapterId: item.chapterId,
      continuationRunId: newest.id,
      status: 'running_pipeline',
    });
    if (!bound) return 'handled'; // concurrent repair already landed
    return 'handled';
  }
  if (newest.state === 'completed' && newest.completionReason === 'adopted') {
    await updateBatchItem(batchId, item.ordinal, {
      activeContinuationRunId: newest.id,
      status: 'adopting',
    });
    return 'handled';
  }
  if (mode === 'rearm') {
    // The rearm path already decided this run is dead; start fresh.
    return 'none';
  }
  await pauseBatchForItem(
    batchId,
    item,
    newest.state === 'outdated'
      ? 'BATCH_CONTINUATION_RUN_OUTDATED'
      : 'BATCH_CONTINUATION_RUN_FAILED',
    `检测到未绑定的续写记录（状态 ${newest.state}），请从暂停页选择继续方式`,
  );
  return 'pause';
}

async function driveRunToSettlement(params: {
  batchId: string;
  batch: MultiChapterBatchRow;
  item: MultiChapterBatchItemRow;
  anchor: ContinuationBatchAnchorV1 | null;
  policy: ReturnType<typeof decodeContinuationBatchExecutionPolicy>;
  options: ContinuationBatchStepOptions;
  notify: (message: string, stage?: string) => void;
}): Promise<ContinuationStepResult> {
  const { batchId, batch, item, options, notify } = params;
  const run = await getRunById(item.activeContinuationRunId!);
  if (!run) {
    return pauseBatchForItem(
      batchId,
      item,
      'BATCH_CONTINUATION_RUN_FAILED',
      '续写运行记录缺失，请重新发起本章',
    );
  }

  const observation = observeContinuationRun(run);
  switch (observation.status) {
    case 'running': {
      notify(
        `第 ${batch.currentOrdinal}/${batch.chapterCount} 章续写生成中`,
        run.stage,
      );
      await waitForRunSettlement({
        batchId,
        runId: run.id,
        options,
        notify,
      });
      return 'continue';
    }
    case 'interrupted': {
      // Execution Compatibility = NO: restart semantic input through a new
      // Kernel run instead of resuming the old runtime state.
      notify('按新版 Writing Kernel 重启被中断的续写', run.stage);
      try {
        const chapter = await db.getChapterById(run.chapterId);
        if (!chapter) throw new Error('章节不存在');
        const restarted = await runContinuationWritingKernel({
          projectId: run.projectId,
          chapterId: run.chapterId,
          targetPosition: Number(run.targetPosition),
          userInstruction:
            run.userInstruction || chapter.synopsis || chapter.title || '按当前章节边界续写。',
          currentChapterContent: chapter.content || '',
          callStage: options.callStage,
          // Batch-frozen One-Shot (极速) profile (Schema 54); restart keeps
          // the batch's frozen execution strategy.
          executionProfile:
            batch.executionProfile === 'one_shot' ? 'one_shot' : 'standard',
        });
        await cancelContinuationRun(run.id).catch(() => {});
        await updateBatchItem(batchId, item.ordinal, {
          activeContinuationRunId: null,
          status: 'creating_pipeline_task',
        });
        const rebound = await bindContinuationRunForItem({
          batchId,
          ordinal: item.ordinal,
          chapterId: item.chapterId!,
          continuationRunId: restarted.id,
          status: 'running_pipeline',
        });
        if (!rebound) {
          await cancelContinuationRun(restarted.id).catch(() => {});
          throw new Error('批次续写运行绑定冲突');
        }
      } catch (error: any) {
        return pauseBatchForItem(
          batchId,
          item,
          'BATCH_CONTINUATION_RUN_FAILED',
          `重启续写失败：${getErrorMessage(error, '未知错误')}`,
        );
      }
      return 'continue';
    }
    case 'awaiting_adoption': {
      return autoAdoptEligibleFinal({ batchId, batch, item, run, notify });
    }
    case 'adopted': {
      // Case E/F: adoption committed (possibly by the single-chapter UI or a
      // crashed previous step) — continue the finalize chain.
      await updateBatchItem(batchId, item.ordinal, { status: 'adopting' });
      return 'continue';
    }
    case 'awaiting_regeneration': {
      return pauseBatchForItem(
        batchId,
        item,
        'BATCH_CONTINUATION_FINAL_REJECTED',
        '最终稿未形成可交付结果，需要人工重新生成',
      );
    }
    case 'failed': {
      return pauseBatchForItem(
        batchId,
        item,
        'BATCH_CONTINUATION_RUN_FAILED',
        `续写运行失败：${observation.reason}`,
      );
    }
    case 'outdated': {
      return pauseBatchForItem(
        batchId,
        item,
        'BATCH_CONTINUATION_RUN_OUTDATED',
        `续写已过期：${observation.reason}`,
      );
    }
    case 'cancelled': {
      return pauseBatchForItem(
        batchId,
        item,
        'BATCH_CONTINUATION_RUN_FAILED',
        '本章续写已被取消；恢复批次后将重新发起本章',
      );
    }
    case 'abandoned': {
      return pauseBatchForItem(
        batchId,
        item,
        'BATCH_CONTINUATION_RUN_FAILED',
        '本章续写结果已被放弃；恢复批次后将重新发起本章',
      );
    }
  }
}

/**
 * Bounded in-step wait for the current run to leave running/queued (doc §17
 * spirit: bounded, cancellable, deadline). The lease heartbeat keeps the
 * batch owned for the whole wait, mirroring the outline run_pipeline step.
 */
async function waitForRunSettlement(params: {
  batchId: string;
  runId: string;
  options: ContinuationBatchStepOptions;
  notify: (message: string, stage?: string) => void;
}): Promise<void> {
  const sleepImpl = params.options.sleepImpl ?? defaultSleep;
  const leaseSession = new BatchLeaseSession(params.batchId, {
    owner: params.options.owner,
    leaseMs: params.options.leaseMs ?? 60_000,
    readBatch: () => getBatchById(params.batchId),
    claim: claimBatchLease,
  });
  await leaseSession.start();
  const deadline = Date.now() + RUN_OBSERVE_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      leaseSession.assertOwned();
      const run = await getRunById(params.runId);
      if (!run) return;
      if (run.state !== 'queued' && run.state !== 'running') {
        params.notify(`续写阶段：${run.stage}`, run.stage);
        return;
      }
      await sleepImpl(RUN_OBSERVE_POLL_MS);
    }
  } finally {
    await leaseSession.stop();
  }
}

/**
 * Auto adoption gate (doc §13, §14). Every condition must hold:
 * awaiting_user + final artifact + eligible + no open blocking/error checks
 * + batch policy. Adoption always goes through adoptArtifactAsDraft with no
 * forceOverwrite and no allowOpenChecks — conflicts and severe findings can
 * only pause the batch for the user.
 */
async function autoAdoptEligibleFinal(params: {
  batchId: string;
  batch: MultiChapterBatchRow;
  item: MultiChapterBatchItemRow;
  run: ContinuationGenerationRun;
  notify: (message: string, stage?: string) => void;
}): Promise<ContinuationStepResult> {
  const { batchId, item, run, notify } = params;
  const finalArtifact: ContinuationArtifact | null =
    await getLatestArtifactForStage(run.id, 'final');
  if (!finalArtifact) {
    return pauseBatchForItem(
      batchId,
      item,
      'BATCH_CONTINUATION_FINAL_REJECTED',
      '续写完成但没有可采纳的最终稿',
    );
  }
  if (finalArtifact.eligibilityStatus !== 'eligible') {
    return pauseBatchForItem(
      batchId,
      item,
      'BATCH_CONTINUATION_FINAL_REJECTED',
      '最终稿未通过交付校验（rejected），需要人工处理',
    );
  }
  const checks = await listChecksForArtifact(run.id, finalArtifact.id).catch(() => []);
  const openBlocking = checks.filter(
    (check: any) =>
      check.resolutionStatus === 'open' &&
      (check.severity === 'blocking' || check.severity === 'error'),
  );
  if (openBlocking.length > 0) {
    return pauseBatchForItem(
      batchId,
      item,
      'BATCH_CONTINUATION_FINAL_NEEDS_REVIEW',
      `最终稿有 ${openBlocking.length} 项严重问题待人工确认`,
    );
  }
  notify('采用最终稿', 'adoption');
  try {
    await adoptArtifactAsDraft({ runId: run.id });
  } catch (error: any) {
    if (error instanceof ContinuationOutdatedError) {
      return pauseBatchForItem(
        batchId,
        item,
        'BATCH_CONTINUATION_RUN_OUTDATED',
        '原著或 Canon 已更新，续写结果不可采纳',
      );
    }
    if (error instanceof ContinuationConflictError) {
      return pauseBatchForItem(
        batchId,
        item,
        'BATCH_CONTINUATION_CHAPTER_CONFLICT',
        error.message || '章节在生成期间被编辑，需人工确认覆盖方式',
      );
    }
    return pauseBatchForItem(
      batchId,
      item,
      'BATCH_CONTINUATION_ADOPTION_FAILED',
      `采用失败：${getErrorMessage(error, '未知错误')}`,
    );
  }
  await updateBatchItem(batchId, item.ordinal, { status: 'adopting' });
  return 'continue';
}

/**
 * Finalize + state freshness gate + item commit (doc §15–§18). The item only
 * becomes succeeded after finalize AND state settlement.
 */
async function finalizeAndGate(params: {
  batchId: string;
  batch: MultiChapterBatchRow;
  item: MultiChapterBatchItemRow;
  anchor: ContinuationBatchAnchorV1 | null;
  policy: ReturnType<typeof decodeContinuationBatchExecutionPolicy>;
  options: ContinuationBatchStepOptions;
  notify: (message: string, stage?: string) => void;
}): Promise<ContinuationStepResult> {
  const { batchId, batch, item, anchor, policy, notify } = params;
  if (item.chapterId == null) {
    return pauseBatchForItem(
      batchId,
      item,
      'BATCH_PROJECT_CHANGED',
      '当前章节已被删除',
      'paused_project_changed',
    );
  }
  const chapter = await db.getChapterById(item.chapterId);
  if (!chapter) {
    return pauseBatchForItem(
      batchId,
      item,
      'BATCH_PROJECT_CHANGED',
      '当前章节已被删除',
      'paused_project_changed',
    );
  }
  const content = String(chapter.content ?? '');
  const run = item.activeContinuationRunId
    ? await getRunById(item.activeContinuationRunId)
    : null;

  // Finalize (idempotent: content hash dedupe + INSERT OR IGNORE outbox).
  if (String(chapter.status || '') !== 'finalized' || !run?.finalizedRevisionHash) {
    notify('定稿并同步状态', 'finalize');
    try {
      await finalizeContinuationChapter({
        projectId: batch.projectId,
        chapterId: item.chapterId,
        content,
        sourceRunId: item.activeContinuationRunId ?? undefined,
      });
    } catch (error: any) {
      return pauseBatchForItem(
        batchId,
        item,
        'BATCH_CONTINUATION_FINALIZE_FAILED',
        `定稿失败：${getErrorMessage(error, '未知错误')}`,
      );
    }
  }

  // State freshness gate (doc §16): next chapter's LLM call count stays 0
  // until this returns ready.
  notify('正在同步人物状态与故事记忆…', 'state_sync');
  accelerateContinuationOutbox();
  const fresh = await db.getChapterById(item.chapterId);
  const gate = await checkNextChapterReady({
    projectId: batch.projectId,
    completedChapterId: item.chapterId,
    completedPosition: Number(fresh?.position ?? 0),
    anchor,
  });
  if (gate.ready) {
    const finalHash =
      run?.finalizedRevisionHash ||
      contentRevisionHash(String(fresh?.content ?? ''));
    const fingerprint = computeContinuationAdoptionFingerprint({
      batchId,
      ordinal: item.ordinal,
      chapterId: item.chapterId,
      continuationRunId: item.activeContinuationRunId || 'none',
      finalContentHash: finalHash,
    });
    // Item success = eligible + adopted + finalized + state settled (doc §18).
    await commitBatchItemAdoption({
      batchId,
      ordinal: item.ordinal,
      chapterCount: batch.chapterCount,
      completionQuality: 'full_pipeline',
      adoptionFingerprint: fingerprint,
      adoptedRevisionId: null,
      options: { enforceFingerprintMatch: false },
    });
    const items = await getBatchItems(batchId);
    await setBatchUsageFromContinuationRuns(batchId, items).catch(() => {});
    notify(`第 ${item.ordinal}/${batch.chapterCount} 章状态同步完成`);
    return 'continue';
  }
  if (gate.status === 'blocked') {
    const projectChanged =
      gate.errorCode === 'BATCH_CONTINUATION_SOURCE_CHANGED' ||
      gate.errorCode === 'BATCH_CONTINUATION_BOUNDARY_CHANGED' ||
      gate.errorCode === 'BATCH_CONTINUATION_CANON_CHANGED';
    return pauseBatchForItem(
      batchId,
      item,
      gate.errorCode,
      gate.reason,
      projectChanged ? 'paused_project_changed' : 'paused_user',
    );
  }
  // waiting — bounded polling via waiting_retry + nextRetryAt (doc §17).
  // Mirror the outline wait_until contract: persist the durable schedule,
  // wait one bounded in-process chunk, then hand control back (the store
  // watchdog re-drives when nextRetryAt passes; cold start recovers too).
  const attempts = item.retryCount + 1;
  if (attempts >= policy.stateGateMaxAttempts) {
    return pauseBatchForItem(
      batchId,
      item,
      'BATCH_CONTINUATION_STATE_SYNC_TIMEOUT',
      '状态同步等待超时，请检查状态同步设置后重试',
    );
  }
  const nextRetryAt = Date.now() + policy.stateGatePollIntervalMs;
  await updateBatchItem(batchId, item.ordinal, {
    status: 'waiting_retry',
    errorCode: 'BATCH_CONTINUATION_STATE_SYNC_WAIT',
    errorMessage: gate.reason,
    retryCount: attempts,
    nextRetryAt,
  });
  await updateBatchStatus(batchId, 'waiting_retry');
  // Wait one bounded in-process chunk (acceleration), then hand control
  // back: the store watchdog re-drives once nextRetryAt passes and cold
  // start recovers from the persisted schedule (doc §17 — no busy loop).
  const sleepImpl = params.options.sleepImpl ?? defaultSleep;
  await sleepImpl(Math.min(policy.stateGatePollIntervalMs, 5_000));
  return 'stop';
}

/**
 * User-resume rearm (doc §22/§25): an explicit user resume may start a NEW
 * run for the current chapter when the bound run terminated without
 * adoption. Called by the store before re-driving a paused batch.
 */
export async function rearmContinuationItemForUserResume(
  batchId: string,
  ordinal: number,
): Promise<void> {
  const item = await getBatchItem(batchId, ordinal);
  if (!item || item.chapterId == null) return;
  const needsRearm =
    item.status === 'failed' ||
    item.status === 'outcome_unknown' ||
    item.status === 'waiting_retry';
  if (!needsRearm) return;
  let run: ContinuationGenerationRun | null = null;
  if (item.activeContinuationRunId) {
    run = await getRunById(item.activeContinuationRunId);
  }
  const runUnusable =
    !run ||
    run.state === 'failed' ||
    run.state === 'cancelled' ||
    run.state === 'outdated' ||
    run.state === 'awaiting_regeneration' ||
    (run.state === 'completed' && run.completionReason !== 'adopted');
  if (runUnusable) {
    await updateBatchItem(batchId, ordinal, {
      activeContinuationRunId: runUnusable ? null : item.activeContinuationRunId,
      status: 'chapter_ready',
      errorCode: null,
      errorMessage: null,
      nextRetryAt: null,
      retryCount: 0,
    });
    return;
  }
  // Run still adoptable/resumable — keep the binding, just clear the pause
  // markers; the next step observes the run.
  await updateBatchItem(batchId, ordinal, {
    status: 'running_pipeline',
    errorCode: null,
    errorMessage: null,
    nextRetryAt: null,
    retryCount: 0,
  });
}

/**
 * Cancel (doc §24): cancel the active run, mark unstarted items cancelled,
 * keep completed chapters and adopted content. Idempotent.
 */
export async function cancelContinuationBatch(
  batchId: string,
  items: MultiChapterBatchItemRow[],
  currentOrdinal: number,
): Promise<void> {
  const current = items.find(item => item.ordinal === currentOrdinal);
  if (current?.activeContinuationRunId) {
    await cancelContinuationRun(current.activeContinuationRunId).catch(() => {});
  }
  for (const item of items) {
    if (item.status === 'succeeded' || item.status === 'succeeded_with_draft' || item.status === 'succeeded_with_user_text') {
      continue;
    }
    if (item.status === 'cancelled') continue;
    if (item.ordinal === currentOrdinal || item.status !== 'pending') {
      await updateBatchItem(batchId, item.ordinal, {
        status: 'cancelled',
        errorCode: 'BATCH_CANCELLED',
        nextRetryAt: null,
      }).catch(() => {});
    } else {
      await updateBatchItem(batchId, item.ordinal, {
        status: 'cancelled',
        nextRetryAt: null,
      }).catch(() => {});
    }
  }
}
