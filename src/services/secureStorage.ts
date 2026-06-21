import * as Keychain from 'react-native-keychain';

const LLM_API_KEY_SERVICE = 'com.tavomini.llm.api-key';
const LLM_API_KEY_ACCOUNT = 'llm-api-key';
const VOICE_API_KEY_SERVICE = 'com.tavomini.minimax.api-key';
const VOICE_API_KEY_ACCOUNT = 'voice-api-key';
const LEGACY_MINIMAX_API_KEY_ACCOUNT = 'minimax-api-key';

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

const voiceKeychainOptions = {
  service: VOICE_API_KEY_SERVICE,
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

export async function getSecureVoiceApiKey(): Promise<string> {
  const credentials = await Keychain.getGenericPassword(voiceKeychainOptions);
  return credentials ? credentials.password : '';
}

export async function clearSecureVoiceApiKey(): Promise<void> {
  await Keychain.resetGenericPassword(voiceKeychainOptions);
}

export async function setSecureVoiceApiKey(apiKey: string): Promise<void> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    await clearSecureVoiceApiKey();
    return;
  }
  const result = await Keychain.setGenericPassword(VOICE_API_KEY_ACCOUNT, trimmed, voiceKeychainOptions);
  if (!result) {
    throw new Error('语音 API Key 安全存储写入失败。');
  }
}

export async function getSecureMiniMaxApiKey(): Promise<string> {
  return getSecureVoiceApiKey();
}

export async function clearSecureMiniMaxApiKey(): Promise<void> {
  await clearSecureVoiceApiKey();
}

export async function setSecureMiniMaxApiKey(apiKey: string): Promise<void> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    await clearSecureVoiceApiKey();
    return;
  }
  const existing = await getSecureVoiceApiKey();
  if (existing === trimmed) return;
  const result = await Keychain.setGenericPassword(LEGACY_MINIMAX_API_KEY_ACCOUNT, trimmed, voiceKeychainOptions);
  if (!result) {
    throw new Error('语音 API Key 安全存储写入失败。');
  }
}
