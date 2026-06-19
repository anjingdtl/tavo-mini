import * as Keychain from 'react-native-keychain';

const LLM_API_KEY_SERVICE = 'com.tavomini.llm.api-key';
const LLM_API_KEY_ACCOUNT = 'llm-api-key';
const MINIMAX_API_KEY_SERVICE = 'com.tavomini.minimax.api-key';
const MINIMAX_API_KEY_ACCOUNT = 'minimax-api-key';

function serviceForConfig(configId?: number): string {
  return configId == null ? LLM_API_KEY_SERVICE : `${LLM_API_KEY_SERVICE}.${configId}`;
}

function accountForConfig(configId?: number): string {
  return configId == null ? LLM_API_KEY_ACCOUNT : `${LLM_API_KEY_ACCOUNT}-${configId}`;
}

function keychainOptions(configId?: number) {
  return {
    service: serviceForConfig(configId),
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  };
}

const minimaxKeychainOptions = {
  service: MINIMAX_API_KEY_SERVICE,
  accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export async function getSecureLLMApiKey(configId?: number): Promise<string> {
  const credentials = await Keychain.getGenericPassword(keychainOptions(configId));
  return credentials ? credentials.password : '';
}

export async function clearSecureLLMApiKey(configId?: number): Promise<void> {
  await Keychain.resetGenericPassword({ service: serviceForConfig(configId) });
}

export async function setSecureLLMApiKey(apiKey: string, configId?: number): Promise<void> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    await clearSecureLLMApiKey(configId);
    return;
  }
  const result = await Keychain.setGenericPassword(accountForConfig(configId), trimmed, keychainOptions(configId));
  if (!result) {
    throw new Error('API Key 安全存储写入失败。');
  }
}

export async function migrateLegacyLLMApiKey(configId: number): Promise<string> {
  const current = await getSecureLLMApiKey(configId);
  if (current) return current;

  const legacy = await getSecureLLMApiKey();
  if (!legacy) return '';

  await setSecureLLMApiKey(legacy, configId);
  return legacy;
}

export const legacyLLMKeychainOptions = {
  service: LLM_API_KEY_SERVICE,
  accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export async function getSecureMiniMaxApiKey(): Promise<string> {
  const credentials = await Keychain.getGenericPassword(minimaxKeychainOptions);
  return credentials ? credentials.password : '';
}

export async function clearSecureMiniMaxApiKey(): Promise<void> {
  await Keychain.resetGenericPassword(minimaxKeychainOptions);
}

export async function setSecureMiniMaxApiKey(apiKey: string): Promise<void> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    await clearSecureMiniMaxApiKey();
    return;
  }
  const result = await Keychain.setGenericPassword(MINIMAX_API_KEY_ACCOUNT, trimmed, minimaxKeychainOptions);
  if (!result) {
    throw new Error('MiniMax API Key 安全存储写入失败。');
  }
}
