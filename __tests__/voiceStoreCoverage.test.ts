/* eslint-env jest */

jest.mock('../src/services/database', () => ({
  getVoiceConfig: jest.fn(),
  setVoiceConfig: jest.fn(),
  getTtsEngine: jest.fn(),
  setTtsEngine: jest.fn(),
  getSystemTtsConfig: jest.fn(),
  setSystemTtsConfig: jest.fn(),
}));

jest.mock('../src/services/secureStorage', () => ({
  getSecureVoiceApiKey: jest.fn(),
  setSecureVoiceApiKey: jest.fn(),
}));

jest.mock('../src/services/tts', () => ({
  synthesizeToFile: jest.fn(),
  cancelTts: jest.fn(),
  isTtsTextTooLong: jest.fn(),
}));

jest.mock('../src/utils/notificationPermission', () => ({
  requestNotificationPermission: jest.fn(async () => true),
}));

jest.mock('react-native-fs', () => ({
  exists: jest.fn(),
  unlink: jest.fn(),
}));

import Toast from 'react-native-toast-message';
import RNFS from 'react-native-fs';
import { TtsAudio, TtsAudioEmitter } from '../src/native/TtsAudioModule';
import * as db from '../src/services/database';
import * as secureStorage from '../src/services/secureStorage';
import * as ttsService from '../src/services/tts';
import { useVoiceStore, initializeTtsListeners } from '../src/store/voiceStore';

const cloudConfig = {
  apiUrl: 'https://tts.example.test/v1',
  model: 'speech-model',
  voiceId: 'voice-a',
  speed: 1,
  vol: 1,
  pitch: 0,
  sampleRate: 32000 as const,
  bitrate: 128000 as const,
  format: 'mp3' as const,
};

const systemConfig = {
  enginePackage: '',
  voiceKey: '',
  language: 'zh-CN',
  speed: 1,
  pitch: 1,
  volume: 1,
};

function resetStore(): void {
  useVoiceStore.setState({
    engine: 'system',
    config: { ...cloudConfig },
    apiKey: '',
    systemConfig: { ...systemConfig },
    isSynthesizing: false,
    isPlaying: false,
    playbackState: 'idle',
    lastPlayEndedAt: null,
    activeTtsSessionId: null,
    ttsProgress: null,
    lastTtsError: null,
  });
}

describe('voiceStore uncovered branches', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetStore();
    (db.getVoiceConfig as jest.Mock).mockResolvedValue({ ...cloudConfig });
    (db.getTtsEngine as jest.Mock).mockResolvedValue('system');
    (db.getSystemTtsConfig as jest.Mock).mockResolvedValue({ ...systemConfig });
    (db.setVoiceConfig as jest.Mock).mockResolvedValue(undefined);
    (db.setSystemTtsConfig as jest.Mock).mockResolvedValue(undefined);
    (db.setTtsEngine as jest.Mock).mockResolvedValue(undefined);
    (secureStorage.getSecureVoiceApiKey as jest.Mock).mockResolvedValue('stored-key');
    (secureStorage.setSecureVoiceApiKey as jest.Mock).mockResolvedValue(undefined);
    (ttsService.isTtsTextTooLong as jest.Mock).mockReturnValue(false);
    (ttsService.synthesizeToFile as jest.Mock).mockResolvedValue('/tmp/audio.mp3');
    (ttsService.cancelTts as jest.Mock).mockResolvedValue(undefined);
    (RNFS.exists as jest.Mock).mockResolvedValue(false);
    (RNFS.unlink as jest.Mock).mockResolvedValue(undefined);
    (TtsAudio.beginBackgroundPlayback as jest.Mock).mockResolvedValue(undefined);
    (TtsAudio.endBackgroundPlayback as jest.Mock).mockResolvedValue(undefined);
    (TtsAudio.speak as jest.Mock).mockResolvedValue(undefined);
    (TtsAudio.playAudioFile as jest.Mock).mockResolvedValue(undefined);
    (TtsAudio.stopSpeak as jest.Mock).mockResolvedValue(undefined);
    (TtsAudio.stopAudio as jest.Mock).mockResolvedValue(undefined);
  });

  it('loads and saves all voice configuration values', async () => {
    await useVoiceStore.getState().loadVoiceConfig();
    expect(useVoiceStore.getState()).toEqual(expect.objectContaining({
      config: cloudConfig,
      apiKey: 'stored-key',
      engine: 'system',
      systemConfig,
    }));

    const nextConfig = { ...cloudConfig, voiceId: 'voice-b' };
    const nextSystemConfig = { ...systemConfig, language: 'en-US' };
    await useVoiceStore.getState().saveVoiceConfig(nextConfig);
    await useVoiceStore.getState().saveSystemTtsConfig(nextSystemConfig);
    await useVoiceStore.getState().setVoiceApiKey('  next-key  ');

    expect(db.setVoiceConfig).toHaveBeenCalledWith(nextConfig);
    expect(db.setSystemTtsConfig).toHaveBeenCalledWith(nextSystemConfig);
    expect(db.setTtsEngine).not.toHaveBeenCalled();
    expect(secureStorage.setSecureVoiceApiKey).toHaveBeenCalledWith('  next-key  ');
    expect(useVoiceStore.getState().apiKey).toBe('next-key');
  });

  it('guards busy, empty, builtin, and cloud-without-key requests', async () => {
    useVoiceStore.setState({ isSynthesizing: true });
    await useVoiceStore.getState().playChapter('busy');
    expect(Toast.show).not.toHaveBeenCalled();

    useVoiceStore.setState({ isSynthesizing: false });
    await useVoiceStore.getState().playChapter('   ');
    expect(Toast.show).toHaveBeenCalledWith({ type: 'error', text1: '当前章节没有正文内容' });

    (Toast.show as jest.Mock).mockClear();
    useVoiceStore.setState({ engine: 'builtin' });
    await useVoiceStore.getState().playChapter('offline');
    expect(Toast.show).toHaveBeenCalledWith(expect.objectContaining({ type: 'info' }));

    (Toast.show as jest.Mock).mockClear();
    useVoiceStore.setState({ engine: 'cloud', apiKey: '' });
    await useVoiceStore.getState().playChapter('cloud');
    expect(Toast.show).toHaveBeenCalledWith({ type: 'error', text1: '请先配置语音 API Key' });
    expect(ttsService.synthesizeToFile).not.toHaveBeenCalled();
  });

  it('cleans up a successful cloud playback and tolerates background-service failures', async () => {
    useVoiceStore.setState({ engine: 'cloud', apiKey: 'cloud-key' });
    (ttsService.isTtsTextTooLong as jest.Mock).mockReturnValue(true);
    (RNFS.exists as jest.Mock).mockResolvedValue(true);
    (TtsAudio.beginBackgroundPlayback as jest.Mock).mockRejectedValueOnce(new Error('service unavailable'));
    (TtsAudio.endBackgroundPlayback as jest.Mock).mockRejectedValueOnce(new Error('cleanup unavailable'));

    await useVoiceStore.getState().playChapter('long text');

    expect(Toast.show).toHaveBeenCalledWith(expect.objectContaining({ type: 'info' }));
    expect(ttsService.synthesizeToFile).toHaveBeenCalledWith('long text', cloudConfig, 'cloud-key');
    expect(TtsAudio.playAudioFile).toHaveBeenCalledWith('/tmp/audio.mp3');
    expect(RNFS.unlink).toHaveBeenCalledWith('/tmp/audio.mp3');
    expect(useVoiceStore.getState().playbackState).toBe('idle');
    expect(useVoiceStore.getState().lastPlayEndedAt).not.toBeNull();
  });

  it('handles cloud playback, synthesis, cleanup, and cancellation errors', async () => {
    useVoiceStore.setState({ engine: 'cloud', apiKey: 'cloud-key' });
    (RNFS.exists as jest.Mock).mockResolvedValue(true);
    (TtsAudio.playAudioFile as jest.Mock).mockRejectedValueOnce(new Error('audio failed'));

    await useVoiceStore.getState().playChapter('playback failure');
    expect(Toast.show).toHaveBeenCalledWith({ type: 'error', text1: 'audio failed' });
    expect(RNFS.unlink).toHaveBeenCalled();

    (Toast.show as jest.Mock).mockClear();
    (RNFS.exists as jest.Mock).mockRejectedValueOnce(new Error('filesystem unavailable'));
    (ttsService.synthesizeToFile as jest.Mock).mockRejectedValueOnce({});
    await useVoiceStore.getState().playChapter('synthesis failure');
    expect(Toast.show).toHaveBeenCalledWith({ type: 'error', text1: '朗读失败' });

    (Toast.show as jest.Mock).mockClear();
    (ttsService.synthesizeToFile as jest.Mock).mockRejectedValueOnce(new Error('用户取消了朗读'));
    await useVoiceStore.getState().playChapter('cancelled');
    expect(Toast.show).not.toHaveBeenCalled();

    (Toast.show as jest.Mock).mockClear();
    (ttsService.synthesizeToFile as jest.Mock).mockRejectedValueOnce(new Error('停止播放'));
    await useVoiceStore.getState().playChapter('stopped');
    expect(Toast.show).not.toHaveBeenCalled();
  });

  it('handles system speak failures with and without cancellation codes', async () => {
    (TtsAudio.speak as jest.Mock).mockRejectedValueOnce({ code: 'TTS_CANCELLED' });
    await useVoiceStore.getState().playChapter('cancelled system speech');
    expect(Toast.show).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().activeTtsSessionId).toBeNull();

    (TtsAudio.speak as jest.Mock).mockRejectedValueOnce({ code: 'TTS_SPEAK_FAILED' });
    await useVoiceStore.getState().playChapter('failed system speech');
    expect(Toast.show).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    expect(useVoiceStore.getState().playbackState).toBe('idle');
  });

  it('stops idle, system, and cloud playback while swallowing native cleanup failures', async () => {
    await useVoiceStore.getState().stop();
    expect(TtsAudio.stopSpeak).not.toHaveBeenCalled();

    useVoiceStore.setState({ engine: 'system', isSynthesizing: true });
    (TtsAudio.stopSpeak as jest.Mock).mockRejectedValueOnce(new Error('stop speak failed'));
    (TtsAudio.endBackgroundPlayback as jest.Mock).mockRejectedValueOnce(new Error('end failed'));
    await useVoiceStore.getState().stop();
    expect(useVoiceStore.getState().isSynthesizing).toBe(false);

    useVoiceStore.setState({ engine: 'cloud', isSynthesizing: true, isPlaying: true });
    (ttsService.cancelTts as jest.Mock).mockRejectedValueOnce(new Error('cancel failed'));
    (TtsAudio.stopAudio as jest.Mock).mockRejectedValueOnce(new Error('stop audio failed'));
    await useVoiceStore.getState().stop();
    expect(ttsService.cancelTts).toHaveBeenCalled();
    expect(TtsAudio.stopAudio).toHaveBeenCalled();
    expect(useVoiceStore.getState().isPlaying).toBe(false);
  });

  it('updates state for current TTS events and ignores stale sessions', () => {
    initializeTtsListeners();
    const activeSessionId = 'active-session';
    useVoiceStore.setState({
      activeTtsSessionId: activeSessionId,
      isSynthesizing: true,
      isPlaying: false,
      playbackState: 'synthesizing',
    });

    const stale = { sessionId: 'stale-session', enginePackage: '', chunkIndex: 0, chunkCount: 1 };
    TtsAudioEmitter.emit('ttsStart', stale);
    TtsAudioEmitter.emit('ttsProgress', { ...stale, chunkIndex: 9, chunkCount: 9 });
    TtsAudioEmitter.emit('ttsDone', stale);
    TtsAudioEmitter.emit('ttsError', { ...stale, errorCode: 'TTS_SPEAK_FAILED', message: 'stale' });
    TtsAudioEmitter.emit('ttsStopped', stale);
    expect(useVoiceStore.getState().activeTtsSessionId).toBe(activeSessionId);

    const current = { sessionId: activeSessionId, enginePackage: '', chunkIndex: 1, chunkCount: 3 };
    TtsAudioEmitter.emit('ttsStart', current);
    expect(useVoiceStore.getState().playbackState).toBe('playing');
    TtsAudioEmitter.emit('ttsProgress', current);
    expect(useVoiceStore.getState().ttsProgress).toEqual({ chunkIndex: 1, chunkCount: 3 });
    TtsAudioEmitter.emit('ttsError', {
      ...current,
      errorCode: 'TTS_UNKNOWN',
      message: 'current failure',
    });
    expect(useVoiceStore.getState().lastTtsError?.message).toBe('current failure');
    expect(Toast.show).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));

    useVoiceStore.setState({ activeTtsSessionId: activeSessionId, isPlaying: true });
    TtsAudioEmitter.emit('ttsStopped', current);
    expect(useVoiceStore.getState().activeTtsSessionId).toBeNull();

    useVoiceStore.setState({ activeTtsSessionId: activeSessionId, isPlaying: true });
    TtsAudioEmitter.emit('ttsDone', current);
    expect(useVoiceStore.getState().activeTtsSessionId).toBeNull();
  });
});
