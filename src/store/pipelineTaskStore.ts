import { create } from 'zustand';
import * as db from '../services/database';
import type { PipelineTask, PipelineStageResult, PipelineTaskStatus } from '../types/pipeline';

interface PipelineTaskState {
  tasks: PipelineTask[];
  _loaded: boolean;
  loadFromDB: () => Promise<void>;
  createTask: (targetType: 'chapter' | 'freeform', targetId: number) => string;
  updateTaskStage: (taskId: string, result: PipelineStageResult) => void;
  setTaskStatus: (taskId: string, status: PipelineTaskStatus) => void;
  completeTask: (taskId: string, finalText: string) => void;
  /**
   * Persist final/draft text without changing task status.
   * Used on degraded paths (audit/proof failed) so failed is not overwritten
   * by completeTask, while UI can still show the retained draft.
   */
  setTaskFinalText: (taskId: string, finalText: string) => void;
  failTask: (taskId: string, error: string) => void;
  cancelTask: (taskId: string) => void;
  /**
   * Persist the frozen input fingerprint on a task (projectId | chapterId |
   * chapterUpdatedAt | outlineFingerprint). Called by the runner at terminal
   * state so the result-adoption flow can later detect outline/chapter drift.
   */
  setTaskInputFingerprint: (taskId: string, fingerprint: string) => void;
  /**
   * Persist the frozen PipelineContextSnapshot (Schema 38+) before the first
   * LLM call so resume can reuse the same outline/context after process death.
   */
  setTaskPipelineContext: (
    taskId: string,
    snapshot: {
      pipelineContextJson: string;
      pipelineContextVersion: number;
      pipelineContextHash: string;
    },
  ) => void;
  resolveTask: (taskId: string, action: 'accept' | 'reject') => void;
  clearResolved: () => void;
  getActiveTaskForTarget: (targetType: 'chapter' | 'freeform', targetId: number) => PipelineTask | undefined;
  getUnresolvedCount: () => number;
  /** 把 updatedAt 超过 staleMs 的活跃任务标记为 failed（用于回前台自愈）。返回标记的任务数。 */
  markStaleTasksAsFailed: (staleMs?: number) => number;
  /** 冷启动时中断上次进程遗留的全部活跃任务；不会伪装为可继续运行。 */
  markActiveTasksAsInterrupted: () => number;
}

let taskIdCounter = 0;
// Pipeline status changes are frequent and SQLite writes are asynchronous.
// Keep a per-task write chain so an earlier "reviewing" snapshot cannot finish
// after the successful review result and overwrite `stage_results` with stale
// (often empty) data on disk.
const taskPersistenceChains = new Map<string, Promise<void>>();
const activeStatuses: PipelineTaskStatus[] = ['idle', 'queued', 'drafting', 'reviewing', 'factChecking', 'proofing'];

function interruptTask(task: PipelineTask, now: number): PipelineTask {
  return {
    ...task,
    status: 'failed',
    error: '运行被中断（App 已退出或任务已停止）',
    updatedAt: now,
    // 不再弹出过期任务的全局结果提示，也不会阻塞同章节重新生成。
    resolvedAt: now,
    resolvedAction: 'reject',
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

  createTask: (targetType, targetId) => {
    const id = `pt_${Date.now().toString(36)}_${++taskIdCounter}`;
    const task: PipelineTask = {
      id,
      targetType,
      targetId,
      status: 'idle',
      stageResults: [],
      finalText: null,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      resolvedAt: null,
    };
    set((state) => ({ tasks: [...state.tasks, task] }));
    persistTask(task);
    return id;
  },

  updateTaskStage: (taskId, result) => {
    set((state) => {
      const tasks = state.tasks.map((t) =>
        t.id === taskId
          ? { ...t, stageResults: [...t.stageResults, result], updatedAt: Date.now() }
          : t
      );
      const task = tasks.find((t) => t.id === taskId);
      if (task) persistTask(task);
      return { tasks };
    });
  },

  setTaskStatus: (taskId, status) => {
    set((state) => {
      const tasks = state.tasks.map((t) =>
        t.id === taskId ? { ...t, status, updatedAt: Date.now() } : t
      );
      const task = tasks.find((t) => t.id === taskId);
      if (task) persistTask(task);
      return { tasks };
    });
  },

  completeTask: (taskId, finalText) => {
    set((state) => {
      const tasks = state.tasks.map((t) =>
        t.id === taskId
          ? { ...t, status: 'completed' as PipelineTaskStatus, finalText, updatedAt: Date.now() }
          : t
      );
      const task = tasks.find((t) => t.id === taskId);
      if (task) persistTask(task);
      return { tasks };
    });
  },

  setTaskFinalText: (taskId, finalText) => {
    set((state) => {
      const tasks = state.tasks.map((t) =>
        t.id === taskId
          ? { ...t, finalText, updatedAt: Date.now() }
          : t
      );
      const task = tasks.find((t) => t.id === taskId);
      if (task) persistTask(task);
      return { tasks };
    });
  },

  failTask: (taskId, error) => {
    set((state) => {
      const tasks = state.tasks.map((t) =>
        t.id === taskId ? { ...t, status: 'failed' as PipelineTaskStatus, error, updatedAt: Date.now() } : t
      );
      const task = tasks.find((t) => t.id === taskId);
      if (task) persistTask(task);
      return { tasks };
    });
  },

  cancelTask: (taskId) => {
    set((state) => {
      const tasks = state.tasks.map((t) =>
        t.id === taskId ? { ...t, status: 'cancelled' as PipelineTaskStatus, updatedAt: Date.now() } : t
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

  markStaleTasksAsFailed: (staleMs = 10 * 60 * 1000) => {
    // 单阶段 LLM 耗时可能较长（尤其长文本生成），过短阈值会误判仍在运行的任务。
    const now = Date.now();
    let marked = 0;
    set((state) => {
      const tasks = state.tasks.map((t) => {
        if (
          !t.resolvedAt &&
          activeStatuses.includes(t.status) &&
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
    set((state) => {
      const tasks = state.tasks.map((task) => {
        // JS/原生流水线不具备跨进程恢复执行能力。冷启动时看到活跃状态，
        // 只能说明上个进程已中断，绝不能继续占用章节的生成入口。
        if (task.resolvedAt === null && activeStatuses.includes(task.status)) {
          marked += 1;
          const updated = interruptTask(task, now);
          persistTask(updated);
          return updated;
        }
        return task;
      });
      return { tasks };
    });
    return marked;
  },

  getUnresolvedCount: () => {
    return get().tasks.filter((t) => t.resolvedAt === null).length;
  },
}));
