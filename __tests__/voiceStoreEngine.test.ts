import { useVoiceStore } from '../src/store/voiceStore';
import { TtsAudio } from '../src/native/TtsAudioModule';
import * as ttsService from '../src/services/tts';

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

describe('voiceStore engine dispatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useVoiceStore.setState({
      engine: 'system',
      isSynthesizing: false,
      isPlaying: false,
      systemConfig: { ...DEFAULT_SYSTEM },
      config: { ...DEFAULT_CLOUD },
      apiKey: '',
    });
  });

  test('system engine calls TtsAudio.speak, not synthesizeToFile', async () => {
    const speakSpy = jest.spyOn(TtsAudio, 'speak').mockResolvedValue(undefined);
    const synthSpy = jest.spyOn(ttsService, 'synthesizeToFile').mockResolvedValue('/tmp/x.mp3');

    await useVoiceStore.getState().playChapter('你好世界');

    expect(speakSpy).toHaveBeenCalled();
    expect(TtsAudio.beginBackgroundPlayback).toHaveBeenCalled();
    expect(synthSpy).not.toHaveBeenCalled();
    speakSpy.mockRestore();
    synthSpy.mockRestore();
  });

  test('cloud engine calls synthesizeToFile + playAudioFile, not speak', async () => {
    useVoiceStore.setState({ engine: 'cloud', apiKey: 'k' });
    const speakSpy = jest.spyOn(TtsAudio, 'speak').mockResolvedValue(undefined);
    const synthSpy = jest.spyOn(ttsService, 'synthesizeToFile').mockResolvedValue('/tmp/x.mp3');
    const playSpy = jest.spyOn(TtsAudio, 'playAudioFile').mockResolvedValue(undefined);

    await useVoiceStore.getState().playChapter('你好世界');

    expect(synthSpy).toHaveBeenCalled();
    expect(playSpy).toHaveBeenCalled();
    expect(TtsAudio.beginBackgroundPlayback).toHaveBeenCalled();
    expect(TtsAudio.endBackgroundPlayback).toHaveBeenCalled();
    expect(speakSpy).not.toHaveBeenCalled();
    speakSpy.mockRestore();
    synthSpy.mockRestore();
    playSpy.mockRestore();
  });

  test('stop in system engine calls TtsAudio.stopSpeak', async () => {
    useVoiceStore.setState({ engine: 'system', isPlaying: true });
    const stopSpeakSpy = jest.spyOn(TtsAudio, 'stopSpeak').mockResolvedValue(undefined);
    const stopAudioSpy = jest.spyOn(TtsAudio, 'stopAudio').mockResolvedValue(undefined);

    await useVoiceStore.getState().stop();

    expect(stopSpeakSpy).toHaveBeenCalled();
    expect(stopAudioSpy).not.toHaveBeenCalled();
    expect(TtsAudio.endBackgroundPlayback).toHaveBeenCalled();
    stopSpeakSpy.mockRestore();
    stopAudioSpy.mockRestore();
  });

  test('setEngine stops current playback before switching', async () => {
    useVoiceStore.setState({ engine: 'system', isPlaying: true });
    const stopSpeakSpy = jest.spyOn(TtsAudio, 'stopSpeak').mockResolvedValue(undefined);

    await useVoiceStore.getState().setEngine('cloud');

    expect(stopSpeakSpy).toHaveBeenCalled();
    expect(useVoiceStore.getState().engine).toBe('cloud');
    stopSpeakSpy.mockRestore();
  });
});
