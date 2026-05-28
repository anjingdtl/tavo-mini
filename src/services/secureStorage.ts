import * as Keychain from 'react-native-keychain';

const LLM_API_KEY_SERVICE = 'com.tavomini.llm.api-key';
const LLM_API_KEY_ACCOUNT = 'llm-api-key';

const keychainOptions = {
  service: LLM_API_KEY_SERVICE,
  accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export async function getSecureLLMApiKey(): Promise<string> {
  const credentials = await Keychain.getGenericPassword(keychainOptions);
  return credentials ? credentials.password : '';
}

export async function setSecureLLMApiKey(apiKey: string): Promise<void> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    await Keychain.resetGenericPassword({ service: LLM_API_KEY_SERVICE });
    return;
  }
  const result = await Keychain.setGenericPassword(LLM_API_KEY_ACCOUNT, trimmed, keychainOptions);
  if (!result) {
    throw new Error('API Key 安全存储写入失败。');
  }
}
