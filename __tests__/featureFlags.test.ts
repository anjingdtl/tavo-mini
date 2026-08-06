/**
 * Guarded feature flags must default OFF and never leak into the default
 * code path. Phase 0 baseline contract.
 */
const mockGetSetting = jest.fn();
const mockSetSetting = jest.fn();

jest.mock('../src/data/repositories/settingsRepository', () => ({
  getSetting: (...args: any[]) => mockGetSetting(...args),
  setSetting: (...args: any[]) => mockSetSetting(...args),
}));

import {
  FEATURE_FLAG_KEYS,
  isElasticBudgetV2Enabled,
  isMultiChapterBatchEnabled,
  setElasticBudgetV2Enabled,
  setMultiChapterBatchEnabled,
} from '../src/services/featureFlags';

describe('feature flags (Phase 0 baseline)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSetting.mockResolvedValue(null);
  });

  it('defaults to false when settings row is absent', async () => {
    await expect(isElasticBudgetV2Enabled()).resolves.toBe(false);
    await expect(isMultiChapterBatchEnabled()).resolves.toBe(false);
    expect(mockGetSetting).toHaveBeenCalledWith(FEATURE_FLAG_KEYS.elasticBudgetV2);
    expect(mockGetSetting).toHaveBeenCalledWith(FEATURE_FLAG_KEYS.multiChapterBatch);
  });

  it('only accepts the literal "true" as enabled', async () => {
    mockGetSetting.mockResolvedValue('true');
    await expect(isElasticBudgetV2Enabled()).resolves.toBe(true);
    await expect(isMultiChapterBatchEnabled()).resolves.toBe(true);

    mockGetSetting.mockResolvedValue('false');
    await expect(isElasticBudgetV2Enabled()).resolves.toBe(false);

    mockGetSetting.mockResolvedValue('1');
    await expect(isMultiChapterBatchEnabled()).resolves.toBe(false);
  });

  it('persists enable/disable via settings', async () => {
    await setElasticBudgetV2Enabled(true);
    expect(mockSetSetting).toHaveBeenCalledWith(
      FEATURE_FLAG_KEYS.elasticBudgetV2,
      'true',
    );
    await setMultiChapterBatchEnabled(false);
    expect(mockSetSetting).toHaveBeenCalledWith(
      FEATURE_FLAG_KEYS.multiChapterBatch,
      'false',
    );
  });
});
