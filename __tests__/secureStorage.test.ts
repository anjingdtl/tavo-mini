/* eslint-env jest */

import * as Keychain from 'react-native-keychain';
import { getSecureLLMApiKey, setSecureLLMApiKey } from '../src/services/secureStorage';

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
