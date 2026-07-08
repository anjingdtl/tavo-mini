jest.mock('../src/services/secureStorage', () => ({
  getSecureVoiceApiKey: jest.fn(async () => ''),
  setSecureVoiceApiKey: jest.fn(async () => undefined),
  clearSecureVoiceApiKey: jest.fn(async () => undefined),
  getSecureMiniMaxApiKey: jest.fn(async () => ''),
  setSecureMiniMaxApiKey: jest.fn(async () => undefined),
  clearSecureMiniMaxApiKey: jest.fn(async () => undefined),
}));

jest.mock('../src/services/database', () => ({
  getVoiceConfig: jest.fn(),
  setVoiceConfig: jest.fn(),
  getTtsEngine: jest.fn(),
  setTtsEngine: jest.fn(),
  getSystemTtsConfig: jest.fn(),
  setSystemTtsConfig: jest.fn(),
  getSecureVoiceApiKey: jest.fn(),
}));

import { useVoiceStore } from '../src/store/voiceStore';
import { TtsAudio, TtsAudioEmitter } from '../src/native/TtsAudioModule';
import * as secureStorage from '../src/services/secureStorage';
import * as db from '../src/services/database';

const sampleConfig = {
  model: 'speech-2.8-hd',
  voiceId: 'male-qn-qingse',
  speed: 1,
  vol: 1,
  pitch: 0,
  sampleRate: 32000,
  bitrate: 128000,
  format: 'mp3',
};

const sampleSystemConfig = {
  enginePackage: '',
  voiceKey: '',
  language: 'zh-CN',
  speed: 1,
  pitch: 1,
  volume: 1,
};

describe('voiceStore playback state', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (db.getVoiceConfig as jest.Mock).mockResolvedValue(sampleConfig);
    (db.getSystemTtsConfig as jest.Mock).mockResolvedValue(sampleSystemConfig);
    (db.getTtsEngine as jest.Mock).mockResolvedValue('system');
    (secureStorage.getSecureVoiceApiKey as jest.Mock).mockResolvedValue('');
    (TtsAudio.speak as jest.Mock).mockResolvedValue(undefined);
    (TtsAudio.stopSpeak as jest.Mock).mockResolvedValue(undefined);
    useVoiceStore.setState({
      engine: 'system',
      config: sampleConfig as any,
      systemConfig: sampleSystemConfig as any,
      apiKey: '',
      isSynthesizing: false,
      isPlaying: false,
      playbackState: 'idle',
      lastPlayEndedAt: null,
      activeTtsSessionId: null,
      ttsProgress: null,
      lastTtsError: null,
    });
  });

  it('exposes playbackState and lastPlayEndedAt on the store shape', () => {
    const state = useVoiceStore.getState();
    expect(state.playbackState).toBe('idle');
    expect(state.lastPlayEndedAt).toBeNull();
  });

  it('moves playbackState to synthesizing then playing when playChapter starts', async () => {
    const speak = TtsAudio.speak as jest.Mock;
    let resolveSpeak!: () => void;
    speak.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveSpeak = resolve; }),
    );

    const playPromise = useVoiceStore.getState().playChapter('hello world');
    await Promise.resolve();
    expect(useVoiceStore.getState().playbackState).toBe('synthesizing');

    resolveSpeak();
    await playPromise;
    expect(useVoiceStore.getState().playbackState).toBe('playing');
  });

  it('records lastPlayEndedAt and resets playbackState to idle when ttsDone fires', async () => {
    jest.spyOn(TtsAudio, 'speak').mockResolvedValue(undefined);
    await useVoiceStore.getState().playChapter('some text');
    expect(useVoiceStore.getState().playbackState).toBe('playing');
    const sessionId = useVoiceStore.getState().activeTtsSessionId!;

    const before = Date.now();
    TtsAudioEmitter.emit('ttsDone', {
      sessionId,
      enginePackage: '',
      chunkIndex: 0,
      chunkCount: 1,
    });

    const state = useVoiceStore.getState();
    expect(state.playbackState).toBe('idle');
    expect(state.isPlaying).toBe(false);
    expect(state.lastPlayEndedAt).not.toBeNull();
    expect(state.lastPlayEndedAt!).toBeGreaterThanOrEqual(before);
  });

  it('does NOT set lastPlayEndedAt when ttsDone fires for a stale session', async () => {
    jest.spyOn(TtsAudio, 'speak').mockResolvedValue(undefined);
    await useVoiceStore.getState().playChapter('some text');
    const activeId = useVoiceStore.getState().activeTtsSessionId!;

    useVoiceStore.setState({ playbackState: 'playing', isPlaying: true, lastPlayEndedAt: null });
    TtsAudioEmitter.emit('ttsDone', {
      sessionId: 'stale-id-different',
      enginePackage: '',
      chunkIndex: 0,
      chunkCount: 1,
    });
    expect(useVoiceStore.getState().playbackState).toBe('playing');
    expect(useVoiceStore.getState().lastPlayEndedAt).toBeNull();

    TtsAudioEmitter.emit('ttsDone', {
      sessionId: activeId,
      enginePackage: '',
      chunkIndex: 0,
      chunkCount: 1,
    });
    expect(useVoiceStore.getState().playbackState).toBe('idle');
    expect(useVoiceStore.getState().lastPlayEndedAt).not.toBeNull();
  });
});
