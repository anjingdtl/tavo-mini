import { usePipelineTaskStore } from '../src/store/pipelineTaskStore';

jest.mock('../src/services/database', () => ({
  getAllPipelineTasks: jest.fn(async () => []),
  savePipelineTask: jest.fn(async () => undefined),
  deleteResolvedPipelineTasks: jest.fn(async () => undefined),
  upsertStageCheckpoint: jest.fn(async () => undefined),
  interruptAllRunningStages: jest.fn(async () => 0),
  claimStageCheckpoint: jest.fn(async () => true),
  getStageCheckpoints: jest.fn(async () => []),
}));

describe('pipelineTaskStore.markStaleTasksAsFailed', () => {
  beforeEach(() => {
    usePipelineTaskStore.setState({ tasks: [], _loaded: true });
    jest.clearAllMocks();
  });

  it('marks tasks whose updatedAt exceeds the stale threshold as failed', () => {
    const now = Date.now();
    // 默认阈值为 10 分钟，staleTask 超过该阈值
    const staleTask: any = {
      id: 'stale-1',
      targetType: 'chapter',
      targetId: 1,
      status: 'drafting',
      stageResults: [],
      finalText: null,
      error: null,
      createdAt: now - 15 * 60 * 1000,
      updatedAt: now - 15 * 60 * 1000,
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
    expect(tasks.find(t => t.id === 'stale-1')?.error).toMatch(/运行被中断/);
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

  it('marks even a recent active task as interrupted on a fresh app process', () => {
    const now = Date.now();
    usePipelineTaskStore.setState({ tasks: [{
      id: 'just-stopped', targetType: 'chapter', targetId: 1, status: 'drafting',
      stageResults: [], finalText: null, error: null, createdAt: now, updatedAt: now, resolvedAt: null,
    } as any] });

    expect(usePipelineTaskStore.getState().markActiveTasksAsInterrupted()).toBe(1);
    const task = usePipelineTaskStore.getState().tasks[0];
    // No successful draft → failed, but keep unresolved so user can see it.
    expect(task.status).toBe('failed');
    expect(task.resolvedAt).toBeNull();
    expect(task.error).toMatch(/没有成功的初稿|无法安全恢复|中断/);
  });
});

describe('pipelineTaskStore.setTaskFinalText', () => {
  beforeEach(() => {
    usePipelineTaskStore.setState({ tasks: [], _loaded: true });
    jest.clearAllMocks();
  });

  it('sets finalText without overwriting failed status or error', () => {
    const now = Date.now();
    usePipelineTaskStore.setState({
      tasks: [
        {
          id: 'degraded-1',
          targetType: 'chapter',
          targetId: 1,
          status: 'failed',
          stageResults: [],
          finalText: null,
          error: '文学评估失败，已保留初稿，未生成终审稿。',
          createdAt: now,
          updatedAt: now,
          resolvedAt: null,
        } as any,
      ],
    });

    usePipelineTaskStore.getState().setTaskFinalText('degraded-1', 'draft body');

    const task = usePipelineTaskStore.getState().tasks[0];
    expect(task.status).toBe('failed');
    expect(task.error).toMatch(/已保留初稿/);
    expect(task.finalText).toBe('draft body');
  });

  it('completeTask still marks completed on success path', () => {
    const now = Date.now();
    usePipelineTaskStore.setState({
      tasks: [
        {
          id: 'ok-1',
          targetType: 'chapter',
          targetId: 1,
          status: 'proofing',
          stageResults: [],
          finalText: null,
          error: null,
          createdAt: now,
          updatedAt: now,
          resolvedAt: null,
        } as any,
      ],
    });

    usePipelineTaskStore.getState().completeTask('ok-1', 'final text');
    const task = usePipelineTaskStore.getState().tasks[0];
    expect(task.status).toBe('completed');
    expect(task.finalText).toBe('final text');
  });
});
