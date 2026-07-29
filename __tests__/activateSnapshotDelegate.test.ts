/**
 * Verifies the legacy `activateSnapshot` is now a thin delegate to the unified
 * `activateSnapshotAndStyleProfile` API (Spec §6.3) so every activation path —
 * including the manual UI caller — routes Canon + style pointer updates through
 * the same atomic transaction, clearing the active style pointer rather than
 * leaving a stale one.
 */
jest.mock('../src/services/continuation/canon/activateSnapshotAndStyleProfile', () => ({
  activateSnapshotAndStyleProfile: jest.fn(),
}));

jest.mock('../src/services/continuation/canon/canonRepository', () => ({
  getSnapshotById: jest.fn(),
}));

import { activateSnapshotAndStyleProfile } from '../src/services/continuation/canon/activateSnapshotAndStyleProfile';
import { getSnapshotById } from '../src/services/continuation/canon/canonRepository';
import { activateSnapshot } from '../src/services/continuation/canon/canonAnalysisService';

describe('activateSnapshot delegate (Spec §6.3 unified activation)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (activateSnapshotAndStyleProfile as jest.Mock).mockResolvedValue(undefined);
    // The delegate reads the snapshot back post-activation to preserve the
    // CanonSnapshot return contract.
    (getSnapshotById as jest.Mock).mockResolvedValue({
      id: 'snap-1',
      projectId: 1,
      status: 'ready',
    });
  });

  it('delegates to activateSnapshotAndStyleProfile with skip-style (null profile, allowStyleSkip)', async () => {
    await activateSnapshot(1, 'snap-1');

    expect(activateSnapshotAndStyleProfile).toHaveBeenCalledTimes(1);
    expect(activateSnapshotAndStyleProfile).toHaveBeenCalledWith({
      projectId: 1,
      canonSnapshotId: 'snap-1',
      // Legacy/manual callers have no style profile in scope, so they clear the
      // active style pointer atomically (allowStyleSkip=true) instead of
      // bypassing style and leaving a stale pointer.
      styleProfileId: null,
      allowStyleSkip: true,
    });
  });

  it('returns the activated CanonSnapshot to preserve the legacy return contract', async () => {
    const result = await activateSnapshot(1, 'snap-1');
    expect(result).toEqual(
      expect.objectContaining({ id: 'snap-1', status: 'ready' }),
    );
    // The snapshot is read back AFTER the unified activation commits.
    expect(getSnapshotById).toHaveBeenLastCalledWith('snap-1');
  });

  it('throws if the delegated activation did not produce a ready snapshot', async () => {
    (getSnapshotById as jest.Mock).mockResolvedValue({
      id: 'snap-1',
      status: 'awaiting_review',
    });
    await expect(activateSnapshot(1, 'snap-1')).rejects.toThrow('激活失败');
  });

  it('propagates failures from the unified activation (no swallowed errors, no half-state)', async () => {
    (activateSnapshotAndStyleProfile as jest.Mock).mockRejectedValue(
      new Error('存在 2 条未来证据，禁止激活'),
    );
    await expect(activateSnapshot(1, 'snap-1')).rejects.toThrow('未来证据');
  });
});
