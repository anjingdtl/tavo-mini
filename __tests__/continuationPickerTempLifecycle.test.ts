/**
 * Regression: multi-file ordering must keep picker cache copies until
 * startContinuationImport has made durable jobDir copies.
 *
 * Reproduces the emulator IMP-003 failure where ContinuationSourceChaptersScreen
 * finally-unlinked cachesDirectory copies before the ordering screen confirmed.
 */
import {
  decidePickerTempCleanup,
  unlinkPickerTempCopies,
} from '../src/services/continuation/continuationPickerTempLifecycle';

jest.mock('react-native-fs', () => ({
  unlink: jest.fn(() => Promise.resolve()),
}));

import RNFS from 'react-native-fs';

describe('continuationPickerTempLifecycle', () => {
  beforeEach(() => {
    (RNFS.unlink as jest.Mock).mockClear();
  });

  it('retains picker copies when multi-file flow hands off to ordering', () => {
    const paths = [
      '/data/user/0/com.shinewriter/cache/part_01.txt',
      '/data/user/0/com.shinewriter/cache/part_02.txt',
      '/data/user/0/com.shinewriter/cache/part_03.txt',
    ];
    const decision = decidePickerTempCleanup({
      handedOffToOrdering: true,
      localPaths: paths,
    });
    expect(decision).toEqual({ action: 'retain_for_ordering', paths });
  });

  it('unlinks immediately for single-file flow after import start ownership transfer', () => {
    const paths = ['/cache/single.txt'];
    const decision = decidePickerTempCleanup({
      handedOffToOrdering: false,
      localPaths: paths,
    });
    expect(decision).toEqual({ action: 'unlink_now', paths });
  });

  it('filters empty paths', () => {
    const decision = decidePickerTempCleanup({
      handedOffToOrdering: false,
      localPaths: ['/a', '', '/b'],
    });
    expect(decision.paths).toEqual(['/a', '/b']);
  });

  it('unlinkPickerTempCopies best-effort calls RNFS.unlink for each path', async () => {
    (RNFS.unlink as jest.Mock)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('ENOENT'));
    await expect(
      unlinkPickerTempCopies(['/a', '/missing']),
    ).resolves.toBeUndefined();
    expect(RNFS.unlink).toHaveBeenCalledTimes(2);
  });
});
