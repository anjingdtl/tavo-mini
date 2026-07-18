import {
  llmRequestScheduler,
  scheduleLLMRequest,
} from '../src/services/llm/requestScheduler';
import {
  createLLMTimeoutController,
  LLM_TIMEOUTS,
  resolveLLMTimeoutPolicy,
  toLLMRequestError,
} from '../src/services/llm/requestPolicy';
import {
  isPrivateLanHost,
  validateLLMEndpoint,
} from '../src/services/llm/networkPolicy';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(nextResolve => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe('LLM request reliability policy', () => {
  afterEach(() => {
    llmRequestScheduler.setLowMemory(false);
  });

  test('does not start a cancelled queued request', async () => {
    const blockers = [deferred(), deferred(), deferred()];
    const started: string[] = [];
    const blockerPromises = blockers.map((item, index) =>
      scheduleLLMRequest(
        async () => {
          started.push(`blocker-${index}`);
          await item.promise;
        },
        { taskId: `blocker-${index}`, queueClass: 'normal' },
      ),
    );
    await Promise.resolve();

    const controller = new AbortController();
    const states: string[] = [];
    const queued = scheduleLLMRequest(
      async () => {
        started.push('cancelled');
        return 'unexpected';
      },
      {
        taskId: 'queued-cancelled',
        queueClass: 'normal',
        externalSignal: controller.signal,
        onQueueState: state => states.push(state),
      },
    );
    controller.abort();

    await expect(queued).rejects.toMatchObject({ code: 'cancelled' });
    expect(started).not.toContain('cancelled');
    expect(states).toEqual(['queued', 'cancelled']);

    blockers.forEach(item => item.resolve());
    await Promise.all(blockerPromises);
  });

  test('serializes same-project pipeline calls while allowing independent queues', async () => {
    let active = 0;
    let peak = 0;
    const run = (taskId: string) =>
      scheduleLLMRequest(
        async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise(resolve => setTimeout(resolve, 5));
          active -= 1;
          return taskId;
        },
        {
          taskId,
          queueClass: 'pipeline',
          projectId: 77,
        },
      );

    await expect(
      Promise.all([run('pipeline-a'), run('pipeline-b')]),
    ).resolves.toEqual(['pipeline-a', 'pipeline-b']);
    expect(peak).toBe(1);
  });

  test('pauses new work during low-memory pressure and resumes it afterwards', async () => {
    llmRequestScheduler.setLowMemory(true);
    let started = false;
    const work = scheduleLLMRequest(
      async () => {
        started = true;
        return 'ready';
      },
      { taskId: 'low-memory-task', queueClass: 'local' },
    );

    await Promise.resolve();
    expect(started).toBe(false);
    expect(llmRequestScheduler.getSnapshot().queued).toBeGreaterThanOrEqual(1);

    llmRequestScheduler.setLowMemory(false);
    await expect(work).resolves.toBe('ready');
    expect(started).toBe(true);
  });

  test('uses the documented timeout tiers', () => {
    expect(
      resolveLLMTimeoutPolicy('connection_test', 'openai_compatible'),
    ).toEqual({
      totalTimeoutMs: LLM_TIMEOUTS.connectionMs,
    });
    expect(
      resolveLLMTimeoutPolicy('pipeline_draft', 'openai_compatible'),
    ).toEqual({
      totalTimeoutMs: LLM_TIMEOUTS.chapterDraftMs,
    });
    expect(resolveLLMTimeoutPolicy('chat', 'llama_cpp')).toEqual({
      idleTimeoutMs: LLM_TIMEOUTS.localIdleMs,
    });
    expect(
      resolveLLMTimeoutPolicy('story_memory_patch', 'openai_compatible'),
    ).toEqual({ totalTimeoutMs: LLM_TIMEOUTS.chapterDraftMs });
    expect(
      resolveLLMTimeoutPolicy('story_memory_patch_repair', 'openai_compatible'),
    ).toEqual({ totalTimeoutMs: LLM_TIMEOUTS.chapterDraftMs });
  });

  test('records timing metrics and gives user cancellation priority', () => {
    const externalController = new AbortController();
    const progress = jest.fn();
    const timeoutController = createLLMTimeoutController({
      policy: { idleTimeoutMs: 1_000 },
      taskId: 'metrics-task',
      externalSignal: externalController.signal,
      onProgress: progress,
    });

    expect(timeoutController.metrics.taskId).toBe('metrics-task');
    expect(timeoutController.metrics.startedAt).toBeGreaterThan(0);
    timeoutController.markProgress('first_token');

    expect(timeoutController.metrics.firstTokenAt).toBeDefined();
    expect(timeoutController.metrics.lastProgressAt).toBe(
      timeoutController.metrics.firstTokenAt,
    );
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'metrics-task' }),
    );

    externalController.abort();
    expect(timeoutController.getAbortCode()).toBe('cancelled');
    expect(
      toLLMRequestError(new Error('aborted'), timeoutController, 'fallback'),
    ).toMatchObject({ code: 'cancelled' });
    timeoutController.dispose();
  });

  test('allows only explicitly enabled private IPv4 HTTP endpoints', () => {
    expect(isPrivateLanHost('127.0.0.1')).toBe(true);
    expect(isPrivateLanHost('10.20.30.40')).toBe(true);
    expect(isPrivateLanHost('172.16.0.8')).toBe(true);
    expect(isPrivateLanHost('192.168.1.8')).toBe(true);
    expect(isPrivateLanHost('172.32.0.8')).toBe(false);
    expect(isPrivateLanHost('8.8.8.8')).toBe(false);

    expect(() =>
      validateLLMEndpoint('http://192.168.1.8:8000/v1', false),
    ).toThrow(/阻止/);
    expect(() => validateLLMEndpoint('http://8.8.8.8:8000/v1', true)).toThrow(
      /阻止/,
    );
    expect(() =>
      validateLLMEndpoint('https://api.example.com/v1', false),
    ).not.toThrow();
    expect(() =>
      validateLLMEndpoint('http://192.168.1.8:8000/v1', true),
    ).not.toThrow();
  });
});
