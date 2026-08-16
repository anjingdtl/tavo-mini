/**
 * Freeform / chapter pipeline public API.
 *
 * Production chapter/freeform execution enters the unified Writing Kernel.
 * This module keeps cancellation/abort plumbing and stable compatibility
 * entry points used by UI and tests.
 */
import {
  PIPELINE_CONTEXT_SNAPSHOT_VERSION,
  type PipelineContextSnapshot,
} from '../types/pipelineContext';
import type { PipelineExecutionSnapshot } from '../types/pipelineExecution';
import type { Chapter } from '../types/novel';
import { sha256Hex } from './continuation/hashUtils';
import { PipelineForeground } from '../native/PipelineForegroundModule';
import {
  parsePersistedPipelineTaskContext,
  serializePipelineTaskContext,
} from './pipelineTaskContext';
import { usePipelineTaskStore } from '../store/pipelineTaskStore';
import type {
  PipelineMode,
  PipelineReasoningEffort,
  PipelineStageName,
  PipelineTask,
} from '../types/pipeline';
import type { ContextAutomationPolicyV3 } from './contextAutomationPolicy';
import { getPipelineTaskResumePayload } from '../data/repositories/pipelineTaskRepository';
import {
  CURRENT_CONTEXT_BUDGET_VERSION,
  CURRENT_OUTLINE_WORKFLOW_VERSION,
  PHASE2_CONTEXT_BUDGET_VERSION,
  V3_HIERARCHICAL_CONTEXT_BUDGET_VERSION,
} from './pipeline/outlineWorkflowVersion';
import {
  runOutlineWritingKernel,
  resumeOutlineWritingKernel,
} from './writing/productionWritingEntry';

/**
 * Resume compatibility check (Plan §12 / §23 GO Gate #12 / #13).
 * V2 (5) and V3 (6) tasks are both resumable on their own version; neither
 * is silently upgraded. Any other version (1–4 legacy) is blocked.
 */
function isTaskContextBudgetVersionResumable(version: unknown): boolean {
  const n = Number(version);
  return (
    n === CURRENT_CONTEXT_BUDGET_VERSION ||
    n === V3_HIERARCHICAL_CONTEXT_BUDGET_VERSION ||
    n === PHASE2_CONTEXT_BUDGET_VERSION
  );
}

const cancelledTasks = new Set<string>();
const taskAbortControllers = new Map<string, AbortController>();

export type StageInfo = {
  stage: PipelineStageName | 'idle';
  label: string;
  startedAt: number;
};

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
  /**
   * Batch-owned V2 tasks inherit the tier frozen on the batch header. Applied
   * only before the task has an execution snapshot; resume keeps the snapshot.
   */
  pipelineReasoningEffortOverride?: PipelineReasoningEffort | null;
  /** Batch-frozen V3 policy; resume never falls back to live settings. */
  contextAutomationPolicyV3?: ContextAutomationPolicyV3 | null;
  /**
   * BN-04: when set, every LLM attempt checks the batch's hard budget
   * caps BEFORE any HTTP request is issued. Exceeding the cap throws
   * BatchBudgetExceededError and the batch reconciler pauses the item.
   */
  batchBudgetGate?: { batchId: string };
  /**
   * Stability Phase 1 — explicit generation trace id (tests / batch
   * correlation). runChapterPipeline mints one when omitted.
   */
  generationTraceId?: string;
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

/** Kernel Final Closure: the Writing Kernel driver clears the shared
 * cancellation marker when its run settles (same semantics the legacy
 * public entries applied in their finally blocks). */
export function forgetCancelledTask(taskId: string): void {
  cancelledTasks.delete(taskId);
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

export function registerTaskAbort(taskId: string): AbortSignal {
  const controller = new AbortController();
  taskAbortControllers.set(taskId, controller);
  return controller.signal;
}

export function releaseTaskAbort(taskId: string): void {
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
  await runOutlineWritingKernel(taskId, chapter, onStageUpdate, {
    ...options,
    foregroundOwner: options.foregroundOwner,
  });
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
  const incompleteStatuses = new Set([
    'idle',
    'queued',
    'drafting',
    'reviewing',
    'factChecking',
    'briefing',
    'proofing',
    'failed',
    'interrupted',
  ]);
  const inMemoryTask = usePipelineTaskStore
    .getState()
    .tasks.find(task => task.id === taskId);
  // Reject a known legacy row before hydrating its large payload. Besides
  // preserving the fail-closed resume contract, this keeps legacy rejection
  // independent of the DB detail reader (important during cold-start faults).
  if (
    inMemoryTask &&
    incompleteStatuses.has(String(inMemoryTask.status)) &&
    (Number(inMemoryTask.outlineWorkflowVersion) !==
      CURRENT_OUTLINE_WORKFLOW_VERSION ||
      !isTaskContextBudgetVersionResumable(inMemoryTask.contextBudgetVersion))
  ) {
    const error = Object.assign(
      new Error('该任务使用旧版生成流程或预算协议，不能继续；请按新版重新生成。'),
      { code: 'LEGACY_PIPELINE_RESUME_BLOCKED' },
    );
    throw error;
  }
  // Task-list queries intentionally omit large TEXT columns. Always hydrate a
  // summary row before reconcile needs the frozen context; this also makes a
  // cold-start Resume use the same narrow/chunked reader as Derived Final.
  const persistedTask = inMemoryTask?.pipelineContextJson
    ? inMemoryTask
    : await getPipelineTaskResumePayload(taskId) || inMemoryTask;
  if (persistedTask && persistedTask !== inMemoryTask) {
    usePipelineTaskStore
      .getState()
      .registerPersistedTask(persistedTask as PipelineTask);
  }
  if (
    persistedTask &&
    incompleteStatuses.has(String(persistedTask.status)) &&
    (Number(persistedTask.outlineWorkflowVersion) !==
      CURRENT_OUTLINE_WORKFLOW_VERSION ||
      !isTaskContextBudgetVersionResumable(persistedTask.contextBudgetVersion))
  ) {
    const error = Object.assign(
      new Error('该任务使用旧版生成流程或预算协议，不能继续；请按新版重新生成。'),
      { code: 'LEGACY_PIPELINE_RESUME_BLOCKED' },
    );
    throw error;
  }
  // Resume must validate the persisted envelope before the Kernel is allowed
  // to backfill or execute anything. A corrupt/forged hash is a fail-closed
  // task failure, never a reason to rebuild Freeze from live context.
  if (persistedTask?.pipelineContextJson) {
    try {
      parsePersistedPipelineTaskContext(persistedTask, {
        expectedProjectId: chapter.project_id,
        expectedChapterId: chapter.id,
        expectedTaskId: taskId,
      });
    } catch (error: any) {
      const message = `冻结上下文解析失败：${
        error?.message ? String(error.message) : '冻结快照无效'
      }`;
      if (usePipelineTaskStore.getState().persistFailTask) {
        await usePipelineTaskStore.getState().persistFailTask(taskId, message);
      } else {
        usePipelineTaskStore.getState().failTask(taskId, message);
      }
      return;
    }
  }
  await resumeOutlineWritingKernel(taskId, chapter, onStageUpdate, {
    ...options,
    foregroundOwner: options.foregroundOwner,
  });
}
