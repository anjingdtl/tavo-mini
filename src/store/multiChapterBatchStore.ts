/**
 * Multi-chapter batch store (Phase 8).
 *
 * Responsibilities: load batch + items, create planning drafts, persist
 * edited plans, start/pause/resume/cancel, drive the batch foreground
 * notification, and expose loading/error. The batch STATE itself always
 * lives in SQLite — the store only mirrors it for rendering.
 */
import { create } from 'zustand';
import * as batchRepo from '../data/repositories/multiChapterBatchRepository';
import type {
  MultiChapterBatchItemRow,
  MultiChapterBatchRow,
} from '../data/repositories/multiChapterBatchRepository';
import {
  CURRENT_CONTEXT_BUDGET_VERSION,
  CURRENT_OUTLINE_WORKFLOW_VERSION,
} from '../services/pipeline/outlineWorkflowVersion';
import { collectPlannerMaterials, createBatchChapterPlan, normalizeEditedPlan, computePlannerHash } from '../services/multiChapterBatch/planner';
import { resolveLLMRequestConfig } from '../services/llm';
import * as db from '../services/database';
import { normalizePipelineReasoningEffort } from '../services/pipeline/reasoningPolicy';
import { reconcileMultiChapterBatch } from '../services/multiChapterBatch/reconcileMultiChapterBatch';
import { cancelPipeline, interruptPipelineTask } from '../services/pipelineRunner';
import {
  hasSucceededStageCheckpoints,
  resetFailedStageCheckpointsForResume,
} from '../data/repositories/pipelineStageCheckpointRepository';
import { updatePipelineTaskResumeState } from '../data/repositories/pipelineTaskRepository';
import { getChaptersByProject } from '../data/repositories/projectRepository';
import { PipelineForeground } from '../native/PipelineForegroundModule';
import { BATCH_DEFAULT_CHAPTERS, BATCH_DEFAULT_TARGET_WORDS } from '../types/multiChapterBatch';
import type { BatchChapterPlan } from '../types/multiChapterBatch';

let instanceId = `ui_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
export function resetBatchInstanceId(): void {
  instanceId = `ui_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export interface BatchCreateDraftInput {
  projectId: number;
  sourcePrompt: string;
  chapterCount: number;
  targetWordsPerChapter: number;
  pipelineMode: string;
}

interface MultiChapterBatchState {
  batch: MultiChapterBatchRow | null;
  items: MultiChapterBatchItemRow[];
  plan: BatchChapterPlan | null;
  loading: boolean;
  error: string | null;
  reconciling: boolean;
  lastMessage: string | null;
  /** Current single-chapter pipeline stage (live heartbeat). */
  lastStage: string | null;

  loadBatch: (batchId: string) => Promise<void>;
  loadActiveBatchForProject: (projectId: number) => Promise<void>;
  createDraftBatch: (input: BatchCreateDraftInput) => Promise<string>;
  runPlanner: (batchId: string) => Promise<BatchChapterPlan>;
  saveEditedPlan: (
    batchId: string,
    chapters: BatchChapterPlan['chapters'],
  ) => Promise<void>;
  start: (batchId: string) => Promise<void>;
  pause: (batchId: string) => Promise<void>;
  resume: (batchId: string) => Promise<void>;
  cancel: (batchId: string) => Promise<void>;
  refresh: () => Promise<void>;
  clearError: () => void;
}

async function refreshBatch(
  set: (partial: Partial<MultiChapterBatchState>) => void,
  get: () => MultiChapterBatchState,
): Promise<void> {
  const batch = get().batch;
  if (!batch) return;
  const [fresh, items] = await Promise.all([
    batchRepo.getBatchById(batch.id),
    batchRepo.getBatchItems(batch.id),
  ]);
  set({ batch: fresh, items });
}

/**
 * Drive one reconcile run to completion in the background. The store's
 * `start` returns immediately; this helper owns the foreground notification
 * lifecycle and clears the `reconciling` guard exactly once.
 */
async function driveBatchReconcile(
  batchId: string,
  set: (partial: Partial<MultiChapterBatchState>) => void,
  get: () => MultiChapterBatchState,
): Promise<void> {
  try {
    await reconcileMultiChapterBatch(batchId, {
      owner: instanceId,
      onProgress: info => {
        set({
          lastMessage: info.message || null,
          lastStage: info.stage || null,
        });
        const pct = Math.round(
          (info.completedCount / Math.max(1, info.chapterCount)) * 100,
        );
        PipelineForeground.updateProgress(
          `batch_${batchId}`,
          info.itemStatus
            ? `第 ${info.currentOrdinal}/${info.chapterCount} 章 · ${info.message || ''}`
            : `第 ${info.currentOrdinal}/${info.chapterCount} 章`,
          pct,
        ).catch(() => {});
      },
    });
  } catch (error: any) {
    set({
      reconciling: false,
      error: String(error?.message || '批次运行失败'),
    });
    PipelineForeground.stop(`batch_${batchId}`).catch(() => {});
    // 异常退出也刷新真实状态（task failed → 暂停分类由下次 reconcile 落库）。
    try {
      await refreshBatch(set, get);
    } catch {
      // ignore
    }
    return;
  }
  await refreshBatch(set, get);
  const fresh = get().batch;
  if (fresh?.status === 'completed') {
    PipelineForeground.notifyComplete(
      `batch_${batchId}`,
      '批量写章完成',
      `已完成 ${fresh.completedCount}/${fresh.chapterCount} 章`,
    ).catch(() => {});
  } else if (fresh?.status.startsWith('paused_')) {
    PipelineForeground.notifyFailed(
      `batch_${batchId}`,
      '批量写章暂停',
      fresh.errorMessage || '批次已暂停',
    ).catch(() => {});
  }
  PipelineForeground.stop(`batch_${batchId}`).catch(() => {});
  set({ reconciling: false });
}

export const useMultiChapterBatchStore = create<MultiChapterBatchState>(
  (set, get) => ({
    batch: null,
    items: [],
    plan: null,
    loading: false,
    error: null,
    reconciling: false,
    lastMessage: null,
    lastStage: null,

    loadBatch: async batchId => {
      set({ loading: true, error: null });
      try {
        const [batch, items] = await Promise.all([
          batchRepo.getBatchById(batchId),
          batchRepo.getBatchItems(batchId),
        ]);
        set({ batch, items, loading: false });
      } catch (error: any) {
        set({ loading: false, error: String(error?.message || '加载批次失败') });
      }
    },

    loadActiveBatchForProject: async projectId => {
      set({ loading: true, error: null });
      try {
        const batch = await batchRepo.getActiveBatchByProject(projectId);
        if (!batch) {
          set({ batch: null, items: [], loading: false });
          return;
        }
        const items = await batchRepo.getBatchItems(batch.id);
        set({ batch, items, loading: false });
      } catch (error: any) {
        set({ loading: false, error: String(error?.message || '加载批次失败') });
      }
    },

    createDraftBatch: async input => {
      set({ loading: true, error: null });
      try {
        const id = `batch_${Date.now().toString(36)}_${Math.random()
          .toString(36)
          .slice(2, 8)}`;
        await batchRepo.createBatch({
          id,
          projectId: input.projectId,
          sourcePrompt: input.sourcePrompt,
          chapterCount: input.chapterCount,
          targetWordsPerChapter: input.targetWordsPerChapter,
          pipelineMode: input.pipelineMode,
          // Freeze the product tier at batch creation. Child tasks inherit it
          // even if the global PipelineConfig changes while planning/running.
          reasoningEffort: normalizePipelineReasoningEffort(
            (await db.getPipelineConfig()).reasoningEffort,
          ),
          // §4.4: freeze the CURRENT protocol versions ONCE at batch
          // creation; every chapter task later copies them from the row.
          outlineWorkflowVersion: CURRENT_OUTLINE_WORKFLOW_VERSION,
          contextBudgetVersion: CURRENT_CONTEXT_BUDGET_VERSION,
        });
        for (let i = 1; i <= input.chapterCount; i += 1) {
          await batchRepo.createBatchItem({
            batchId: id,
            ordinal: i,
            title: `第 ${i} 章`,
            synopsis: '',
            keyBeatsJson: '[]',
            targetWords: input.targetWordsPerChapter,
          });
        }
        const [batch, items] = await Promise.all([
          batchRepo.getBatchById(id),
          batchRepo.getBatchItems(id),
        ]);
        set({ batch, items, loading: false });
        return id;
      } catch (error: any) {
        set({ loading: false, error: String(error?.message || '创建批次失败') });
        throw error;
      }
    },

    runPlanner: async batchId => {
      const batch = get().batch;
      if (!batch) throw new Error('批次不存在');
      set({ loading: true, error: null });
      try {
        const materials = await collectPlannerMaterials(batch.projectId);
        const result = await createBatchChapterPlan({
          projectId: batch.projectId,
          sourcePrompt: batch.sourcePrompt,
          chapterCount: batch.chapterCount,
          targetWordsPerChapter: batch.targetWordsPerChapter,
          pipelineMode: batch.pipelineMode,
          materials,
        });
        await batchRepo.updateBatchStatus(batchId, 'planning', {
          plannerOutputJson: JSON.stringify(result.plan),
          plannerHash: result.hash,
          plannerRequestJson: result.requestJson,
          plannerRequestFingerprint: result.requestFingerprint,
        });
        // 批次消耗上限由弹性预算池自动分配（用户无需感知）：按模型上下文窗口
        // 给出宽松防失控上限；每个单章请求仍受弹性预算精确约束。
        try {
          const requestConfig = await resolveLLMRequestConfig();
          const contextWindow =
            Number(requestConfig?.context_window) || 128000;
          await batchRepo.updateBatchBudget(batchId, {
            maxLlmCalls: batch.chapterCount * 12,
            maxInputTokens: Math.floor(contextWindow * 4),
            maxOutputTokens: Math.floor(contextWindow * 2),
          });
        } catch {
          // 自动分配失败不阻断规划；保持无上限（单章弹性预算仍生效）。
        }
        set({ plan: result.plan, loading: false });
        return result.plan;
      } catch (error: any) {
        set({ loading: false, error: String(error?.message || '规划失败') });
        throw error;
      }
    },

    saveEditedPlan: async (batchId, chapters) => {
      set({ loading: true, error: null });
      try {
        const normalized = normalizeEditedPlan(chapters, chapters.length);
        if (!normalized.ok) {
          throw new Error(normalized.errors.join('；'));
        }
        for (const chapter of normalized.plan.chapters) {
          await batchRepo.updateBatchItem(batchId, chapter.ordinal, {
            title: chapter.title,
            synopsis: chapter.synopsis,
            keyBeatsJson: JSON.stringify(chapter.keyBeats),
            carryIn: chapter.carryIn || null,
            carryOut: chapter.carryOut || null,
            targetWords: chapter.targetWords,
          });
        }
        const hash = computePlannerHash(normalized.plan);
        // Freeze the project-tail anchor so drift protection can actually
        // run: startPosition = current tail position, expectedTailChapterId
        // = the tail chapter. Without this the batch would keep writing into
        // a project whose tail the user has changed mid-run.
        const batchRow = await batchRepo.getBatchById(batchId);
        if (!batchRow) {
          throw new Error('批次不存在');
        }
        const projectChapters = await getChaptersByProject(batchRow.projectId);
        const tailPosition =
          projectChapters.length > 0
            ? Math.max(...projectChapters.map((c: any) => Number(c.position)))
            : -1;
        const tailChapter =
          projectChapters.length > 0
            ? projectChapters.reduce((max: any, c: any) =>
                Number(c.position) >= Number(max.position) ? c : max,
              )
            : null;
        // Freeze the plan hash + mark ready; reconcile may now start.
        await batchRepo.updateBatchStatus(batchId, 'ready', {
          plannerHash: hash,
          plannerOutputJson: JSON.stringify(normalized.plan),
          startPosition: tailPosition,
          expectedTailChapterId: tailChapter?.id ?? null,
        });
        await refreshBatch(set, get);
        set({ plan: normalized.plan, loading: false });
      } catch (error: any) {
        set({ loading: false, error: String(error?.message || '保存计划失败') });
        throw error;
      }
    },

    start: async batchId => {
      // 防重入：reconcile 已在驱动时忽略重复启动（按钮也已禁用）。
      if (get().reconciling) return;
      set({ reconciling: true, error: null });
      const batch = get().batch;
      if (batch) {
        PipelineForeground.start(
          `batch_${batchId}`,
          '批量写章',
          '准备中',
          0,
        ).catch(() => {});
      }
      // 非阻塞：reconcile 在后台驱动，UI 通过轮询/心跳刷新；立即返回让
      // 页面切到运行视图（此前 await 整个 reconcile 会让界面停在预览页，
      // 且开始按钮可被重复点击）。
      void driveBatchReconcile(batchId, set, get);
    },

    pause: async batchId => {
      try {
        await batchRepo.updateBatchStatus(batchId, 'paused_user', {
          pauseReason: 'user_pause',
        });
        // 立即中断当前章节的 LLM 请求（不终态化任务：checkpoint 落为
        // interrupted，恢复时复用已成功阶段）。否则用户点暂停后模型仍会
        // 继续生成，费用继续产生。
        const currentItem = get().items.find(
          i => i.ordinal === get().batch?.currentOrdinal,
        );
        if (currentItem?.activePipelineTaskId) {
          interruptPipelineTask(currentItem.activePipelineTaskId);
        }
        await refreshBatch(set, get);
      } catch (error: any) {
        set({ error: String(error?.message || '暂停失败') });
      }
    },

    resume: async batchId => {
      set({ error: null });
      const batch = get().batch;
      if (!batch) return;
      const currentItem = get().items.find(
        i => i.ordinal === batch.currentOrdinal,
      );
      const needsReset =
        currentItem &&
        (currentItem.status === 'outcome_unknown' ||
          currentItem.status === 'failed' ||
          currentItem.status === 'blocked_context_budget' ||
          currentItem.status === 'blocked_account_quota' ||
          currentItem.status === 'blocked_batch_budget' ||
          currentItem.status === 'waiting_retry');
      if (needsReset) {
        // F2-07: 若旧任务已有成功阶段（例如 network_error 中断在终审，
        // draft/review/factCheck 已成功），"确认后继续"保留任务、重置失败
        // stage 为 pending、task 转 interrupted —— pipeline 状态机只重跑
        // 失败阶段（复用 frozen request），不再从头生成已成功的阶段（避免
        // token 浪费）。无任何成功阶段时才解绑创建全新 run（旧 task/attempt
        // 历史保留在 item_runs，审计不丢）。
        const taskId = currentItem.activePipelineTaskId;
        if (taskId != null && (await hasSucceededStageCheckpoints(taskId))) {
          await resetFailedStageCheckpointsForResume(taskId);
          // F3-01: resume 状态更新必须走 targeted UPDATE —— 严禁全量
          // savePipelineTask（UPSERT 会把 input_fingerprint /
          // pipeline_context_json / pipeline_context_version /
          // pipeline_context_hash 写成 NULL，导致状态机 TASK_NOT_RECOVERABLE，
          // 用户已付费的 draft/review/factCheck 全部作废）。
          await updatePipelineTaskResumeState(taskId);
          await batchRepo.updateBatchItem(batchId, currentItem.ordinal, {
            status: 'running_pipeline',
            errorCode: null,
            errorMessage: null,
            nextRetryAt: null,
          });
        } else {
          await batchRepo.updateBatchItem(batchId, currentItem.ordinal, {
            status: 'running_pipeline',
            activePipelineTaskId: null,
            errorCode: null,
            errorMessage: null,
            nextRetryAt: null,
          });
        }
      }
      if (batch.status.startsWith('paused_')) {
        // Re-arm: paused_* → running（reconcile 重新决策；若根因未消除会
        // 再次按分类暂停）。
        await batchRepo.updateBatchStatus(batchId, 'running', {
          pauseReason: null,
          errorCode: null,
          errorMessage: null,
        });
      }
      // F2-07: refresh the in-memory state IMMEDIATELY — the paused view is
      // driven by store.batch.status and does not poll, while reconcile is a
      // long-running drive (minutes per chapter). Without this refresh the UI
      // stays on the paused screen with no visible reaction until the whole
      // reconcile finishes.
      await refreshBatch(set, get);
      await get().start(batchId);
    },

    cancel: async batchId => {
      try {
        await batchRepo.updateBatchStatus(batchId, 'cancelled', {
          cancelledAt: Date.now(),
          errorCode: 'BATCH_CANCELLED',
        });
        // Cancel the active pipeline task if any (does NOT delete chapters).
        const item = get().items.find(i => i.ordinal === get().batch?.currentOrdinal);
        if (item?.activePipelineTaskId) {
          cancelPipeline(item.activePipelineTaskId);
        }
        await refreshBatch(set, get);
        PipelineForeground.stop(`batch_${batchId}`).catch(() => {});
      } catch (error: any) {
        set({ error: String(error?.message || '取消批次失败') });
      }
    },

    refresh: async () => {
      await refreshBatch(set, get);
      // 等待重试到期后自动续驱（safe_retry 自动恢复）：reconcile 在
      // wait_until 未到期时会提前交还控制权，若之后无人再次驱动，批次会
      // 停在运行状态但实际无人执行——运行页每 2s 调用 refresh，这里充当
      // 看门狗：重试时间已到且无协调器在跑时自动重新驱动。
      const b = get().batch;
      if (!b || get().reconciling) return;
      if (
        b.status.startsWith('paused_') ||
        ['completed', 'cancelled', 'failed'].includes(b.status)
      ) {
        return;
      }
      const current = get().items.find(
        i => i.ordinal === b.currentOrdinal,
      );
      if (
        current?.status === 'waiting_retry' &&
        current.nextRetryAt != null &&
        current.nextRetryAt <= Date.now()
      ) {
        void get().start(b.id);
      }
    },

    clearError: () => set({ error: null }),
  }),
);

export {
  BATCH_DEFAULT_CHAPTERS,
  BATCH_DEFAULT_TARGET_WORDS,
};
