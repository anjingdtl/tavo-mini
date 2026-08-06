/**
 * Freeform / chapter pipeline public API.
 *
 * Execution lives in `pipeline/reconcile.ts` (single durable state machine).
 * This module keeps cancel/abort plumbing and stable entry points used by UI.
 */
import {
  PIPELINE_CONTEXT_SNAPSHOT_VERSION,
  type PipelineContextSnapshot,
} from '../types/pipelineContext';
import type { PipelineExecutionSnapshot } from '../types/pipelineExecution';
import type { Chapter } from '../types/novel';
import { sha256Hex } from './continuation/hashUtils';
import {
  clearLLMTaskQueueDefaults,
  setLLMTaskQueueDefaults,
} from './llm/requestScheduler';
import { PipelineForeground } from '../native/PipelineForegroundModule';
import {
  parsePersistedPipelineTaskContext,
  serializePipelineTaskContext,
} from './pipelineTaskContext';
import {
  reconcilePipelineTask,
  type StageInfo as ReconcileStageInfo,
} from './pipeline/reconcile';
import { usePipelineTaskStore } from '../store/pipelineTaskStore';
import type { PipelineMode } from '../types/pipeline';

const cancelledTasks = new Set<string>();
const taskAbortControllers = new Map<string, AbortController>();

export type StageInfo = ReconcileStageInfo;

export interface PipelineRunOptions {
  queueClass?: 'pipeline' | 'background';
  queuePriority?: 'manual' | 'background';
  /**
   * 'batch' suppresses the per-task foreground notification so the batch
   * owns a single aggregated notification (Phase 8). Defaults to 'task'.
   */
  foregroundOwner?: 'task' | 'batch';
  /**
   * Batch-owned tasks must execute with the mode chosen on the batch form
   * (draft_only → noReview etc), NOT the global pipeline setting. Only
   * applied when the task has no frozen execution snapshot yet (first run);
   * resume always keeps the frozen value.
   */
  pipelineModeOverride?: PipelineMode;
}

export function cancelPipeline(taskId: string): void {
  try {
    cancelledTasks.add(taskId);
    // 不等待网络或原生回调：用户明确停止时必须先把终态写入 SQLite，
    // 否则进程在 prefill 中被关闭后，冷启动会把旧任务错误地显示为仍在运行。
    usePipelineTaskStore.getState().cancelTask(taskId);
    PipelineForeground.stop(taskId).catch(() => {});
    const controller = taskAbortControllers.get(taskId);
    if (controller) {
      try {
        controller.abort();
      } catch {
        // AbortController.abort must not escape into the UI press handler.
      }
    }
  } catch (error) {
    console.warn('[pipeline] cancelPipeline failed:', error);
  }
}

export function isPipelineCancelled(taskId: string): boolean {
  return cancelledTasks.has(taskId);
}

/**
 * Pause interrupt (batch pause): abort the in-flight LLM request WITHOUT
 * terminating the task. The stage checkpoint is released as `interrupted` by
 * the executing stage, so a later resume reuses already-succeeded stages.
 */
export function interruptPipelineTask(taskId: string): void {
  const controller = taskAbortControllers.get(taskId);
  if (controller) {
    try {
      controller.abort();
    } catch {
      // AbortController.abort must not escape into the UI press handler.
    }
  }
}

function registerTaskAbort(taskId: string): AbortSignal {
  const controller = new AbortController();
  taskAbortControllers.set(taskId, controller);
  return controller.signal;
}

function releaseTaskAbort(taskId: string): void {
  taskAbortControllers.delete(taskId);
}

/**
 * Serialize + hash a frozen pipeline context snapshot.
 * Prefer {@link serializePipelineTaskContext} (V2 envelope). This wrapper
 * remains for unit tests that only have a bare snapshot.
 */
export function serializePipelineContextSnapshot(
  snapshot: PipelineContextSnapshot,
  execution?: PipelineExecutionSnapshot,
): {
  pipelineContextJson: string;
  pipelineContextVersion: number;
  pipelineContextHash: string;
} {
  if (execution) {
    return serializePipelineTaskContext({
      draftContext: snapshot,
      execution,
    });
  }
  // Legacy V1 bare snapshot (tests / migration helpers).
  const enriched: PipelineContextSnapshot = {
    ...snapshot,
    snapshotVersion: PIPELINE_CONTEXT_SNAPSHOT_VERSION,
    createdAt: snapshot.createdAt ?? Date.now(),
  };
  const pipelineContextJson = JSON.stringify(enriched);
  return {
    pipelineContextJson,
    pipelineContextVersion: 1,
    pipelineContextHash: sha256Hex(pipelineContextJson).slice(0, 32),
  };
}

/**
 * Load a previously persisted snapshot (draft context).
 * Throws OutlineContextError when missing/corrupt. Prefer
 * {@link parsePersistedPipelineTaskContext} when audit/execution are needed.
 */
export function parsePersistedPipelineContextSnapshot(
  task: {
    pipelineContextJson?: string | null;
    pipelineContextHash?: string | null;
    pipelineContextVersion?: number | null;
  },
  ownership?: {
    expectedProjectId?: number;
    expectedChapterId?: number;
    expectedTaskId?: string;
  },
): PipelineContextSnapshot {
  return parsePersistedPipelineTaskContext(task, ownership).draftContext;
}

/**
 * First-run entry. Shares the same state machine as {@link resumePipeline}.
 */
export async function runChapterPipeline(
  taskId: string,
  chapter: Chapter,
  onStageUpdate?: (info: StageInfo | string) => void,
  options: PipelineRunOptions = {},
): Promise<void> {
  setLLMTaskQueueDefaults(taskId, {
    queueClass: options.queueClass || 'pipeline',
    queuePriority: options.queuePriority || 'manual',
  });
  const abortSignal = registerTaskAbort(taskId);
  const ownsForeground = (options.foregroundOwner ?? 'task') === 'task';
  // 必须在用户仍处于前台、且任何数据库/网络 await 之前启动服务。若等到配置读取
  // 完成后用户已经切到后台，Android 12+ 会拒绝 startForegroundService，原先错误被
  // 静默降级后就表现为“流水线一切后台必失败”。
  if (ownsForeground) {
    PipelineForeground.start(
      taskId,
      chapter.title || '流水线',
      '正在准备写作',
      0,
    ).catch(error => {
      console.warn(
        '[pipeline] early foreground start failed (non-fatal):',
        error,
      );
    });
  }
  try {
    await reconcilePipelineTask(taskId, chapter, {
      onStageUpdate,
      abortSignal,
      isCancelled: isPipelineCancelled,
      pipelineModeOverride: options.pipelineModeOverride,
    });
  } finally {
    releaseTaskAbort(taskId);
    clearLLMTaskQueueDefaults(taskId);
    cancelledTasks.delete(taskId);
  }
}

export async function runFreeformPipeline(
  taskId: string,
  projectId: number,
  documentText: string,
  steerText: string,
  onStageUpdate?: (info: StageInfo | string) => void,
  options?: PipelineRunOptions,
): Promise<void> {
  const pseudoChapter: Chapter = {
    id: 0,
    project_id: projectId,
    position: Number.MAX_SAFE_INTEGER,
    title: '自由写作',
    synopsis: steerText,
    content: documentText,
    status: 'draft',
    summary_json: null,
    created_at: '',
    updated_at: '',
  };
  await runChapterPipeline(taskId, pseudoChapter, onStageUpdate, options);
}

/**
 * Resume / continue — same state machine as first run.
 */
export async function resumePipeline(
  taskId: string,
  chapter: Chapter,
  onStageUpdate?: (info: StageInfo | string) => void,
  options: PipelineRunOptions = {},
): Promise<void> {
  setLLMTaskQueueDefaults(taskId, {
    queueClass: options.queueClass || 'pipeline',
    queuePriority: options.queuePriority || 'manual',
  });
  const abortSignal = registerTaskAbort(taskId);
  const ownsForeground = (options.foregroundOwner ?? 'task') === 'task';
  if (ownsForeground) {
    PipelineForeground.start(
      taskId,
      chapter.title || '流水线',
      '正在恢复任务',
      0,
    ).catch(() => {});
  }
  try {
    await reconcilePipelineTask(taskId, chapter, {
      onStageUpdate,
      abortSignal,
      isCancelled: isPipelineCancelled,
      pipelineModeOverride: options.pipelineModeOverride,
    });
  } finally {
    releaseTaskAbort(taskId);
    clearLLMTaskQueueDefaults(taskId);
    cancelledTasks.delete(taskId);
  }
}

export { reconcilePipelineTask };
