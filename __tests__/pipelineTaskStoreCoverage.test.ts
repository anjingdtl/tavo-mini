/* eslint-env jest */

const mockGetAllPipelineTasks = jest.fn();
const mockSavePipelineTask = jest.fn();
const mockDeleteResolvedPipelineTasks = jest.fn();

jest.mock('../src/services/database', () => ({
  getAllPipelineTasks: (...args: any[]) => mockGetAllPipelineTasks(...args),
  savePipelineTask: (...args: any[]) => mockSavePipelineTask(...args),
  deleteResolvedPipelineTasks: (...args: any[]) => mockDeleteResolvedPipelineTasks(...args),
  upsertStageCheckpoint: jest.fn(async () => undefined),
  interruptAllRunningStages: jest.fn(async () => 0),
  claimStageCheckpoint: jest.fn(async () => true),
  getStageCheckpoints: jest.fn(async () => []),
  ensurePendingCheckpoints: jest.fn(async () => undefined),
  getStageCheckpoint: jest.fn(async () => null),
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
    await new Promise(resolve => setTimeout(resolve, 0));
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

  test('serializes snapshots so an older status write cannot erase a completed audit result', async () => {
    const pending: Array<{ snapshot: any; resolve: () => void }> = [];
    mockSavePipelineTask.mockImplementation(
      (snapshot: any) =>
        new Promise<void>(resolve => {
          pending.push({ snapshot, resolve });
        }),
    );
    const now = Date.now();
    usePipelineTaskStore.setState({
      tasks: [{
        id: 'serialized-audit',
        targetType: 'chapter',
        targetId: 1,
        status: 'drafting',
        stageResults: [],
        finalText: null,
        error: null,
        createdAt: now,
        updatedAt: now,
        resolvedAt: null,
      } as any],
      _loaded: true,
    });

    const store = usePipelineTaskStore.getState();
    store.setTaskStatus('serialized-audit', 'reviewing');
    store.updateTaskStage('serialized-audit', {
      stage: 'review',
      status: 'success',
      text: '{"issues":["审核内容"]}',
      durationMs: 1,
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    // The newer write waits; it cannot race ahead and then be overwritten by
    // the earlier status snapshot with an empty stageResults list.
    expect(pending).toHaveLength(1);
    expect(pending[0].snapshot.stageResults).toEqual([]);

    pending[0].resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(pending).toHaveLength(2);
    expect(pending[1].snapshot.stageResults).toEqual([
      expect.objectContaining({
        stage: 'review',
        status: 'success',
        text: '{"issues":["审核内容"]}',
      }),
    ]);
    pending[1].resolve();
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

describe('pipeline task input fingerprint persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSavePipelineTask.mockResolvedValue(undefined);
    usePipelineTaskStore.setState({ tasks: [], _loaded: true });
  });

  // Flush the async per-task persistence chain so mock calls are recorded.
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));

  it('setTaskInputFingerprint updates the task and persists it', async () => {
    const store = usePipelineTaskStore.getState();
    const id = store.createTask('chapter', 5);
    await flush();
    mockSavePipelineTask.mockClear();

    store.setTaskInputFingerprint(id, 'fp-abc123');
    await flush();

    const task = usePipelineTaskStore.getState().tasks.find(t => t.id === id);
    expect(task?.inputFingerprint).toBe('fp-abc123');
    expect(mockSavePipelineTask).toHaveBeenCalledTimes(1);
    const persisted = mockSavePipelineTask.mock.calls[0][0];
    expect(persisted.inputFingerprint).toBe('fp-abc123');
  });

  it('loadFromDB restores inputFingerprint from the row', async () => {
    mockGetAllPipelineTasks.mockResolvedValue([
      { ...persistedRow, inputFingerprint: 'fp-from-db' },
    ]);
    usePipelineTaskStore.setState({ tasks: [], _loaded: false });
    await usePipelineTaskStore.getState().loadFromDB();
    const task = usePipelineTaskStore.getState().tasks[0];
    expect(task.inputFingerprint).toBe('fp-from-db');
  });

  it('persistTask snapshot includes inputFingerprint field', async () => {
    const store = usePipelineTaskStore.getState();
    const id = store.createTask('chapter', 6);
    store.setTaskInputFingerprint(id, 'fp-snapshot');
    await flush();
    // Use the LAST persistence call for this id — createTask persists first
    // (fingerprint null), setTaskInputFingerprint persists again with the value.
    const calls = mockSavePipelineTask.mock.calls.filter(
      (call: any[]) => call[0].id === id,
    );
    const persisted = calls[calls.length - 1]?.[0];
    expect(persisted).toBeDefined();
    expect(persisted.inputFingerprint).toBe('fp-snapshot');
  });

  it('tasks without fingerprint persist null (legacy compatibility)', async () => {
    const store = usePipelineTaskStore.getState();
    const id = store.createTask('chapter', 7);
    await flush();
    // No setTaskInputFingerprint called → inputFingerprint undefined → persisted as null.
    const persisted = mockSavePipelineTask.mock.calls.find(
      (call: any[]) => call[0].id === id,
    )?.[0];
    expect(persisted).toBeDefined();
    expect(persisted.inputFingerprint).toBeNull();
  });
});
