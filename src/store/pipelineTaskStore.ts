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
  /** 冷启动时中断上次进程遗留的全部活跃任务；不会伪装为可继续运行。 */
  markActiveTasksAsInterrupted: () => number;
}

let taskIdCounter = 0;
const activeStatuses: PipelineTaskStatus[] = ['idle', 'drafting', 'reviewing', 'factChecking', 'proofing'];

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
        (t.status === 'idle' || t.status === 'drafting' || t.status === 'reviewing' || t.status === 'factChecking' || t.status === 'proofing')
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
