import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('../src/services/database', () => ({
  getVoiceConfig: jest.fn(() =>
    Promise.resolve({
      apiUrl: '',
      model: 'm',
      voiceId: 'v',
      speed: 1,
      vol: 1,
      pitch: 0,
      sampleRate: 32000,
      bitrate: 128000,
      format: 'mp3',
    }),
  ),
  setVoiceConfig: jest.fn(() => Promise.resolve()),
  getTtsEngine: jest.fn(() => Promise.resolve('system')),
  setTtsEngine: jest.fn(() => Promise.resolve()),
  getSystemTtsConfig: jest.fn(() =>
    Promise.resolve({
      enginePackage: '',
      voiceKey: '',
      language: 'zh-CN',
      speed: 1,
      pitch: 1,
      volume: 1,
    }),
  ),
  setSystemTtsConfig: jest.fn(() => Promise.resolve()),
}));

jest.mock('../src/services/secureStorage', () => ({
  getSecureVoiceApiKey: jest.fn(() => Promise.resolve('')),
  setSecureVoiceApiKey: jest.fn(() => Promise.resolve()),
}));

jest.mock('react-native-fs', () => ({
  exists: jest.fn(() => Promise.resolve(false)),
  unlink: jest.fn(() => Promise.resolve()),
}));

const DEFAULT_SYSTEM = { enginePackage: '', voiceKey: '', language: 'zh-CN', speed: 1, pitch: 1, volume: 1 };
const DEFAULT_CLOUD = {
  apiUrl: '',
  model: 'm',
  voiceId: 'v',
  speed: 1,
  vol: 1,
  pitch: 0,
  sampleRate: 32000 as const,
  bitrate: 128000 as const,
  format: 'mp3' as const,
};

const mockLoadVoiceConfig = jest.fn();
const mockSaveVoiceConfig = jest.fn(async () => undefined);
const mockSaveSystemTtsConfig = jest.fn(async () => undefined);
const mockSetEngine = jest.fn(async () => undefined);
const mockSetVoiceApiKey = jest.fn(async () => undefined);
const mockPlayChapter = jest.fn(async () => undefined);

const mockVoiceState = {
  engine: 'system' as const,
  config: { ...DEFAULT_CLOUD },
  apiKey: '',
  systemConfig: { ...DEFAULT_SYSTEM },
  loadVoiceConfig: mockLoadVoiceConfig,
  saveVoiceConfig: mockSaveVoiceConfig,
  saveSystemTtsConfig: mockSaveSystemTtsConfig,
  setEngine: mockSetEngine,
  setVoiceApiKey: mockSetVoiceApiKey,
  playChapter: mockPlayChapter,
};

jest.mock('../src/store/voiceStore', () => ({
  useVoiceStore: () => mockVoiceState,
}));

const lightColors = {
  background: '#F6F8FA',
  surface: '#FFFFFF',
  card: '#FFFFFF',
  textPrimary: '#172026',
  textSecondary: '#52616B',
  textMuted: '#84919A',
  accent: '#2563EB',
  accentSoft: '#DBEAFE',
  danger: '#DC2626',
  success: '#059669',
  warning: '#D97706',
  border: '#D8E0E7',
};

jest.mock('../src/store/themeStore', () => ({
  useThemeStore: () => ({
    theme: {
      mode: 'light',
      colors: lightColors,
    },
  }),
}));

import { TtsAudio } from '../src/native/TtsAudioModule';
import { VoiceSettingsScreen } from '../src/screens/VoiceSettingsScreen';

const availableDiagnostics = {
  initialized: true,
  manufacturer: 'Google',
  model: 'sdk_gphone64_arm64',
  androidVersion: '14',
  sdkInt: 34,
  requestedEngine: '',
  currentEngine: 'com.google.android.tts',
  defaultEngine: 'com.google.android.tts',
  installedEngineCount: 1,
  selectedEngineInstalled: true,
  language: 'zh-CN',
  languageStatus: 'available',
  voiceCount: 2,
  matchingVoiceCount: 1,
  offlineVoiceCount: 1,
  maxInputLength: 4000,
};

const engineList = [
  { name: 'com.google.android.tts', label: 'Google TTS', isDefault: true, isCurrent: true },
];

const voiceList = [
  { key: 'zh-cn-x', name: '中文女声', locale: 'zh-CN', quality: 300, latency: 200, requiresNetwork: false, features: [] },
  { key: 'zh-cn-net', name: '中文高清声', locale: 'zh-CN', quality: 400, latency: 200, requiresNetwork: true, features: [] },
];

describe('VoiceSettingsScreen system TTS detection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('runs diagnostics then engines then voices in order', async () => {
    const calls: string[] = [];
    const getDiagnosticsSpy = jest.spyOn(TtsAudio, 'getDiagnostics').mockImplementation(async () => {
      calls.push('diagnostics');
      return availableDiagnostics as any;
    });
    const getEnginesSpy = jest.spyOn(TtsAudio, 'getEngines').mockImplementation(async () => {
      calls.push('engines');
      return engineList as any;
    });
    const getVoicesSpy = jest.spyOn(TtsAudio, 'getVoices').mockImplementation(async () => {
      calls.push('voices');
      return voiceList as any;
    });

    render(<VoiceSettingsScreen />);

    await waitFor(() => {
      expect(getDiagnosticsSpy).toHaveBeenCalled();
      expect(getEnginesSpy).toHaveBeenCalled();
      expect(getVoicesSpy).toHaveBeenCalled();
    });

    const diagnosticsIndex = calls.indexOf('diagnostics');
    const enginesIndex = calls.indexOf('engines');
    const voicesIndex = calls.indexOf('voices');
    expect(diagnosticsIndex).toBeLessThan(enginesIndex);
    expect(enginesIndex).toBeLessThan(voicesIndex);

    getDiagnosticsSpy.mockRestore();
    getEnginesSpy.mockRestore();
    getVoicesSpy.mockRestore();
  });

  test('shows install data button when language data is missing', async () => {
    jest.spyOn(TtsAudio, 'getDiagnostics').mockResolvedValue({
      ...availableDiagnostics,
      languageStatus: 'missing_data',
    } as any);
    jest.spyOn(TtsAudio, 'getEngines').mockResolvedValue(engineList as any);
    jest.spyOn(TtsAudio, 'getVoices').mockResolvedValue(voiceList as any);

    const { findByText } = render(<VoiceSettingsScreen />);

    expect(await findByText('尝试安装语音数据')).toBeTruthy();
  });

  test('shows Xiaomi hint when manufacturer is xiaomi and system TTS is unavailable', async () => {
    jest.spyOn(TtsAudio, 'getDiagnostics').mockResolvedValue({
      ...availableDiagnostics,
      manufacturer: 'Xiaomi',
      model: 'MIX 4',
      initialized: false,
      languageStatus: 'missing_data',
      errorCode: 'TTS_LANGUAGE_DATA_MISSING',
    } as any);
    jest.spyOn(TtsAudio, 'getEngines').mockResolvedValue(engineList as any);
    jest.spyOn(TtsAudio, 'getVoices').mockResolvedValue(voiceList as any);

    const { findByText } = render(<VoiceSettingsScreen />);

    expect(
      await findByText(
        '小米系统可能未预装中文 TTS 引擎。可先打开系统语音设置安装语音数据，或切换到“内置离线 TTS”。',
      ),
    ).toBeTruthy();
  });

  test('voice list marks network voices with a badge', async () => {
    jest.spyOn(TtsAudio, 'getDiagnostics').mockResolvedValue(availableDiagnostics as any);
    jest.spyOn(TtsAudio, 'getEngines').mockResolvedValue(engineList as any);
    jest.spyOn(TtsAudio, 'getVoices').mockResolvedValue(voiceList as any);

    const { getByText, findByText } = render(<VoiceSettingsScreen />);
    await findByText('TTS 诊断');

    fireEvent.press(getByText('引擎默认声线').parent!);

    expect(await findByText('中文女声（zh-CN）')).toBeTruthy();
    expect(await findByText('中文高清声（zh-CN） [联网]')).toBeTruthy();
  });
});
