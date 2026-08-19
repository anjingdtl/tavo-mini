import { create } from 'zustand';
import * as db from '../services/database';
import type { PipelineTask, PipelineStageResult, PipelineTaskStatus } from '../types/pipeline';
import { classifyInterruptedTask } from '../services/pipelineTaskContext';
import { OutlineContextError } from '../services/outlineContextBuilder';
import {
  LEGACY_PIPELINE_TOPOLOGY_VERSION,
  shouldIncludeBriefCheckpoint,
} from '../services/pipeline/outlineWorkflowVersion';
import { stageNamesForPipelineTopology } from '../services/pipeline/taskView';
import type { PipelineCheckpointStage } from '../services/pipeline/types';

function mergeStageResult(
  existing: PipelineStageResult[],
  result: PipelineStageResult,
): PipelineStageResult[] {
  // One effective result per stage (invariant 3).
  return [...existing.filter(s => s.stage !== result.stage), result];
}

function mapStageStatusToCheckpoint(
  status: PipelineStageResult['status'],
): 'succeeded' | 'failed' | 'skipped' {
  if (status === 'success') return 'succeeded';
  if (status === 'skipped') return 'skipped';
  return 'failed';
}

interface PipelineTaskState {
  tasks: PipelineTask[];
  _loaded: boolean;
  loadFromDB: () => Promise<void>;
  /** Load the large task payloads lazily after a summary-list query. */
  loadTaskDetails: (taskId: string) => Promise<void>;
  /**
   * Atomically persist the new pipeline task AND its four pending stage
   * checkpoints in one SQLite transaction, then add it to the in-memory
   * store. Returns the task id only after the transaction has committed.
   * Throws on DB failure — callers must surface a "无法启动流水线" error
   * rather than running the pipeline with a missing parent row (FK 787).
   */
  createTask: (
    targetType: 'chapter' | 'freeform',
    targetId: number,
    versions?: {
      /** Frozen outline workflow version (1 = Legacy, 2 = V2, 3 = V3.2, 4 = current). */
      outlineWorkflowVersion: 1 | 2 | 3 | 4;
      /** Frozen context budget version (1 = Legacy, 2–4 = historical, 5 = current, 6 = V3 hierarchical elastic). */
      contextBudgetVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7;
      /** Frozen pipeline topology version (1 = legacy_standard, 2 = compact_standard). */
      pipelineTopologyVersion?: 1 | 2;
    },
  ) => Promise<string>;
  /**
   * Fire-and-forget stage update (legacy). Prefer {@link persistTaskStage}.
   */
  updateTaskStage: (taskId: string, result: PipelineStageResult) => void;
  /**
   * Critical path: await checkpoint upsert + task projection write, then memory.
   */
  persistTaskStage: (
    taskId: string,
    result: PipelineStageResult,
  ) => Promise<void>;
  setTaskStatus: (taskId: string, status: PipelineTaskStatus) => void;
  /** Await task status write (state machine transitions). */
  persistTaskStatus: (
    taskId: string,
    status: PipelineTaskStatus,
  ) => Promise<void>;
  completeTask: (taskId: string, finalText: string) => void;
  persistCompleteTask: (taskId: string, finalText: string) => Promise<void>;
  /**
   * Persist final/draft text without changing task status.
   * Used on degraded paths (audit/proof failed) so failed is not overwritten
   * by completeTask, while UI can still show the retained draft.
   */
  setTaskFinalText: (taskId: string, finalText: string) => void;
  persistTaskFinalText: (taskId: string, finalText: string) => Promise<void>;
  failTask: (taskId: string, error: string) => void;
  persistFailTask: (taskId: string, error: string) => Promise<void>;
  cancelTask: (taskId: string) => void;
  /**
   * Persist the frozen input fingerprint on a task (projectId | chapterId |
   * chapterUpdatedAt | outlineFingerprint). Called by the runner at terminal
   * state so the result-adoption flow can later detect outline/chapter drift.
   */
  setTaskInputFingerprint: (taskId: string, fingerprint: string) => void;
  /**
   * Synchronously update in-memory snapshot fields only (no DB write).
   * Prefer {@link persistTaskPipelineContext} on the critical LLM path.
   */
  setTaskPipelineContext: (
    taskId: string,
    snapshot: {
      pipelineContextJson: string;
      pipelineContextVersion: number;
      pipelineContextHash: string;
    },
  ) => void;
  /** Sync a context written by a narrow repository update without re-saving a stale full row. */
  syncTaskPipelineContext: (
    taskId: string,
    snapshot: {
      pipelineContextJson: string;
      pipelineContextVersion: number;
      pipelineContextHash: string;
    },
  ) => void;
  /**
   * Critical path: await SQLite write of the frozen pipeline context, then
   * sync Zustand memory. Throws OutlineContextError on failure so the runner
   * can block the first LLM call.
   */
  persistTaskPipelineContext: (
    taskId: string,
    snapshot: {
      pipelineContextJson: string;
      pipelineContextVersion: number;
      pipelineContextHash: string;
    },
  ) => Promise<void>;
  resolveTask: (taskId: string, action: 'accept' | 'reject') => void;
  clearResolved: () => void;
  getActiveTaskForTarget: (targetType: 'chapter' | 'freeform', targetId: number) => PipelineTask | undefined;
  getLatestResumableFailedTask: (
    targetType: 'chapter' | 'freeform',
    targetId: number,
  ) => PipelineTask | undefined;
  getUnresolvedCount: () => number;
  /** 把 updatedAt 超过 staleMs 的活跃任务按可恢复性分类标记。返回标记的任务数。 */
  markStaleTasksAsFailed: (staleMs?: number) => number;
  /**
   * 冷启动：分类上次进程遗留的活跃任务。
   * 有成功 Draft + 合法快照 → interrupted/recoverable（不 resolve）。
   * 否则 → failed（不自动 resolve，保留在任务中心）。
   */
  markActiveTasksAsInterrupted: () => number;
  /**
   * Register an already-persisted task in memory (batch orchestrator tasks
   * are created by the batch repository, not by createTask). Idempotent.
   */
  registerPersistedTask: (task: PipelineTask) => void;
}

let taskIdCounter = 0;
// Pipeline status changes are frequent and SQLite writes are asynchronous.
// Keep a per-task write chain so an earlier "reviewing" snapshot cannot finish
// after the successful review result and overwrite `stage_results` with stale
// (often empty) data on disk.
const taskPersistenceChains = new Map<string, Promise<void>>();
// 冷启动/超时分类只处理「已经开始」的任务。idle = 已创建但从未运行（例如
// 批次编排器预建的任务、创建后即被杀进程的单章任务）——保持 idle 才能安全
// 重跑，误标 interrupted 会让批次恢复时被判定 TASK_NOT_RECOVERABLE。
const interruptibleStatuses: PipelineTaskStatus[] = [
  'queued',
  'drafting',
  'reviewing',
  'factChecking',
  'briefing',
  'proofing',
];

/**
 * Classify and mark an interrupted active task. Recoverable tasks keep
 * resolvedAt=null so the task center can offer Resume.
 */
function interruptTask(task: PipelineTask, now: number): PipelineTask {
  const classification = classifyInterruptedTask(task);
  if (classification.recoverable) {
    return {
      ...task,
      status: 'interrupted',
      recoverable: true,
      error: classification.reason,
      updatedAt: now,
      // Keep unresolved so Resume remains available.
      resolvedAt: null,
      resolvedAction: null,
    };
  }
  return {
    ...task,
    status: 'failed',
    recoverable: false,
    error: classification.reason,
    updatedAt: now,
    // Do not auto-resolve: user should still see the failed task.
    resolvedAt: null,
    resolvedAction: null,
  };
}

function persistTask(task: PipelineTask) {
  // Capture an immutable value now: callers immediately continue to later
  // stages and Zustand state is intentionally mutable over time.
  const snapshot = {
    id: task.id,
    targetType: task.targetType,
    targetId: task.targetId,
    status: task.status,
    stageResults: task.stageResults.map(stage => ({ ...stage })),
    finalText: task.finalText,
    error: task.error,
    inputFingerprint: task.inputFingerprint ?? null,
    pipelineContextJson: task.pipelineContextJson ?? null,
    pipelineContextVersion: task.pipelineContextVersion ?? null,
    pipelineContextHash: task.pipelineContextHash ?? null,
    outlineWorkflowVersion: task.outlineWorkflowVersion ?? null,
    contextBudgetVersion: task.contextBudgetVersion ?? null,
    pipelineTopologyVersion: task.pipelineTopologyVersion ?? null,
    parentTaskId: task.parentTaskId ?? null,
    derivedKind: task.derivedKind ?? null,
    derivedInstruction: task.derivedInstruction ?? null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    resolvedAt: task.resolvedAt,
    resolvedAction: task.resolvedAction || null,
  };
  const previous = taskPersistenceChains.get(task.id) || Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => db.savePipelineTask(snapshot))
    .catch(err => {
      console.warn('[pipelineTaskStore] persistTask failed:', task.id, err);
    });
  taskPersistenceChains.set(task.id, next);
}

/**
 * Wait for any in-flight fire-and-forget writes for this task so a dedicated
 * context UPDATE does not race with a stale INSERT OR REPLACE.
 */
async function awaitTaskPersistenceQueue(taskId: string): Promise<void> {
  const previous = taskPersistenceChains.get(taskId);
  if (previous) {
    await previous.catch(() => undefined);
  }
}

export const usePipelineTaskStore = create<PipelineTaskState>((set, get) => ({
  tasks: [],
  _loaded: false,

  loadFromDB: async () => {
    if (get()._loaded) return;
    try {
      const rows = await db.getAllPipelineTasks();
      const tasks: PipelineTask[] = rows.map((row: any) => ({
        id: row.id,
        targetType: row.targetType,
        targetId: row.targetId,
        status: row.status,
        stageResults: row.stageResults || [],
        finalText: row.finalText,
        error: row.error,
        inputFingerprint: row.inputFingerprint ?? null,
        pipelineContextJson: row.pipelineContextJson ?? null,
        pipelineContextVersion: row.pipelineContextVersion ?? null,
        pipelineContextHash: row.pipelineContextHash ?? null,
        outlineWorkflowVersion:
          row.outlineWorkflowVersion != null
            ? Number(row.outlineWorkflowVersion)
            : null,
        contextBudgetVersion:
          row.contextBudgetVersion != null
            ? Number(row.contextBudgetVersion)
            : null,
        pipelineTopologyVersion:
          row.pipelineTopologyVersion != null
            ? Number(row.pipelineTopologyVersion)
            : null,
        parentTaskId: row.parentTaskId ?? null,
        derivedKind:
          row.derivedKind === 'final_rewrite' ? 'final_rewrite' : null,
        derivedInstruction: row.derivedInstruction ?? null,
        recoverable: row.status === 'interrupted' ? true : undefined,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        resolvedAt: row.resolvedAt,
        resolvedAction: row.resolvedAction || null,
      }));
      // Restore counter to avoid ID collision
      if (tasks.length > 0) {
        taskIdCounter = tasks.length + 100;
      }
      set({ tasks, _loaded: true });
    } catch (error) {
      // 8.6 修复：loadFromDB catch 吞错，DB 故障时 UI 显示"无任务"无反馈
      console.warn('[pipelineTaskStore] loadFromDB failed:', error);
      set({ _loaded: true });
    }
  },

  loadTaskDetails: async taskId => {
    const row = await db.getPipelineTaskResumePayload(taskId);
    if (!row) return;
    get().registerPersistedTask(row as PipelineTask);
  },

  createTask: async (targetType, targetId, versions) => {
    const now = Date.now();
    const id = `pt_${now.toString(36)}_${++taskIdCounter}`;
    const task: PipelineTask = {
      id,
      targetType,
      targetId,
      status: 'idle',
      stageResults: [],
      finalText: null,
      error: null,
      // §4.2: new tasks must EXPLICITLY freeze their protocol versions at
      // creation (never rely on the DB column default, which exists only
      // for pre-upgrade rows). Legacy callers (freeform) omit versions → 1.
      outlineWorkflowVersion: versions?.outlineWorkflowVersion ?? 1,
      contextBudgetVersion: versions?.contextBudgetVersion ?? 1,
      // §5.2: freeze the pipeline topology ONCE at task creation. New standard
      // callers pass compact (2); legacy/freeform callers omit → legacy (1).
      pipelineTopologyVersion:
        versions?.pipelineTopologyVersion ?? LEGACY_PIPELINE_TOPOLOGY_VERSION,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
    };
    // Compact Standard (二 Phase §6) omits the proof checkpoint; legacy keeps it.
    const checkpointStages: PipelineCheckpointStage[] =
      stageNamesForPipelineTopology({
        hasBrief: shouldIncludeBriefCheckpoint({
          outlineWorkflowVersion: task.outlineWorkflowVersion,
          contextBudgetVersion: task.contextBudgetVersion,
        }),
        pipelineTopologyVersion: task.pipelineTopologyVersion,
      });
    // Persist parent + pending checkpoints in ONE transaction BEFORE
    // the task enters the store or is handed to the runner. On failure we
    // do not add a ghost task, do not return an id, and do not start the
    // foreground service or reconcile — so LLM call count stays 0 and the
    // UI can surface a "无法启动流水线" error instead of hitting FK 787.
    try {
      await db.createPipelineTaskWithCheckpoints(
        {
          id,
          targetType,
          targetId,
          status: 'idle',
          stageResults: [],
          finalText: null,
          error: null,
          outlineWorkflowVersion: task.outlineWorkflowVersion ?? null,
          contextBudgetVersion: task.contextBudgetVersion ?? null,
          pipelineTopologyVersion: task.pipelineTopologyVersion ?? null,
          createdAt: now,
          updatedAt: now,
          resolvedAt: null,
        },
        checkpointStages,
      );
    } catch (err: any) {
      console.warn(
        '[pipelineTaskStore] PIPELINE_TASK_CREATE_FAILED',
        'taskId=', id,
        'targetType=', targetType,
        'targetId=', targetId,
        'code=', err?.code,
        'message=', err?.message,
      );
      throw err;
    }
    // Transaction committed: safe to expose the task to the rest of the app.
    set((state) => ({ tasks: [...state.tasks, task] }));
    return id;
  },

  updateTaskStage: (taskId, result) => {
    // Legacy non-await path: still dual-write via queue, replace per stage.
    void get().persistTaskStage(taskId, result).catch(err => {
      console.warn('[pipelineTaskStore] updateTaskStage persist failed:', taskId, err);
    });
  },

  persistTaskStage: async (taskId, result) => {
    await awaitTaskPersistenceQueue(taskId);
    const existing = get().tasks.find(t => t.id === taskId);
    if (!existing) {
      throw new Error(`persistTaskStage: task ${taskId} not found`);
    }

    try {
      await db.upsertStageCheckpoint({
        taskId,
        stage: result.stage,
        status: mapStageStatusToCheckpoint(result.status),
        outputText: result.text ?? null,
        errorCode: result.errorCode ?? null,
        errorMessage: result.error ?? null,
        inputTokens: result.tokens?.input ?? null,
        outputTokens: result.tokens?.output ?? null,
        totalTokens: result.tokens?.total ?? null,
        durationMs: result.durationMs ?? null,
      });
    } catch (err) {
      console.warn('[pipelineTaskStore] upsertStageCheckpoint failed:', taskId, err);
      throw err;
    }

    const now = Date.now();
    const next: PipelineTask = {
      ...existing,
      stageResults: mergeStageResult(existing.stageResults, result),
      updatedAt: now,
    };
    // Durable task row (stage_results projection) after checkpoint succeeds.
    await db.savePipelineTask({
      id: next.id,
      targetType: next.targetType,
      targetId: next.targetId,
      status: next.status,
      stageResults: next.stageResults,
      finalText: next.finalText,
      error: next.error,
      inputFingerprint: next.inputFingerprint ?? null,
      pipelineContextJson: next.pipelineContextJson ?? null,
      pipelineContextVersion: next.pipelineContextVersion ?? null,
      pipelineContextHash: next.pipelineContextHash ?? null,
      outlineWorkflowVersion: next.outlineWorkflowVersion ?? null,
      contextBudgetVersion: next.contextBudgetVersion ?? null,
      pipelineTopologyVersion: next.pipelineTopologyVersion ?? null,
      parentTaskId: next.parentTaskId ?? null,
      derivedKind: next.derivedKind ?? null,
      derivedInstruction: next.derivedInstruction ?? null,
      createdAt: next.createdAt,
      updatedAt: next.updatedAt,
      resolvedAt: next.resolvedAt,
      resolvedAction: next.resolvedAction || null,
    });

    set(state => ({
      tasks: state.tasks.map(t => (t.id === taskId ? next : t)),
    }));
  },

  setTaskStatus: (taskId, status) => {
    // Optimistic memory update for UI; durable write is awaited on critical paths.
    const existing = get().tasks.find(t => t.id === taskId);
    if (existing) {
      const next = { ...existing, status, updatedAt: Date.now() };
      set(state => ({
        tasks: state.tasks.map(t => (t.id === taskId ? next : t)),
      }));
      persistTask(next);
    }
  },

  persistTaskStatus: async (taskId, status) => {
    await awaitTaskPersistenceQueue(taskId);
    const existing = get().tasks.find(t => t.id === taskId);
    if (!existing) return;
    const next: PipelineTask = { ...existing, status, updatedAt: Date.now() };
    await db.savePipelineTask({
      id: next.id,
      targetType: next.targetType,
      targetId: next.targetId,
      status: next.status,
      stageResults: next.stageResults,
      finalText: next.finalText,
      error: next.error,
      inputFingerprint: next.inputFingerprint ?? null,
      pipelineContextJson: next.pipelineContextJson ?? null,
      pipelineContextVersion: next.pipelineContextVersion ?? null,
      pipelineContextHash: next.pipelineContextHash ?? null,
      outlineWorkflowVersion: next.outlineWorkflowVersion ?? null,
      contextBudgetVersion: next.contextBudgetVersion ?? null,
      pipelineTopologyVersion: next.pipelineTopologyVersion ?? null,
      parentTaskId: next.parentTaskId ?? null,
      derivedKind: next.derivedKind ?? null,
      derivedInstruction: next.derivedInstruction ?? null,
      createdAt: next.createdAt,
      updatedAt: next.updatedAt,
      resolvedAt: next.resolvedAt,
      resolvedAction: next.resolvedAction || null,
    });
    set(state => ({
      tasks: state.tasks.map(t => (t.id === taskId ? next : t)),
    }));
  },

  completeTask: (taskId, finalText) => {
    const existing = get().tasks.find(t => t.id === taskId);
    if (existing) {
      const next: PipelineTask = {
        ...existing,
        status: 'completed',
        finalText,
        error: null,
        updatedAt: Date.now(),
      };
      set(state => ({
        tasks: state.tasks.map(t => (t.id === taskId ? next : t)),
      }));
      persistTask(next);
    }
  },

  persistCompleteTask: async (taskId, finalText) => {
    await awaitTaskPersistenceQueue(taskId);
    const existing = get().tasks.find(t => t.id === taskId);
    if (!existing) return;
    const next: PipelineTask = {
      ...existing,
      status: 'completed',
      finalText,
      error: null,
      updatedAt: Date.now(),
    };
    await db.savePipelineTask({
      id: next.id,
      targetType: next.targetType,
      targetId: next.targetId,
      status: next.status,
      stageResults: next.stageResults,
      finalText: next.finalText,
      error: next.error,
      inputFingerprint: next.inputFingerprint ?? null,
      pipelineContextJson: next.pipelineContextJson ?? null,
      pipelineContextVersion: next.pipelineContextVersion ?? null,
      pipelineContextHash: next.pipelineContextHash ?? null,
      outlineWorkflowVersion: next.outlineWorkflowVersion ?? null,
      contextBudgetVersion: next.contextBudgetVersion ?? null,
      pipelineTopologyVersion: next.pipelineTopologyVersion ?? null,
      parentTaskId: next.parentTaskId ?? null,
      derivedKind: next.derivedKind ?? null,
      derivedInstruction: next.derivedInstruction ?? null,
      createdAt: next.createdAt,
      updatedAt: next.updatedAt,
      resolvedAt: next.resolvedAt,
      resolvedAction: next.resolvedAction || null,
    });
    set(state => ({
      tasks: state.tasks.map(t => (t.id === taskId ? next : t)),
    }));
  },

  setTaskFinalText: (taskId, finalText) => {
    const existing = get().tasks.find(t => t.id === taskId);
    if (existing) {
      const next: PipelineTask = {
        ...existing,
        finalText,
        updatedAt: Date.now(),
      };
      set(state => ({
        tasks: state.tasks.map(t => (t.id === taskId ? next : t)),
      }));
      persistTask(next);
    }
  },

  persistTaskFinalText: async (taskId, finalText) => {
    await awaitTaskPersistenceQueue(taskId);
    const existing = get().tasks.find(t => t.id === taskId);
    if (!existing) return;
    const next: PipelineTask = {
      ...existing,
      finalText,
      updatedAt: Date.now(),
    };
    await db.savePipelineTask({
      id: next.id,
      targetType: next.targetType,
      targetId: next.targetId,
      status: next.status,
      stageResults: next.stageResults,
      finalText: next.finalText,
      error: next.error,
      inputFingerprint: next.inputFingerprint ?? null,
      pipelineContextJson: next.pipelineContextJson ?? null,
      pipelineContextVersion: next.pipelineContextVersion ?? null,
      pipelineContextHash: next.pipelineContextHash ?? null,
      outlineWorkflowVersion: next.outlineWorkflowVersion ?? null,
      contextBudgetVersion: next.contextBudgetVersion ?? null,
      pipelineTopologyVersion: next.pipelineTopologyVersion ?? null,
      parentTaskId: next.parentTaskId ?? null,
      derivedKind: next.derivedKind ?? null,
      derivedInstruction: next.derivedInstruction ?? null,
      createdAt: next.createdAt,
      updatedAt: next.updatedAt,
      resolvedAt: next.resolvedAt,
      resolvedAction: next.resolvedAction || null,
    });
    set(state => ({
      tasks: state.tasks.map(t => (t.id === taskId ? next : t)),
    }));
  },

  failTask: (taskId, error) => {
    const existing = get().tasks.find(t => t.id === taskId);
    if (existing) {
      const next: PipelineTask = {
        ...existing,
        status: 'failed',
        error,
        updatedAt: Date.now(),
      };
      set(state => ({
        tasks: state.tasks.map(t => (t.id === taskId ? next : t)),
      }));
      persistTask(next);
    }
  },

  persistFailTask: async (taskId, error) => {
    await awaitTaskPersistenceQueue(taskId);
    const existing = get().tasks.find(t => t.id === taskId);
    if (!existing) return;
    const next: PipelineTask = {
      ...existing,
      status: 'failed',
      error,
      updatedAt: Date.now(),
    };
    await db.savePipelineTask({
      id: next.id,
      targetType: next.targetType,
      targetId: next.targetId,
      status: next.status,
      stageResults: next.stageResults,
      finalText: next.finalText,
      error: next.error,
      inputFingerprint: next.inputFingerprint ?? null,
      pipelineContextJson: next.pipelineContextJson ?? null,
      pipelineContextVersion: next.pipelineContextVersion ?? null,
      pipelineContextHash: next.pipelineContextHash ?? null,
      outlineWorkflowVersion: next.outlineWorkflowVersion ?? null,
      contextBudgetVersion: next.contextBudgetVersion ?? null,
      pipelineTopologyVersion: next.pipelineTopologyVersion ?? null,
      parentTaskId: next.parentTaskId ?? null,
      derivedKind: next.derivedKind ?? null,
      derivedInstruction: next.derivedInstruction ?? null,
      createdAt: next.createdAt,
      updatedAt: next.updatedAt,
      resolvedAt: next.resolvedAt,
      resolvedAction: next.resolvedAction || null,
    });
    set(state => ({
      tasks: state.tasks.map(t => (t.id === taskId ? next : t)),
    }));
  },

  cancelTask: (taskId) => {
    set((state) => {
      const tasks = state.tasks.map((t) =>
        t.id === taskId
          ? {
              ...t,
              status: 'cancelled' as PipelineTaskStatus,
              recoverable: false,
              updatedAt: Date.now(),
            }
          : t
      );
      const task = tasks.find((t) => t.id === taskId);
      if (task) persistTask(task);
      return { tasks };
    });
  },

  setTaskInputFingerprint: (taskId, fingerprint) => {
    set((state) => {
      const tasks = state.tasks.map((t) =>
        t.id === taskId ? { ...t, inputFingerprint: fingerprint } : t
      );
      const task = tasks.find((t) => t.id === taskId);
      if (task) persistTask(task);
      return { tasks };
    });
  },

  setTaskPipelineContext: (taskId, snapshot) => {
    set(state => {
      const tasks = state.tasks.map(t =>
        t.id === taskId
          ? {
              ...t,
              pipelineContextJson: snapshot.pipelineContextJson,
              pipelineContextVersion: snapshot.pipelineContextVersion,
              pipelineContextHash: snapshot.pipelineContextHash,
              updatedAt: Date.now(),
            }
          : t,
      );
      const task = tasks.find(t => t.id === taskId);
      if (task) persistTask(task);
      return { tasks };
    });
  },

  syncTaskPipelineContext: (taskId, snapshot) => {
    const now = Date.now();
    set(state => ({
      tasks: state.tasks.map(t =>
        t.id === taskId
          ? {
              ...t,
              pipelineContextJson: snapshot.pipelineContextJson,
              pipelineContextVersion: snapshot.pipelineContextVersion,
              pipelineContextHash: snapshot.pipelineContextHash,
              updatedAt: now,
            }
          : t,
      ),
    }));
  },

  persistTaskPipelineContext: async (taskId, snapshot) => {
    // Ensure the task row exists (createTask may still be flushing INSERT).
    await awaitTaskPersistenceQueue(taskId);

    const existing = get().tasks.find(t => t.id === taskId);
    if (!existing) {
      throw new OutlineContextError(
        'OUTLINE_SNAPSHOT_PERSIST_FAILED',
        '冻结上下文保存失败：找不到流水线任务。',
        'restart_task',
      );
    }

    try {
      await db.updatePipelineTaskContext(taskId, {
        json: snapshot.pipelineContextJson,
        version: snapshot.pipelineContextVersion,
        hash: snapshot.pipelineContextHash,
      });
    } catch (error: any) {
      throw new OutlineContextError(
        'OUTLINE_SNAPSHOT_PERSIST_FAILED',
        `冻结上下文保存失败：${error?.message ? String(error.message) : '数据库写入错误'}。已阻止调用模型。`,
        'restart_task',
      );
    }

    // Sync memory only after durable write succeeds.
    const now = Date.now();
    set(state => ({
      tasks: state.tasks.map(t =>
        t.id === taskId
          ? {
              ...t,
              pipelineContextJson: snapshot.pipelineContextJson,
              pipelineContextVersion: snapshot.pipelineContextVersion,
              pipelineContextHash: snapshot.pipelineContextHash,
              updatedAt: now,
            }
          : t,
      ),
    }));
  },

  resolveTask: (taskId, action) => {
    set((state) => {
      const tasks = state.tasks.map((t) =>
        t.id === taskId ? { ...t, resolvedAt: Date.now(), resolvedAction: action, updatedAt: Date.now() } : t
      );
      const task = tasks.find((t) => t.id === taskId);
      if (task) persistTask(task);
      return { tasks };
    });
  },

  clearResolved: async () => {
    try {
      await db.deleteResolvedPipelineTasks();
      set((state) => ({
        tasks: state.tasks.filter((t) => t.resolvedAt === null),
      }));
    } catch (err) {
      console.warn('[pipelineTaskStore] clearResolved DB delete failed:', err);
    }
  },

  getActiveTaskForTarget: (targetType, targetId) => {
    return get().tasks.find(
      (t) =>
        t.targetType === targetType &&
        t.targetId === targetId &&
        t.resolvedAt === null &&
        (t.status === 'idle' || t.status === 'queued' || t.status === 'drafting' || t.status === 'reviewing' || t.status === 'factChecking' || t.status === 'proofing')
    );
  },

  /**
   * 查找一个仍然可从中间阶段继续的 failed/interrupted task。
   * 返回的 task 代表“以前跑过一部分、但某个阶段中断了”——用户再次点 AI 续写时
   * 应该调 resumePipeline 而不是创建新任务，从而保留已成功的 stage 检查点、
   * frozen request 与已完成的输出，避免重发前面阶段已经走过的 LLM 请求。
   * 在内存中的 task 列表与已持久化的 checkpoints 同时检查（checkpoint 是
   * resume 的真正唯一依据，task. stageResults 是 UI 投影）。
   */
  getLatestResumableFailedTask: (
    targetType: 'chapter' | 'freeform',
    targetId: number,
  ): PipelineTask | undefined => {
    const candidates = get()
      .tasks.filter(
        t =>
          t.targetType === targetType &&
          t.targetId === targetId &&
          t.resolvedAt === null &&
          (t.status === 'failed' || t.status === 'interrupted'),
      )
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return candidates[0];
  },

  registerPersistedTask: (task) => {
    set(state => {
      const exists = state.tasks.some(t => t.id === task.id);
      return {
        tasks: exists
          ? state.tasks.map(t => (t.id === task.id ? task : t))
          : [...state.tasks, task],
      };
    });
  },

  markStaleTasksAsFailed: (staleMs = 10 * 60 * 1000) => {
    // 单阶段 LLM 耗时可能较长（尤其长文本生成），过短阈值会误判仍在运行的任务。
    // 超时后仍按可恢复性分类，不把有 Draft + 合法快照的任务永久判死。
    const now = Date.now();
    let marked = 0;
    set((state) => {
      const tasks = state.tasks.map((t) => {
        if (
          !t.resolvedAt &&
          interruptibleStatuses.includes(t.status) &&
          now - (t.updatedAt || t.createdAt) > staleMs
        ) {
          marked += 1;
          const updated = interruptTask(t, now);
          persistTask(updated);
          return updated;
        }
        return t;
      });
      return { tasks };
    });
    return marked;
  },

  markActiveTasksAsInterrupted: () => {
    const now = Date.now();
    let marked = 0;
    // Best-effort: flip any running stage checkpoints to interrupted (Schema 39+).
    void db.interruptAllRunningStages?.().catch(() => undefined);
    set((state) => {
      const tasks = state.tasks.map((task) => {
        // Cold start: only tasks that actually started (queued..proofing)
        // mean the previous process died mid-run. idle tasks (e.g. batch
        // pre-created ones) must stay idle so they can safely run/resume.
        if (task.resolvedAt === null && interruptibleStatuses.includes(task.status)) {
          marked += 1;
          const updated = interruptTask(task, now);
          persistTask(updated);
          return updated;
        }
        return task;
      });
      // Do not publish a new array when there was no active task. Startup
      // calls this immediately after loading persisted tasks; publishing an
      // unchanged array would make global terminal-task subscribers scan the
      // history a second time and can replace a fresh success prompt with an
      // older failure prompt.
      return marked > 0 ? { tasks } : state;
    });
    return marked;
  },

  getUnresolvedCount: () => {
    return get().tasks.filter((t) => t.resolvedAt === null).length;
  },
}));
