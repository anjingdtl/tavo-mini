const mockOpenDatabase = jest.fn();
const mockExecute = jest.fn();
const mockGetRunById = jest.fn();
const mockUpdateRunState = jest.fn();
const mockListBatches = jest.fn();

jest.mock('../src/data/connection/openDatabase', () => ({
  openDatabase: (...args: any[]) => mockOpenDatabase(...args),
}));

jest.mock('../src/data/connection/execute', () => ({
  execute: (...args: any[]) => mockExecute(...args),
}));

jest.mock('../src/services/continuation/canon/canonRepository', () => ({
  getRunById: (...args: any[]) => mockGetRunById(...args),
  updateRunState: (...args: any[]) => mockUpdateRunState(...args),
  // resumeAnalysis → resetInterruptedAnalysisWork → healOrphanPartialBatches
  // re-reads all batches to unstick orphan partial parents.
  listBatches: (...args: any[]) => mockListBatches(...args),
}));

import {
  isResumableAnalysisState,
  resumeAnalysis,
} from '../src/services/continuation/canon/canonAnalysisService';

describe('Canon analysis resume after interruption', () => {
  const cancelledRun = {
    id: 'ca_cancelled',
    state: 'cancelled',
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockOpenDatabase.mockResolvedValue({});
    // resumeAnalysis reads once and the runner reads again. Returning the
    // persisted terminal run on the latter makes this a DB-boundary test
    // without invoking source/LLM work.
    mockGetRunById.mockResolvedValue(cancelledRun);
    mockExecute.mockResolvedValue(undefined);
    mockUpdateRunState.mockResolvedValue(undefined);
    // healOrphanPartialBatches re-reads batches; return empty so no partial
    // parents need healing (keeps this a DB-boundary test).
    mockListBatches.mockResolvedValue([]);
  });

  it('treats paused, failed and explicitly cancelled tasks as resumable', () => {
    expect(isResumableAnalysisState('paused')).toBe(true);
    expect(isResumableAnalysisState('failed')).toBe(true);
    expect(isResumableAnalysisState('cancelled')).toBe(true);
    expect(isResumableAnalysisState('completed')).toBe(false);
    expect(isResumableAnalysisState('outdated')).toBe(false);
  });

  it('requeues only unfinished cancelled work before resuming', async () => {
    await resumeAnalysis(cancelledRun.id);

    expect(mockExecute).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('continuation_analysis_work_items'),
      expect.any(Array),
    );
    expect(mockExecute).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('continuation_analysis_batches'),
      expect.any(Array),
    );
    expect(mockUpdateRunState).toHaveBeenCalledWith(
      expect.anything(),
      cancelledRun.id,
      expect.objectContaining({
        state: 'queued',
        completedAt: null,
        errorCode: null,
      }),
    );
  });

  it('does not requeue a retired legacy Quick task', async () => {
    mockGetRunById.mockResolvedValueOnce({
      ...cancelledRun,
      profile: 'quick',
    });

    await expect(resumeAnalysis(cancelledRun.id)).rejects.toThrow('Quick');
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockUpdateRunState).not.toHaveBeenCalled();
  });
});
