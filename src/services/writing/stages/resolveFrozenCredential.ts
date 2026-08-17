import { getSecureLLMApiKey } from '../../secureStorage';
import type { WritingCredentialRef } from '../contracts/writingSource';

/**
 * Resolve only the secret for a frozen credential reference.
 * Must never read live model/url/window/reasoning settings.
 */
export async function resolveWritingCredential(
  credentialRef: WritingCredentialRef | null | undefined,
): Promise<string> {
  if (!credentialRef || credentialRef.kind !== 'llm-config-api-key') {
    return '';
  }
  const configId = Number(credentialRef.configId);
  if (!Number.isInteger(configId) || configId <= 0) {
    return '';
  }
  return getSecureLLMApiKey(configId);
}
