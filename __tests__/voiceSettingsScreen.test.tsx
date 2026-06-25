import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';

const mockLoadVoiceConfig = jest.fn();
const mockSaveVoiceConfig = jest.fn(async () => undefined);
const mockSetVoiceApiKey = jest.fn(async () => undefined);
const mockPlayChapter = jest.fn(async () => undefined);
const mockSaveSystemTtsConfig = jest.fn(async () => undefined);
const mockSetEngine = jest.fn(async () => undefined);
const mockConfiguredVoiceState = {
  engine: 'cloud' as const,
  config: {
    apiUrl: 'https://voice.example.test/v1/audio',
    model: 'custom-voice-model',
    voiceId: 'male-qn-qingse',
    speed: 1,
    vol: 1,
    pitch: 0,
    sampleRate: 32000,
    bitrate: 128000,
    format: 'mp3',
  },
  apiKey: 'voice-key',
  systemConfig: {
    enginePackage: '',
    voiceKey: '',
    language: 'zh-CN',
    speed: 1,
    pitch: 1,
    volume: 1,
  },
  loadVoiceConfig: mockLoadVoiceConfig,
  saveVoiceConfig: mockSaveVoiceConfig,
  setVoiceApiKey: mockSetVoiceApiKey,
  saveSystemTtsConfig: mockSaveSystemTtsConfig,
  setEngine: mockSetEngine,
  playChapter: mockPlayChapter,
};
let mockVoiceState = mockConfiguredVoiceState;

jest.mock('../src/store/voiceStore', () => ({
  useVoiceStore: () => mockVoiceState,
}));

import { VoiceSettingsScreen } from '../src/screens/VoiceSettingsScreen';

describe('VoiceSettingsScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVoiceState = mockConfiguredVoiceState;
  });

  it('uses configurable voice API fields and opens voice choices from a dropdown', () => {
    const { getByText, getByDisplayValue, queryByText } = render(<VoiceSettingsScreen />);

    expect(getByText('语音 API Key')).toBeTruthy();
    expect(getByText('语音 API URL')).toBeTruthy();
    expect(getByDisplayValue('https://voice.example.test/v1/audio')).toBeTruthy();
    expect(getByDisplayValue('custom-voice-model')).toBeTruthy();
    expect(queryByText('精英青年')).toBeNull();

    fireEvent.press(getByText('青涩青年'));

    expect(getByText('精英青年')).toBeTruthy();
  });

  it('keeps the API URL empty by default and shows the MiniMax URL only as an example', () => {
    mockVoiceState = {
      ...mockConfiguredVoiceState,
      config: {
        ...mockConfiguredVoiceState.config,
        apiUrl: '',
      },
      apiKey: '',
    };

    const { getByPlaceholderText, queryByDisplayValue } = render(<VoiceSettingsScreen />);

    expect(getByPlaceholderText('https://api.minimaxi.com/v1/t2a_v2')).toBeTruthy();
    expect(queryByDisplayValue('https://api.minimaxi.com/v1/t2a_v2')).toBeNull();
  });
});
