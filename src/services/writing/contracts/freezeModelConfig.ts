import type {
  FrozenModelConfig,
  WritingCredentialRef,
} from './writingSource';
import type { FrozenStageModelConfig } from './writingPolicy';
import {
  requireModelContextWindow,
  requireModelMaxOutputTokens,
} from '../../llm/providerCapabilities';
import { freezeContinuationThinking } from '../../continuation/generation/continuationV5Models';

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
  providerAdapterId?: string | null;
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
  const contextWindow = requireModelContextWindow(input.contextWindow);
  const maxOutputTokens = requireModelMaxOutputTokens({
    contextWindow,
    configuredMaxOutputTokens: input.maxOutputTokens,
  });
  return {
    configId: input.configId,
    provider: input.provider || 'openai_compatible',
    providerAdapterId: input.providerAdapterId ?? null,
    modelName: input.modelName || 'runtime-selected',
    url: String(input.url || ''),
    name: input.name || input.modelName || '',
    contextWindow,
    maxOutputTokens,
    allowInsecureLanHttp: Boolean(input.allowInsecureLanHttp),
    thinking: freezeContinuationThinking(input.modelName, input.thinking),
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
    providerAdapterId: model.providerAdapterId ?? null,
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
