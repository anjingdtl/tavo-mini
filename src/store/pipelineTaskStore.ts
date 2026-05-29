import { create } from 'zustand';
import type { PipelineTask, PipelineStageResult, PipelineTaskStatus } from '../types/pipeline';

interface PipelineTaskState {
  tasks: PipelineTask[];
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
}

let taskIdCounter = 0;

export const usePipelineTaskStore = create<PipelineTaskState>((set, get) => ({
  tasks: [],

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
    return id;
  },

  updateTaskStage: (taskId, result) => {
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === taskId
          ? { ...t, stageResults: [...t.stageResults, result], updatedAt: Date.now() }
          : t
      ),
    }));
  },

  setTaskStatus: (taskId, status) => {
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === taskId ? { ...t, status, updatedAt: Date.now() } : t
      ),
    }));
  },

  completeTask: (taskId, finalText) => {
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === taskId
          ? { ...t, status: 'completed', finalText, updatedAt: Date.now() }
          : t
      ),
    }));
  },

  failTask: (taskId, error) => {
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === taskId ? { ...t, status: 'failed', error, updatedAt: Date.now() } : t
      ),
    }));
  },

  cancelTask: (taskId) => {
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === taskId ? { ...t, status: 'cancelled', updatedAt: Date.now() } : t
      ),
    }));
  },

  resolveTask: (taskId) => {
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === taskId ? { ...t, resolvedAt: Date.now(), updatedAt: Date.now() } : t
      ),
    }));
  },

  clearResolved: () => {
    set((state) => ({
      tasks: state.tasks.filter((t) => t.resolvedAt === null),
    }));
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

  getUnresolvedCount: () => {
    return get().tasks.filter((t) => t.resolvedAt === null).length;
  },
}));
