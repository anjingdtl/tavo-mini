import RNFS from 'react-native-fs';
import { hexAudioToBase64, truncateTtsText, isTtsTextTooLong, synthesizeToFile } from '../src/services/tts';
import { DEFAULT_VOICE_CONFIG } from '../src/constants/voice';

describe('tts service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (RNFS.writeFile as jest.Mock).mockResolvedValue(undefined);
    (RNFS.exists as jest.Mock).mockResolvedValue(true);
    (RNFS.unlink as jest.Mock).mockResolvedValue(undefined);
  });

  it('converts hex audio to base64', () => {
    expect(hexAudioToBase64('48656c6c6f')).toBe('SGVsbG8=');
  });

  it('truncates text over the limit', () => {
    const longText = 'a'.repeat(12000);
    expect(truncateTtsText(longText).length).toBe(10000);
  });

  it('detects text too long', () => {
    expect(isTtsTextTooLong('a'.repeat(10001))).toBe(true);
    expect(isTtsTextTooLong('a'.repeat(9999))).toBe(false);
  });

  it('synthesizes audio and writes to file', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({
        data: { audio: '48656c6c6f', status: 2 },
        base_resp: { status_code: 0, status_msg: 'success' },
      }),
    }) as unknown as typeof fetch;

    const path = await synthesizeToFile(
      'hello',
      { ...DEFAULT_VOICE_CONFIG, apiUrl: 'https://api.minimaxi.com/v1/t2a_v2' },
      'test-key',
    );
    expect(path).toContain('tts_');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.minimaxi.com/v1/t2a_v2',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
          'Content-Type': 'application/json',
        }),
      }),
    );
    expect(RNFS.writeFile).toHaveBeenCalledTimes(1);
    expect(RNFS.writeFile).toHaveBeenCalledWith(expect.any(String), 'SGVsbG8=', 'base64');
  });

  it('does not ship a hidden default voice API URL', () => {
    expect(DEFAULT_VOICE_CONFIG.apiUrl).toBe('');
  });

  it('uses the configured voice API URL', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({
        data: { audio: '48656c6c6f', status: 2 },
        base_resp: { status_code: 0, status_msg: 'success' },
      }),
    }) as unknown as typeof fetch;

    await synthesizeToFile(
      'hello',
      { ...DEFAULT_VOICE_CONFIG, apiUrl: 'https://voice.example.test/v1/speech' },
      'test-key',
    );

    expect(global.fetch).toHaveBeenCalledWith(
      'https://voice.example.test/v1/speech',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('throws on api error with provider status code', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({
        data: null,
        base_resp: { status_code: 2049, status_msg: 'invalid api key' },
      }),
    }) as unknown as typeof fetch;

    await expect(
      synthesizeToFile(
        'hello',
        { ...DEFAULT_VOICE_CONFIG, apiUrl: 'https://voice.example.test/v1/speech' },
        'test-key',
      ),
    ).rejects.toThrow('语音合成失败：2049 invalid api key');
  });

  it('throws when no audio returned', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({
        data: {},
        base_resp: { status_code: 0, status_msg: 'success' },
      }),
    }) as unknown as typeof fetch;

    await expect(
      synthesizeToFile(
        'hello',
        { ...DEFAULT_VOICE_CONFIG, apiUrl: 'https://voice.example.test/v1/speech' },
        'test-key',
      ),
    ).rejects.toThrow('未返回音频数据');
  });

  it('throws when api key missing', async () => {
    await expect(synthesizeToFile('hello', DEFAULT_VOICE_CONFIG, '')).rejects.toThrow('API Key');
  });

  it('throws when voice API URL missing without calling fetch', async () => {
    global.fetch = jest.fn() as unknown as typeof fetch;

    await expect(
      synthesizeToFile('hello', { ...DEFAULT_VOICE_CONFIG, apiUrl: '   ' }, 'test-key'),
    ).rejects.toThrow('语音 API URL');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
