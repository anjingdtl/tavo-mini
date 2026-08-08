/**
 * Default capabilities: the three experimental switches (elastic budget V2 /
 * multi-chapter batch / outline workflow V2) are DELETED — those are now
 * default product capabilities frozen per task/batch row (Schema 44).
 * Runtime code must never read live settings flags for them; the only
 * remaining flag is the destructive data-maintenance switch
 * (startupNoteRepair), which stays OFF by default.
 */
const mockGetSetting = jest.fn();
const mockSetSetting = jest.fn();

jest.mock('../src/data/repositories/settingsRepository', () => ({
  getSetting: (...args: any[]) => mockGetSetting(...args),
  setSetting: (...args: any[]) => mockSetSetting(...args),
}));

import {
  FEATURE_FLAG_KEYS,
  isStartupNoteRepairEnabled,
  setStartupNoteRepairEnabled,
} from '../src/services/featureFlags';
import * as featureFlags from '../src/services/featureFlags';

describe('feature flags (default capabilities)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSetting.mockResolvedValue(null);
  });

  it('the three default-capability switches no longer exist as exports', () => {
    const mod = featureFlags as Record<string, unknown>;
    expect(mod.isElasticBudgetV2Enabled).toBeUndefined();
    expect(mod.setElasticBudgetV2Enabled).toBeUndefined();
    expect(mod.isMultiChapterBatchEnabled).toBeUndefined();
    expect(mod.setMultiChapterBatchEnabled).toBeUndefined();
    expect(mod.isOutlineWorkflowV2Enabled).toBeUndefined();
    expect(mod.setOutlineWorkflowV2Enabled).toBeUndefined();
    // Keys are gone from the settings-key surface too.
    expect(FEATURE_FLAG_KEYS).not.toHaveProperty('elasticBudgetV2');
    expect(FEATURE_FLAG_KEYS).not.toHaveProperty('multiChapterBatch');
    expect(FEATURE_FLAG_KEYS).not.toHaveProperty('outlineWorkflowV2');
  });

  it('only the maintenance switch (startupNoteRepair) remains', () => {
    expect(FEATURE_FLAG_KEYS).toHaveProperty('startupNoteRepair');
    expect(Object.keys(FEATURE_FLAG_KEYS)).toEqual(['startupNoteRepair']);
  });

  it('maintenance switch defaults OFF when settings row is absent', async () => {
    await expect(isStartupNoteRepairEnabled()).resolves.toBe(false);
    expect(mockGetSetting).toHaveBeenCalledWith(
      FEATURE_FLAG_KEYS.startupNoteRepair,
    );
  });

  it('maintenance switch only accepts the literal "true"', async () => {
    mockGetSetting.mockResolvedValue('true');
    await expect(isStartupNoteRepairEnabled()).resolves.toBe(true);

    mockGetSetting.mockResolvedValue('false');
    await expect(isStartupNoteRepairEnabled()).resolves.toBe(false);

    mockGetSetting.mockResolvedValue('1');
    await expect(isStartupNoteRepairEnabled()).resolves.toBe(false);
  });

  it('persists the maintenance switch via settings', async () => {
    await setStartupNoteRepairEnabled(true);
    expect(mockSetSetting).toHaveBeenCalledWith(
      FEATURE_FLAG_KEYS.startupNoteRepair,
      'true',
    );
    await setStartupNoteRepairEnabled(false);
    expect(mockSetSetting).toHaveBeenCalledWith(
      FEATURE_FLAG_KEYS.startupNoteRepair,
      'false',
    );
  });
});
