const mockGetBackgroundPipelineEnabled = jest.fn();
const mockGetLLMConfigs = jest.fn();
const mockGetContextConfig = jest.fn();

jest.mock('../src/services/database', () => ({
  getBackgroundPipelineEnabled: (...args: any[]) => mockGetBackgroundPipelineEnabled(...args),
  getLLMConfigs: (...args: any[]) => mockGetLLMConfigs(...args),
  getContextConfig: (...args: any[]) => mockGetContextConfig(...args),
  setActiveLLMConfig: jest.fn(),
}));

import { useSettingsStore } from '../src/store/settingsStore';
import { PipelineForeground } from '../src/native/PipelineForegroundModule';

describe('settingsStore background pipeline initialization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(PipelineForeground, 'setEnabled');
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    useSettingsStore.setState({ backgroundPipelineEnabled: true });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('enables the native foreground bridge even when unrelated settings fail to load', async () => {
    mockGetBackgroundPipelineEnabled.mockResolvedValue(false);
    mockGetLLMConfigs.mockRejectedValue(new Error('LLM settings unavailable'));
    mockGetContextConfig.mockResolvedValue({});

    await useSettingsStore.getState().loadSettings();

    expect(PipelineForeground.setEnabled).toHaveBeenCalledWith(true);
    expect(useSettingsStore.getState().backgroundPipelineEnabled).toBe(true);
  });
});
