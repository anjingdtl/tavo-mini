import { create } from 'zustand';

export type StoryMemoryTaskKind =
  | 'checkpoint'
  | 'rebuild'
  | 'bootstrap'
  | 'hard_gap_repair'
  | 'manual';

export type StoryMemoryTaskPhase =
  | 'preparing'
  | 'planning'
  | 'requesting'
  | 'validating'
  | 'applying'
  | 'saving'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'outcome_unknown';

export interface StoryMemoryTaskProgress {
  taskId: string;
  projectId: number;
  kind: StoryMemoryTaskKind;
  phase: StoryMemoryTaskPhase;
  totalChapters: number;
  completedChapters: number;
  totalBatches: number;
  completedBatches: number;
  currentFromPosition: number | null;
  currentThroughPosition: number | null;
  currentAttempt: number | null;
  maxAttempts: number;
  percent: number;
  startedAt: number;
  updatedAt: number;
  message: string;
  error?: string;
}

export type StoryMemoryTaskProgressPatch = Partial<
  Omit<StoryMemoryTaskProgress, 'taskId' | 'projectId' | 'startedAt'>
>;

interface StoryMemoryTaskStoreState {
  tasks: Record<string, StoryMemoryTaskProgress>;
  startTask: (progress: StoryMemoryTaskProgress) => void;
  updateTask: (taskId: string, patch: StoryMemoryTaskProgressPatch) => void;
  finishTask: (
    taskId: string,
    phase: Extract<
      StoryMemoryTaskPhase,
      'completed' | 'failed' | 'cancelled' | 'outcome_unknown'
    >,
    message: string,
    error?: string,
  ) => void;
  getTask: (taskId: string) => StoryMemoryTaskProgress | undefined;
  clearTask: (taskId: string) => void;
  resetForTest: () => void;
}

export function storyMemoryTaskId(projectId: number): string {
  return `story-memory:${projectId}`;
}

export function storyMemoryPercent(
  completedChapters: number,
  totalChapters: number,
): number {
  if (totalChapters <= 0) return 100;
  return Math.max(
    0,
    Math.min(100, Math.round((completedChapters / totalChapters) * 100)),
  );
}

export const useStoryMemoryTaskStore = create<StoryMemoryTaskStoreState>(
  (set, get) => ({
    tasks: {},
    startTask: progress =>
      set(state => ({
        tasks: {
          ...state.tasks,
          [progress.taskId]: {
            ...progress,
            percent: storyMemoryPercent(
              progress.completedChapters,
              progress.totalChapters,
            ),
          },
        },
      })),
    updateTask: (taskId, patch) =>
      set(state => {
        const previous = state.tasks[taskId];
        if (!previous) return state;
        const next = { ...previous, ...patch, updatedAt: Date.now() };
        next.percent = storyMemoryPercent(
          next.completedChapters,
          next.totalChapters,
        );
        return { tasks: { ...state.tasks, [taskId]: next } };
      }),
    finishTask: (taskId, phase, message, error) =>
      set(state => {
        const previous = state.tasks[taskId];
        if (!previous) return state;
        const completed = phase === 'completed' ? previous.totalChapters : previous.completedChapters;
        const next: StoryMemoryTaskProgress = {
          ...previous,
          phase,
          completedChapters: completed,
          completedBatches:
            phase === 'completed'
              ? previous.totalBatches
              : previous.completedBatches,
          percent: storyMemoryPercent(completed, previous.totalChapters),
          updatedAt: Date.now(),
          message,
          ...(error ? { error } : {}),
        };
        return { tasks: { ...state.tasks, [taskId]: next } };
      }),
    getTask: taskId => get().tasks[taskId],
    clearTask: taskId =>
      set(state => {
        const next = { ...state.tasks };
        delete next[taskId];
        return { tasks: next };
      }),
    resetForTest: () => set({ tasks: {} }),
  }),
);
