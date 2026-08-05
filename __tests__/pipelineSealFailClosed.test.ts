/**
 * Seal 2: checkpoint / CAS fail-closed + executeClaimedStage lifecycle.
 */
import { executeClaimedStage } from '../src/services/pipeline/executeClaimedStage';

const mockClaim = jest.fn();
const mockGetCheckpoint = jest.fn();
const mockUpsert = jest.fn();

jest.mock('../src/services/database', () => ({
  claimStageCheckpoint: (...args: any[]) => mockClaim(...args),
  getStageCheckpoint: (...args: any[]) => mockGetCheckpoint(...args),
  upsertStageCheckpoint: (...args: any[]) => mockUpsert(...args),
}));

describe('executeClaimedStage fail-closed', () => {
  beforeEach(() => {
    mockClaim.mockReset();
    mockGetCheckpoint.mockReset();
    mockUpsert.mockReset();
    mockUpsert.mockResolvedValue(undefined);
  });

  test('claim throw → no run, LLM path not entered', async () => {
    mockClaim.mockRejectedValue(new Error('sqlite locked'));
    const run = jest.fn(async () => 'ok');
    await expect(
      executeClaimedStage({
        taskId: 't1',
        stage: 'draft',
        run,
      }),
    ).rejects.toThrow(/sqlite locked/);
    expect(run).not.toHaveBeenCalled();
  });

  test('claim returns false → no run', async () => {
    mockClaim.mockResolvedValue(false);
    const run = jest.fn(async () => 'ok');
    const result = await executeClaimedStage({
      taskId: 't1',
      stage: 'draft',
      run,
    });
    expect(result).toEqual({
      claimed: false,
      reason: 'TASK_ALREADY_RUNNING',
    });
    expect(run).not.toHaveBeenCalled();
  });

  test('run throw after claim → checkpoint not left running', async () => {
    mockClaim.mockResolvedValue(true);
    mockGetCheckpoint.mockResolvedValue({
      status: 'running',
      outputText: null,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      durationMs: null,
      startedAt: 1,
    });
    const run = jest.fn(async () => {
      throw new Error('loadRuntime boom');
    });
    await expect(
      executeClaimedStage({
        taskId: 't1',
        stage: 'review',
        run,
      }),
    ).rejects.toThrow(/loadRuntime boom/);
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 't1',
        stage: 'review',
        status: 'failed',
      }),
    );
  });

  test('user cancel after claim → interrupted, not permanent running', async () => {
    mockClaim.mockResolvedValue(true);
    mockGetCheckpoint.mockResolvedValue({
      status: 'running',
      outputText: null,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      durationMs: null,
      startedAt: 1,
    });
    const run = jest.fn(async () => {
      const err = new Error('cancelled') as Error & { code?: string };
      err.code = 'cancelled';
      throw err;
    });
    await expect(
      executeClaimedStage({
        taskId: 't1',
        stage: 'proof',
        run,
        isCancelled: () => true,
      }),
    ).rejects.toThrow();
    // Cancel path marks interrupted either before run or in catch.
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'interrupted',
      }),
    );
  });

  test('successful run that persisted succeeded does not force-fail', async () => {
    mockClaim.mockResolvedValue(true);
    // After run, checkpoint already succeeded.
    mockGetCheckpoint.mockResolvedValue({
      status: 'succeeded',
      outputText: 'ok',
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      durationMs: 10,
      startedAt: 1,
    });
    const run = jest.fn(async () => 'done');
    const result = await executeClaimedStage({
      taskId: 't1',
      stage: 'draft',
      run,
    });
    expect(result).toEqual({ claimed: true, result: 'done' });
    // releaseRunningCheckpoint only upserts when still running.
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
