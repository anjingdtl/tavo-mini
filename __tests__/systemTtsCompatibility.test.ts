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

import { useVoiceStore } from '../src/store/voiceStore';
import { TtsAudio, TtsAudioEmitter } from '../src/native/TtsAudioModule';
import * as ttsService from '../src/services/tts';

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

describe('system TTS compatibility store behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useVoiceStore.setState({
      engine: 'system',
      config: { ...DEFAULT_CLOUD },
      apiKey: '',
      systemConfig: { ...DEFAULT_SYSTEM },
      isSynthesizing: false,
      isPlaying: false,
      activeTtsSessionId: null,
      ttsProgress: null,
      lastTtsError: null,
    });
  });

  test('system engine calls TtsAudio.speak without cloud synthesis', async () => {
    const speakSpy = jest.spyOn(TtsAudio, 'speak').mockResolvedValue(undefined);
    const synthSpy = jest.spyOn(ttsService, 'synthesizeToFile').mockResolvedValue('/tmp/x.mp3');

    await useVoiceStore.getState().playChapter('你好世界');

    expect(speakSpy).toHaveBeenCalled();
    expect(synthSpy).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().isSynthesizing).toBe(false);
    expect(useVoiceStore.getState().isPlaying).toBe(true);

    speakSpy.mockRestore();
    synthSpy.mockRestore();
  });

  test('cloud engine behavior is unchanged', async () => {
    useVoiceStore.setState({ engine: 'cloud', apiKey: 'k' });
    const speakSpy = jest.spyOn(TtsAudio, 'speak').mockResolvedValue(undefined);
    const synthSpy = jest.spyOn(ttsService, 'synthesizeToFile').mockResolvedValue('/tmp/x.mp3');
    const playSpy = jest.spyOn(TtsAudio, 'playAudioFile').mockResolvedValue(undefined);

    await useVoiceStore.getState().playChapter('你好世界');

    expect(synthSpy).toHaveBeenCalled();
    expect(playSpy).toHaveBeenCalled();
    expect(speakSpy).not.toHaveBeenCalled();

    speakSpy.mockRestore();
    synthSpy.mockRestore();
    playSpy.mockRestore();
  });

  test('ttsStart marks playback active', async () => {
    jest.spyOn(TtsAudio, 'speak').mockResolvedValue(undefined);
    await useVoiceStore.getState().playChapter('你好世界');
    const sessionId = useVoiceStore.getState().activeTtsSessionId;
    expect(sessionId).not.toBeNull();

    TtsAudioEmitter.emit('ttsStart', {
      sessionId: sessionId!,
      enginePackage: '',
      chunkIndex: 0,
      chunkCount: 1,
    });

    expect(useVoiceStore.getState().isPlaying).toBe(true);
  });

  test('ttsProgress updates progress', async () => {
    jest.spyOn(TtsAudio, 'speak').mockResolvedValue(undefined);
    await useVoiceStore.getState().playChapter('你好世界');
    const sessionId = useVoiceStore.getState().activeTtsSessionId!;

    TtsAudioEmitter.emit('ttsProgress', {
      sessionId,
      enginePackage: '',
      chunkIndex: 1,
      chunkCount: 3,
    });

    expect(useVoiceStore.getState().ttsProgress).toEqual({ chunkIndex: 1, chunkCount: 3 });
  });

  test('ttsDone resets playback state', async () => {
    jest.spyOn(TtsAudio, 'speak').mockResolvedValue(undefined);
    await useVoiceStore.getState().playChapter('你好世界');
    const sessionId = useVoiceStore.getState().activeTtsSessionId!;

    TtsAudioEmitter.emit('ttsDone', {
      sessionId,
      enginePackage: '',
      chunkIndex: 0,
      chunkCount: 1,
    });

    expect(useVoiceStore.getState().isPlaying).toBe(false);
    expect(useVoiceStore.getState().isSynthesizing).toBe(false);
    expect(useVoiceStore.getState().activeTtsSessionId).toBeNull();
    expect(useVoiceStore.getState().ttsProgress).toBeNull();
  });

  test('ttsError resets state and preserves error details', async () => {
    jest.spyOn(TtsAudio, 'speak').mockResolvedValue(undefined);
    await useVoiceStore.getState().playChapter('你好世界');
    const sessionId = useVoiceStore.getState().activeTtsSessionId!;

    TtsAudioEmitter.emit('ttsError', {
      sessionId,
      enginePackage: '',
      chunkIndex: 0,
      chunkCount: 1,
      errorCode: 'TTS_SPEAK_FAILED',
      nativeErrorCode: -1,
      message: '系统未能开始朗读',
    });

    expect(useVoiceStore.getState().isPlaying).toBe(false);
    expect(useVoiceStore.getState().isSynthesizing).toBe(false);
    expect(useVoiceStore.getState().activeTtsSessionId).toBeNull();
    expect(useVoiceStore.getState().lastTtsError).not.toBeNull();
    expect(useVoiceStore.getState().lastTtsError!.errorCode).toBe('TTS_SPEAK_FAILED');
    expect(useVoiceStore.getState().lastTtsError!.nativeErrorCode).toBe(-1);
  });

  test('stale session events are ignored', async () => {
    jest.spyOn(TtsAudio, 'speak').mockResolvedValue(undefined);
    await useVoiceStore.getState().playChapter('你好世界');
    const sessionId = useVoiceStore.getState().activeTtsSessionId!;

    TtsAudioEmitter.emit('ttsDone', {
      sessionId: 'stale-session-id',
      enginePackage: '',
      chunkIndex: 0,
      chunkCount: 1,
    });

    expect(useVoiceStore.getState().activeTtsSessionId).toBe(sessionId);
    expect(useVoiceStore.getState().isPlaying).toBe(true);
  });

  test('stop during synthesizing calls stopSpeak', async () => {
    useVoiceStore.setState({ isSynthesizing: true, isPlaying: false });
    const stopSpeakSpy = jest.spyOn(TtsAudio, 'stopSpeak').mockResolvedValue(undefined);

    await useVoiceStore.getState().stop();

    expect(stopSpeakSpy).toHaveBeenCalled();
    expect(useVoiceStore.getState().isSynthesizing).toBe(false);
    stopSpeakSpy.mockRestore();
  });
});
