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
  failTask: (taskId: string, error: string) => void;
  cancelTask: (taskId: string) => void;
  resolveTask: (taskId: string, action: 'accept' | 'reject') => void;
  clearResolved: () => void;
  getActiveTaskForTarget: (targetType: 'chapter' | 'freeform', targetId: number) => PipelineTask | undefined;
  getUnresolvedCount: () => number;
  /** 把 updatedAt 超过 staleMs 的活跃任务标记为 failed（用于回前台自愈）。返回标记的任务数。 */
  markStaleTasksAsFailed: (staleMs?: number) => number;
}

let taskIdCounter = 0;

function persistTask(task: PipelineTask) {
  db.savePipelineTask({
    id: task.id,
    targetType: task.targetType,
    targetId: task.targetId,
    status: task.status,
    stageResults: task.stageResults,
    finalText: task.finalText,
    error: task.error,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    resolvedAt: task.resolvedAt,
    resolvedAction: task.resolvedAction || null,
  }).catch((err) => {
    console.warn('[pipelineTaskStore] persistTask failed:', task.id, err);
  });
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
    } catch {
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

  resolveTask: (taskId, action) => {
    set((state) => {
      const tasks = state.tasks.map((t) =>
        t.id === taskId ? { ...t, resolvedAt: Date.now(), resolvedAction: action, updatedAt: Date.now() } : t
      );
      const task = tasks.find((t) => t.id === taskId);
      if (task) {
        db.savePipelineTask({
          id: task.id,
          targetType: task.targetType,
          targetId: task.targetId,
          status: task.status,
          stageResults: task.stageResults,
          finalText: task.finalText,
          error: task.error,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          resolvedAt: task.resolvedAt,
          resolvedAction: action,
        }).catch(() => {});
      }
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
        (t.status === 'idle' || t.status === 'drafting' || t.status === 'reviewing' || t.status === 'proofing')
    );
  },

  markStaleTasksAsFailed: (staleMs = 5 * 60 * 1000) => {
    const now = Date.now();
    const staleStatuses: PipelineTaskStatus[] = ['idle', 'drafting', 'reviewing', 'proofing'];
    let marked = 0;
    set((state) => {
      const tasks = state.tasks.map((t) => {
        if (
          !t.resolvedAt &&
          staleStatuses.includes(t.status) &&
          now - (t.updatedAt || t.createdAt) > staleMs
        ) {
          marked += 1;
          const updated: PipelineTask = {
            ...t,
            status: 'failed' as PipelineTaskStatus,
            error: '运行被中断（App 可能被系统挂起）',
            updatedAt: now,
          };
          persistTask(updated);
          return updated;
        }
        return t;
      });
      return { tasks };
    });
    return marked;
  },

  getUnresolvedCount: () => {
    return get().tasks.filter((t) => t.resolvedAt === null).length;
  },
}));
