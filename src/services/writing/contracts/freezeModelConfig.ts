import type {
  FrozenModelConfig,
  WritingCredentialRef,
} from './writingSource';
import type { FrozenStageModelConfig } from './writingPolicy';

export function writingCredentialRef(
  configId: number | null | undefined,
): WritingCredentialRef | null {
  const id = Number(configId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return { kind: 'llm-config-api-key', configId: id };
}

export function freezeWritingModelConfig(input: {
  configId: number | null;
  provider?: string;
  modelName?: string;
  url?: string;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  allowInsecureLanHttp?: boolean;
  thinking?: { type: 'enabled' | 'disabled' };
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max';
}): FrozenModelConfig {
  const credentialRef = writingCredentialRef(input.configId);
  return {
    configId: input.configId,
    provider: input.provider || 'openai_compatible',
    modelName: input.modelName || 'runtime-selected',
    url: String(input.url || ''),
    name: input.name || input.modelName || '',
    contextWindow: Math.max(1024, Number(input.contextWindow) || 8192),
    maxOutputTokens: Math.max(256, Number(input.maxOutputTokens) || 1024),
    allowInsecureLanHttp: Boolean(input.allowInsecureLanHttp),
    thinking: input.thinking,
    reasoningEffort: input.reasoningEffort,
    credentialRef,
  };
}

export function toFrozenStageModelConfig(
  model: FrozenModelConfig,
): FrozenStageModelConfig {
  return {
    configId: model.configId,
    name: model.name || model.modelName,
    providerType: model.provider,
    url: model.url || '',
    modelName: model.modelName,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    allowInsecureLanHttp: model.allowInsecureLanHttp,
    thinking: model.thinking,
    reasoningEffort: model.reasoningEffort,
    credentialRef:
      model.credentialRef ?? writingCredentialRef(model.configId),
  };
}
