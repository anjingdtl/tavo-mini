import { usePipelineTaskStore } from '../src/store/pipelineTaskStore';

jest.mock('../src/services/database', () => ({
  getAllPipelineTasks: jest.fn(async () => []),
  savePipelineTask: jest.fn(async () => undefined),
  deleteResolvedPipelineTasks: jest.fn(async () => undefined),
}));

describe('pipelineTaskStore.markStaleTasksAsFailed', () => {
  beforeEach(() => {
    usePipelineTaskStore.setState({ tasks: [], _loaded: true });
    jest.clearAllMocks();
  });

  it('marks tasks whose updatedAt exceeds the stale threshold as failed', () => {
    const now = Date.now();
    const staleTask: any = {
      id: 'stale-1',
      targetType: 'chapter',
      targetId: 1,
      status: 'drafting',
      stageResults: [],
      finalText: null,
      error: null,
      createdAt: now - 10 * 60 * 1000,
      updatedAt: now - 10 * 60 * 1000,
      resolvedAt: null,
    };
    const freshTask: any = {
      ...staleTask,
      id: 'fresh-1',
      status: 'reviewing',
      updatedAt: now - 1000,
    };
    usePipelineTaskStore.setState({ tasks: [staleTask, freshTask] });

    const marked = usePipelineTaskStore.getState().markStaleTasksAsFailed();

    expect(marked).toBe(1);
    const tasks = usePipelineTaskStore.getState().tasks;
    expect(tasks.find(t => t.id === 'stale-1')?.status).toBe('failed');
    expect(tasks.find(t => t.id === 'stale-1')?.error).toBe('运行被中断（App 可能被系统挂起）');
    expect(tasks.find(t => t.id === 'fresh-1')?.status).toBe('reviewing');
  });

  it('does not touch terminal or resolved tasks', () => {
    const now = Date.now();
    const completedStale: any = {
      id: 'done-1',
      targetType: 'chapter',
      targetId: 1,
      status: 'completed',
      stageResults: [],
      finalText: 'done',
      error: null,
      createdAt: now - 10 * 60 * 1000,
      updatedAt: now - 10 * 60 * 1000,
      resolvedAt: null,
    };
    const resolvedActive: any = {
      id: 'resolved-1',
      targetType: 'chapter',
      targetId: 2,
      status: 'drafting',
      stageResults: [],
      finalText: null,
      error: null,
      createdAt: now - 10 * 60 * 1000,
      updatedAt: now - 10 * 60 * 1000,
      resolvedAt: now,
    };
    usePipelineTaskStore.setState({ tasks: [completedStale, resolvedActive] });

    const marked = usePipelineTaskStore.getState().markStaleTasksAsFailed();

    expect(marked).toBe(0);
    const tasks = usePipelineTaskStore.getState().tasks;
    expect(tasks.find(t => t.id === 'done-1')?.status).toBe('completed');
    expect(tasks.find(t => t.id === 'resolved-1')?.status).toBe('drafting');
  });

  it('respects a custom staleMs threshold', () => {
    const now = Date.now();
    const recentTask: any = {
      id: 'recent-1',
      targetType: 'chapter',
      targetId: 1,
      status: 'drafting',
      stageResults: [],
      finalText: null,
      error: null,
      createdAt: now - 30 * 1000,
      updatedAt: now - 30 * 1000,
      resolvedAt: null,
    };
    usePipelineTaskStore.setState({ tasks: [recentTask] });

    // Default threshold (5 min) should not mark a 30s-old task
    expect(usePipelineTaskStore.getState().markStaleTasksAsFailed()).toBe(0);
    // 10s threshold should mark it
    expect(usePipelineTaskStore.getState().markStaleTasksAsFailed(10 * 1000)).toBe(1);
    expect(usePipelineTaskStore.getState().tasks[0].status).toBe('failed');
  });
});
