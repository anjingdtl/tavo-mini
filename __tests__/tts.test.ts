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

    const path = await synthesizeToFile('hello', DEFAULT_VOICE_CONFIG, 'test-key');
    expect(path).toContain('tts_');
    expect(RNFS.writeFile).toHaveBeenCalledTimes(1);
    expect(RNFS.writeFile).toHaveBeenCalledWith(expect.any(String), 'SGVsbG8=', 'base64');
  });

  it('throws on api error', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({
        data: null,
        base_resp: { status_code: 1001, status_msg: 'invalid key' },
      }),
    }) as unknown as typeof fetch;

    await expect(synthesizeToFile('hello', DEFAULT_VOICE_CONFIG, 'test-key')).rejects.toThrow('invalid key');
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

    await expect(synthesizeToFile('hello', DEFAULT_VOICE_CONFIG, 'test-key')).rejects.toThrow('未返回音频数据');
  });

  it('throws when api key missing', async () => {
    await expect(synthesizeToFile('hello', DEFAULT_VOICE_CONFIG, '')).rejects.toThrow('API Key');
  });
});
