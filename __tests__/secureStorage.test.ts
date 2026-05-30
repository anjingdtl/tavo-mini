/* eslint-env jest */

import * as Keychain from 'react-native-keychain';
import { clearSecureLLMApiKey, getSecureLLMApiKey, setSecureLLMApiKey } from '../src/services/secureStorage';

test('stores LLM API keys in keychain instead of plain app data', async () => {
  await setSecureLLMApiKey(' sk-real ');

  expect(Keychain.setGenericPassword).toHaveBeenCalledWith(
    'llm-api-key',
    'sk-real',
    expect.objectContaining({ service: 'com.tavomini.llm.api-key' }),
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
    expect.objectContaining({ service: 'com.tavomini.llm.api-key.42' }),
  );

  (Keychain.getGenericPassword as jest.Mock).mockResolvedValue({ username: 'llm-api-key-42', password: 'sk-alt' });
  await expect(getSecureLLMApiKey(42)).resolves.toBe('sk-alt');
});

test('clears a config-specific LLM API key', async () => {
  await clearSecureLLMApiKey(42);

  expect(Keychain.resetGenericPassword).toHaveBeenCalledWith({
    service: 'com.tavomini.llm.api-key.42',
  });
});
