/* eslint-env jest */

const mockGetAllPipelineTasks = jest.fn();
const mockSavePipelineTask = jest.fn();
const mockDeleteResolvedPipelineTasks = jest.fn();

jest.mock('../src/services/database', () => ({
  getAllPipelineTasks: (...args: any[]) => mockGetAllPipelineTasks(...args),
  savePipelineTask: (...args: any[]) => mockSavePipelineTask(...args),
  deleteResolvedPipelineTasks: (...args: any[]) => mockDeleteResolvedPipelineTasks(...args),
}));

import { usePipelineTaskStore } from '../src/store/pipelineTaskStore';

const persistedRow = {
  id: 'persisted',
  targetType: 'chapter',
  targetId: 1,
  status: 'drafting',
  stageResults: [{ stage: 'draft' }],
  finalText: null,
  error: null,
  createdAt: 1,
  updatedAt: 2,
  resolvedAt: null,
  resolvedAction: null,
};

describe('pipeline task store complete lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAllPipelineTasks.mockResolvedValue([persistedRow]);
    mockSavePipelineTask.mockResolvedValue(undefined);
    mockDeleteResolvedPipelineTasks.mockResolvedValue(undefined);
    usePipelineTaskStore.setState({ tasks: [], _loaded: false });
  });

  test('loads once, restores task IDs, and handles a database failure', async () => {
    await usePipelineTaskStore.getState().loadFromDB();
    expect(usePipelineTaskStore.getState()._loaded).toBe(true);
    expect(usePipelineTaskStore.getState().tasks[0]).toMatchObject({ id: 'persisted' });
    await usePipelineTaskStore.getState().loadFromDB();
    expect(mockGetAllPipelineTasks).toHaveBeenCalledTimes(1);

    usePipelineTaskStore.setState({ tasks: [], _loaded: false });
    mockGetAllPipelineTasks.mockRejectedValueOnce(new Error('数据库失败'));
    await usePipelineTaskStore.getState().loadFromDB();
    expect(usePipelineTaskStore.getState()._loaded).toBe(true);
    expect(usePipelineTaskStore.getState().tasks).toEqual([]);
  });

  test('creates and updates every task status, stage, result, and resolution', async () => {
    const store = usePipelineTaskStore.getState();
    const id = store.createTask('chapter', 1);
    await Promise.resolve();
    expect(id).toMatch(/^pt_/);
    store.updateTaskStage(id, { stage: 'draft', status: 'completed', output: '草稿' } as any);
    store.setTaskStatus(id, 'reviewing');
    store.completeTask(id, '最终文本');
    store.failTask(id, '失败原因');
    store.cancelTask(id);
    store.resolveTask(id, 'accept');
    await Promise.resolve();
    const task = usePipelineTaskStore.getState().tasks.find(item => item.id === id)!;
    expect(task.status).toBe('cancelled');
    expect(task.stageResults).toHaveLength(1);
    expect(task.resolvedAction).toBe('accept');
    expect(mockSavePipelineTask).toHaveBeenCalled();

    store.updateTaskStage('missing', { stage: 'draft' } as any);
    store.setTaskStatus('missing', 'idle');
    store.completeTask('missing', '');
    store.failTask('missing', '');
    store.cancelTask('missing');
    store.resolveTask('missing', 'reject');
  });

  test('clears resolved tasks and exposes active-task queries', async () => {
    const now = Date.now();
    usePipelineTaskStore.setState({
      tasks: [
        { ...persistedRow, id: 'active', status: 'idle', updatedAt: now, resolvedAt: null },
        { ...persistedRow, id: 'resolved', status: 'completed', resolvedAt: now, resolvedAction: 'reject' },
      ] as any,
      _loaded: true,
    });
    const state = usePipelineTaskStore.getState();
    expect(state.getActiveTaskForTarget('chapter', 1)?.id).toBe('active');
    expect(state.getActiveTaskForTarget('freeform', 1)).toBeUndefined();
    expect(state.getUnresolvedCount()).toBe(1);
    await state.clearResolved();
    expect(usePipelineTaskStore.getState().tasks.map(task => task.id)).toEqual(['active']);

    mockDeleteResolvedPipelineTasks.mockRejectedValueOnce(new Error('删除失败'));
    await usePipelineTaskStore.getState().clearResolved();
    expect(usePipelineTaskStore.getState().tasks).toHaveLength(1);
  });
});
