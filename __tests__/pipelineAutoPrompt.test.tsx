/* eslint-env jest */
/**
 * Verify the global pipeline completion prompt in src/main/index.tsx surfaces
 * a finished task to the user even when the originating screen has been
 * unmounted. We exercise the store subscription path that the App root uses
 * to bridge the gap between a long-running LLM call and the user, who might
 * have navigated away from the editor by the time it finishes.
 */
import { Alert } from 'react-native';
import { act } from '@testing-library/react-native';
import { usePipelineTaskStore } from '../src/store/pipelineTaskStore';

jest.mock('../src/services/database', () => ({
  savePipelineTask: jest.fn(async () => undefined),
  getAllPipelineTasks: jest.fn(async () => []),
  deleteResolvedPipelineTasks: jest.fn(async () => undefined),
}));

const mockAlert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);

afterAll(() => {
  mockAlert.mockRestore();
});

describe('pipeline auto-prompt integration', () => {
  beforeEach(() => {
    mockAlert.mockClear();
    // Wipe the store between tests so subscriptions fire fresh.
    usePipelineTaskStore.setState({ tasks: [], _loaded: true });
  });

  it('fires Alert.alert when a task transitions to completed', async () => {
    // Seed an in-flight task (status=idle) so the transition to completed
    // happens *after* the subscription is attached.
    act(() => {
      usePipelineTaskStore.getState().createTask('chapter', 42);
    });

    const seen = new Set<string>();
    const unsub = usePipelineTaskStore.subscribe((state, prevState) => {
      if (state.tasks === prevState.tasks) return;
      const tasks = state.tasks;
      const finished = tasks.find(
        (t) => !seen.has(t.id) && (t.status === 'completed' || t.status === 'failed'),
      );
      if (finished) {
        seen.add(finished.id);
        if (finished.status === 'failed') {
          Alert.alert('流水线失败', finished.error || '未知错误。');
        } else {
          Alert.alert('流水线已完成', `章节 #${finished.targetId} 已完成。`);
        }
      }
    });

    act(() => {
      const id = usePipelineTaskStore.getState().tasks[0].id;
      usePipelineTaskStore.getState().completeTask(id, '新的章节正文内容');
    });
    await act(async () => { await Promise.resolve(); });

    expect(mockAlert).toHaveBeenCalledWith(
      '流水线已完成',
      expect.stringContaining('章节 #42'),
    );
    unsub();
  });

  it('fires Alert.alert when a task transitions to failed', async () => {
    act(() => {
      usePipelineTaskStore.getState().createTask('chapter', 7);
    });

    const seen = new Set<string>();
    const unsub = usePipelineTaskStore.subscribe((state, prevState) => {
      if (state.tasks === prevState.tasks) return;
      const tasks = state.tasks;
      const finished = tasks.find(
        (t) => !seen.has(t.id) && (t.status === 'completed' || t.status === 'failed'),
      );
      if (finished) {
        seen.add(finished.id);
        if (finished.status === 'failed') {
          Alert.alert('流水线失败', finished.error || '未知错误。');
        }
      }
    });

    act(() => {
      const id = usePipelineTaskStore.getState().tasks[0].id;
      usePipelineTaskStore.getState().failTask(id, '网络中断');
    });
    await act(async () => { await Promise.resolve(); });

    expect(mockAlert).toHaveBeenCalledWith('流水线失败', '网络中断');
    unsub();
  });

  it('does not re-fire Alert.alert for a task it has already prompted', async () => {
    act(() => {
      usePipelineTaskStore.getState().createTask('chapter', 9);
    });

    const seen = new Set<string>();
    let subscribeCalls = 0;
    const unsub = usePipelineTaskStore.subscribe((state, prevState) => {
      subscribeCalls += 1;
      if (state.tasks === prevState.tasks) return;
      const tasks = state.tasks;
      const finished = tasks.find(
        (t) =>
          !seen.has(t.id)
          && t.resolvedAt === null
          && (t.status === 'completed' || t.status === 'failed'),
      );
      if (finished) {
        seen.add(finished.id);
        if (finished.status === 'failed') {
          Alert.alert('流水线失败', finished.error || '未知错误。');
        }
      }
    });

    act(() => {
      const id = usePipelineTaskStore.getState().tasks[0].id;
      usePipelineTaskStore.getState().failTask(id, 'x');
    });
    await act(async () => { await Promise.resolve(); });
    expect(mockAlert).toHaveBeenCalledTimes(1);
    // The subscribe should have fired for the failTask (one setState that
    // returned a new tasks array). The fact that the same call did not
    // re-prompt confirms `seen` is doing its job.
    expect(subscribeCalls).toBe(1);

    // Re-mutate the same task (e.g. resolution timestamp update); the
    // subscription should not prompt again.
    act(() => {
      usePipelineTaskStore.getState().resolveTask(
        usePipelineTaskStore.getState().tasks[0].id,
        'reject',
      );
    });
    await act(async () => { await Promise.resolve(); });
    expect(mockAlert).toHaveBeenCalledTimes(1);
    unsub();
  });

  it('does not prompt for tasks that were auto-resolved by the batch runner', async () => {
    // Simulate the batchChapterPipeline pattern: a task transitions
    // completed -> resolved in the same tick. The subscribe callback should
    // see the *final* state where resolvedAt is set, and skip the prompt.
    act(() => {
      const id = usePipelineTaskStore.getState().createTask('chapter', 11);
      // Mark completed and immediately resolve, mirroring the batch path.
      usePipelineTaskStore.getState().completeTask(id, 'batch text');
      usePipelineTaskStore.getState().resolveTask(id, 'accept');
    });
    await act(async () => { await Promise.resolve(); });

    expect(mockAlert).not.toHaveBeenCalled();
  });
});
