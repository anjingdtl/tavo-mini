import {
  storyMemoryPercent,
  storyMemoryTaskId,
  useStoryMemoryTaskStore,
} from '../src/store/storyMemoryTaskStore';

describe('Story Memory runtime task progress', () => {
  beforeEach(() => {
    useStoryMemoryTaskStore.getState().resetForTest();
  });

  it('keeps chapter progress monotonic and computes dynamic percentages', () => {
    expect(storyMemoryTaskId(7)).toBe('story-memory:7');
    expect(storyMemoryPercent(0, 10)).toBe(0);

    const startedAt = 123;
    useStoryMemoryTaskStore.getState().startTask({
      taskId: 'story-memory:7',
      projectId: 7,
      kind: 'checkpoint',
      phase: 'preparing',
      totalChapters: 10,
      completedChapters: 0,
      totalBatches: 4,
      completedBatches: 0,
      currentFromPosition: null,
      currentThroughPosition: null,
      currentAttempt: null,
      maxAttempts: 3,
      percent: 0,
      startedAt,
      updatedAt: startedAt,
      message: '正在准备',
    });

    const store = useStoryMemoryTaskStore.getState();
    store.updateTask('story-memory:7', {
      phase: 'requesting',
      completedChapters: 3,
      completedBatches: 1,
      currentFromPosition: 3,
      currentThroughPosition: 5,
      currentAttempt: 1,
      message: '正在分析第 4～6 章',
    });
    expect(useStoryMemoryTaskStore.getState().tasks['story-memory:7']).toEqual(
      expect.objectContaining({
        phase: 'requesting',
        percent: 30,
        completedChapters: 3,
      }),
    );

    store.updateTask('story-memory:7', { completedChapters: 6 });
    expect(useStoryMemoryTaskStore.getState().tasks['story-memory:7'].percent).toBe(60);
    store.updateTask('story-memory:7', { completedChapters: 9 });
    expect(useStoryMemoryTaskStore.getState().tasks['story-memory:7'].percent).toBe(90);
    store.updateTask('story-memory:7', { completedChapters: 10 });
    expect(useStoryMemoryTaskStore.getState().tasks['story-memory:7'].percent).toBe(100);

    store.finishTask('story-memory:7', 'completed', '整理完成');
    expect(useStoryMemoryTaskStore.getState().tasks['story-memory:7']).toEqual(
      expect.objectContaining({
        phase: 'completed',
        completedChapters: 10,
        completedBatches: 4,
        percent: 100,
        message: '整理完成',
      }),
    );
  });
});
