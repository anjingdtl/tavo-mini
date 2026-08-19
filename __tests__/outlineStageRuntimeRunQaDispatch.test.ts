/**
 * Phase 4 (二 §7.2) — Outline runtime dispatch must route `run_qa`.
 *
 * Regression guard for the gap found during Phase 4 hand-over: the pure
 * decision layer (`determineNextPipelineAction`) returned `run_qa` for the
 * compact topology, and `runOutlineSharedWriterAction` mapped it to the qa
 * kernel stage, but the durable runtime switch in `outlineStageRuntime.ts`
 * did not list `run_qa` — a compact task would hit the `default` branch and
 * fail with "未知流水线动作" at its first QA step.
 */
import { runOutlineDurableOperation } from '../src/services/pipeline/outlineStageRuntime';

jest.mock('../src/services/writing/execution/runOutlineSharedWriterAction', () => ({
  runSharedOutlineWriterAction: jest.fn().mockResolvedValue(undefined),
}));

// Loaded after the mock so the switch body calls the jest mock.
import { runSharedOutlineWriterAction } from '../src/services/writing/execution/runOutlineSharedWriterAction';

const mockedSharedAction = runSharedOutlineWriterAction as jest.MockedFunction<
  typeof runSharedOutlineWriterAction
>;

function options(overrides: Record<string, unknown> = {}) {
  return {
    foregroundOwner: 'task',
    ...overrides,
  } as never;
}

function chapter(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ch1',
    projectId: 'p1',
    title: '第一章',
    position: 0,
    content: '',
    ...overrides,
  } as never;
}

describe('Phase 4 — outline runtime dispatch handles run_qa', () => {
  beforeEach(() => {
    mockedSharedAction.mockClear();
    mockedSharedAction.mockResolvedValue(undefined as never);
  });

  test('run_qa dispatches the shared writer action and continues', async () => {
    const outcome = await runOutlineDurableOperation({
      taskId: 't1',
      chapter: chapter(),
      action: { type: 'run_qa' } as never,
      stages: [] as never,
      options: options(),
    });
    expect(outcome).toBe('continue');
    expect(mockedSharedAction).toHaveBeenCalledTimes(1);
    const call = mockedSharedAction.mock.calls[0];
    expect((call[0] as { action: { type: string } }).action.type).toBe(
      'run_qa',
    );
  });

  test('legacy trio + brief + proof still dispatch through the same path', async () => {
    const actionTypes = [
      'run_draft',
      'run_review',
      'run_fact_check',
      'run_review_and_fact_check',
      'run_brief',
      'run_proof',
    ] as const;
    for (const type of actionTypes) {
      const outcome = await runOutlineDurableOperation({
        taskId: `t-${type}`,
        chapter: chapter(),
        action: { type } as never,
        stages: [] as never,
        options: options(),
      });
      expect(outcome).toBe('continue');
      expect(mockedSharedAction).toHaveBeenCalledTimes(1);
      expect(
        (mockedSharedAction.mock.calls[0][0] as { action: { type: string } })
          .action.type,
      ).toBe(type);
      mockedSharedAction.mockClear();
    }
  });

  test('unknown action still fails closed with 未知流水线动作', async () => {
    const failSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const outcome = await runOutlineDurableOperation({
      taskId: 't-bad',
      chapter: chapter(),
      action: { type: 'run_bogus' } as never,
      stages: [] as never,
      options: options(),
    });
    expect(outcome).toBe('stop');
    expect(mockedSharedAction).not.toHaveBeenCalled();
    failSpy.mockRestore();
  });
});
