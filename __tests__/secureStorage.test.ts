/* eslint-env jest */

import * as Keychain from 'react-native-keychain';
import {
  clearSecureLLMApiKey,
  clearSecureMiniMaxApiKey,
  clearSecureVoiceApiKey,
  getSecureLLMApiKey,
  getSecureMiniMaxApiKey,
  getSecureVoiceApiKey,
  migrateLegacyLLMApiKey,
  setSecureLLMApiKey,
  setSecureMiniMaxApiKey,
  setSecureVoiceApiKey,
} from '../src/services/secureStorage';

test('stores LLM API keys in keychain instead of plain app data', async () => {
  await setSecureLLMApiKey(' sk-real ');

  expect(Keychain.setGenericPassword).toHaveBeenCalledWith(
    'llm-api-key',
    'sk-real',
    expect.objectContaining({ service: 'com.shinewriter.llm.api-key' }),
  );
});

test('reads LLM API keys from keychain', async () => {
  (Keychain.getGenericPassword as jest.Mock).mockResolvedValue({ username: 'llm-api-key', password: 'sk-real' });

  await expect(getSecureLLMApiKey()).resolves.toBe('sk-real');
});

test('stores and reads LLM API keys by config id', async () => {
  await setSecureLLMApiKey(' sk-alt ', 42);

  expect(Keychain.setGenericPassword).toHaveBeenCalledWith(
    'llm-api-key-42',
    'sk-alt',
    expect.objectContaining({ service: 'com.shinewriter.llm.api-key.42' }),
  );

  (Keychain.getGenericPassword as jest.Mock).mockResolvedValue({ username: 'llm-api-key-42', password: 'sk-alt' });
  await expect(getSecureLLMApiKey(42)).resolves.toBe('sk-alt');
});

test('clears a config-specific LLM API key', async () => {
  await clearSecureLLMApiKey(42);

  expect(Keychain.resetGenericPassword).toHaveBeenCalledWith({
    service: 'com.shinewriter.llm.api-key.42',
  });
});

test('clears an empty LLM API key using the config-specific service', async () => {
  await setSecureLLMApiKey('   ', 7);

  expect(Keychain.resetGenericPassword).toHaveBeenCalledWith({
    service: 'com.shinewriter.llm.api-key.7',
  });
});

test('returns an empty LLM key when keychain has no credentials', async () => {
  (Keychain.getGenericPassword as jest.Mock).mockResolvedValueOnce(false);

  await expect(getSecureLLMApiKey(99)).resolves.toBe('');
});

test('reports keychain write failures', async () => {
  (Keychain.setGenericPassword as jest.Mock).mockResolvedValueOnce(false);

  await expect(setSecureLLMApiKey('sk-fails')).rejects.toThrow('API Key 安全存储写入失败');
});

test('migrates a legacy LLM key only when the target is empty', async () => {
  (Keychain.getGenericPassword as jest.Mock).mockImplementation(async (options: { service?: string }) => {
    if (options.service === 'com.shinewriter.llm.api-key.1') {
      return false;
    }
    if (options.service === 'com.shinewriter.llm.api-key') {
      return { username: 'legacy', password: 'legacy-key' };
    }
    return false;
  });

  await expect(migrateLegacyLLMApiKey(1)).resolves.toBe('legacy-key');
  expect(Keychain.setGenericPassword).toHaveBeenCalledWith(
    'llm-api-key-1',
    'legacy-key',
    expect.objectContaining({ service: 'com.shinewriter.llm.api-key.1' }),
  );
});

test('does not rewrite an existing or missing legacy LLM key', async () => {
  (Keychain.getGenericPassword as jest.Mock)
    .mockResolvedValueOnce({ username: 'current', password: 'current-key' });
  await expect(migrateLegacyLLMApiKey(2)).resolves.toBe('current-key');

  (Keychain.getGenericPassword as jest.Mock)
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(false);
  await expect(migrateLegacyLLMApiKey(3)).resolves.toBe('');
});

test('stores, reads, and clears voice API keys', async () => {
  await setSecureVoiceApiKey(' voice-key ');
  expect(Keychain.setGenericPassword).toHaveBeenCalledWith(
    'voice-api-key',
    'voice-key',
    expect.objectContaining({ service: 'com.shinewriter.minimax.api-key' }),
  );

  (Keychain.getGenericPassword as jest.Mock).mockResolvedValueOnce({
    username: 'voice-api-key',
    password: 'voice-key',
  });
  await expect(getSecureVoiceApiKey()).resolves.toBe('voice-key');
  await clearSecureVoiceApiKey();
  expect(Keychain.resetGenericPassword).toHaveBeenCalledWith(
    expect.objectContaining({ service: 'com.shinewriter.minimax.api-key' }),
  );
});

test('handles empty and failed voice key writes', async () => {
  await setSecureVoiceApiKey('  ');
  expect(Keychain.resetGenericPassword).toHaveBeenCalledWith(
    expect.objectContaining({ service: 'com.shinewriter.minimax.api-key' }),
  );

  (Keychain.setGenericPassword as jest.Mock).mockResolvedValueOnce(false);
  await expect(setSecureVoiceApiKey('voice-fails')).rejects.toThrow('语音 API Key 安全存储写入失败');
});

test('keeps MiniMax compatibility aliases idempotent', async () => {
  (Keychain.getGenericPassword as jest.Mock).mockResolvedValueOnce({
    username: 'voice-api-key',
    password: 'same-key',
  });
  await setSecureMiniMaxApiKey(' same-key ');
  expect(Keychain.setGenericPassword).not.toHaveBeenCalledWith(
    'minimax-api-key',
    'same-key',
    expect.anything(),
  );

  await setSecureMiniMaxApiKey('new-key');
  expect(Keychain.setGenericPassword).toHaveBeenCalledWith(
    'minimax-api-key',
    'new-key',
    expect.objectContaining({ service: 'com.shinewriter.minimax.api-key' }),
  );

  (Keychain.getGenericPassword as jest.Mock).mockResolvedValueOnce(false);
  await expect(getSecureMiniMaxApiKey()).resolves.toBe('');
  await clearSecureMiniMaxApiKey();
});
