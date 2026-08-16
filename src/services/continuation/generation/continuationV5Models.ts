/**
 * V5 stage model resolution (Kernel Final Closure §8.3): freeze the five
 * V5 stage models (draft writer / architect / revision / auditor / final
 * reviser) from the persisted generation settings before the run row is
 * inserted. Pure pre-Freeze resolution — no stage execution here.
 */
import type { LLMRequestConfig } from '../../llm/types';
import { resolveLLMRequestConfig, resolveLLMRequestConfigById } from '../../llm';
import type {
  ContinuationGenerationSettings,
  FrozenContinuationModelConfig,
} from './types';
import { ContinuationCapabilityBlockedError } from './types';

interface V5StageModel {
  configId: number;
  contextWindow: number;
  maxOutputTokens: number;
}

interface V5StageModels {
  draft_writer: V5StageModel;
  narrative_architect: V5StageModel;
  revision_writer: V5StageModel;
  adversarial_auditor: V5StageModel;
  final_reviser: V5StageModel;
}

function requirePositive(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ContinuationCapabilityBlockedError(
      `${label} 必须来自有效的冻结模型能力，当前值不可用。`,
    );
  }
  return Math.floor(parsed);
}

function modelConfigId(config: LLMRequestConfig | null | undefined): number {
  return requirePositive(config?.id, 'LLM 配置 id');
}

function freezeV5ModelConfig(
  config: LLMRequestConfig | null | undefined,
): FrozenContinuationModelConfig {
  if (!config) {
    throw new ContinuationCapabilityBlockedError('缺少 V5 阶段模型配置。');
  }
  return {
    configId: modelConfigId(config),
    name: String(config.name || `LLM 配置 #${config.id}`),
    providerType: config.provider_type,
    url: config.url,
    modelName: config.model_name,
    contextWindow: requirePositive(config.context_window, 'context_window'),
    maxOutputTokens: requirePositive(
      config.max_output_tokens,
      'max_output_tokens',
    ),
  };
}

async function resolveV5StageConfig(
  configuredId: number | null,
  activeConfig: LLMRequestConfig | null,
): Promise<LLMRequestConfig> {
  const config =
    configuredId == null
      ? activeConfig
      : await resolveLLMRequestConfigById(configuredId).catch(() => null);
  if (!config) {
    throw new ContinuationCapabilityBlockedError(
      `无法读取已选择的 LLM 配置 #${String(configuredId ?? '')}。`,
    );
  }
  if (configuredId != null && modelConfigId(config) !== configuredId) {
    throw new ContinuationCapabilityBlockedError(
      `LLM 配置 #${configuredId} 读取后 id 不一致，已阻止本次续写。`,
    );
  }
  return config;
}

/** Prefer larger context, then max output, then stable configId. */
function pickAuditorConfig(
  checker: LLMRequestConfig,
  control: LLMRequestConfig,
): LLMRequestConfig {
  const score = (config: LLMRequestConfig) => {
    const window = Number(config.context_window) || 0;
    const maxOut = Number(config.max_output_tokens) || 0;
    const id = Number(config.id) || 0;
    return window * 1_000_000 + maxOut * 100 + id;
  };
  return score(control) > score(checker) ? control : checker;
}

export async function resolveV5StageModels(
  settings: ContinuationGenerationSettings,
): Promise<{
  stageModels: V5StageModels;
  frozenModelConfigs: NonNullable<
    import('./types').ContinuationGenerationSettingsSnapshot['frozenModelConfigs']
  >;
  activeConfigId: number;
}> {
  const activeConfig = await resolveLLMRequestConfig().catch(() => null);
  if (!activeConfig) {
    throw new ContinuationCapabilityBlockedError(
      '当前没有可用的活动 LLM 配置。',
    );
  }
  const activeConfigId = modelConfigId(activeConfig);
  const [writer, planner, checker, control, repair] = await Promise.all([
    resolveV5StageConfig(settings.writerLlmConfigId, activeConfig),
    resolveV5StageConfig(settings.plannerLlmConfigId, activeConfig),
    resolveV5StageConfig(settings.checkerLlmConfigId, activeConfig),
    resolveV5StageConfig(settings.controlLlmConfigId, activeConfig),
    resolveV5StageConfig(settings.repairLlmConfigId, activeConfig),
  ]);
  const auditor = pickAuditorConfig(checker, control);
  const frozen = {
    planner: freezeV5ModelConfig(planner),
    writer: freezeV5ModelConfig(writer),
    checker: freezeV5ModelConfig(checker),
    repair: freezeV5ModelConfig(repair),
    stateExtraction: null,
    control: freezeV5ModelConfig(control),
    draftWriter: freezeV5ModelConfig(writer),
    narrativeArchitect: freezeV5ModelConfig(planner),
    revisionWriter: freezeV5ModelConfig(repair),
    adversarialAuditor: freezeV5ModelConfig(auditor),
    finalReviser: freezeV5ModelConfig(repair),
  };
  return {
    activeConfigId,
    frozenModelConfigs: frozen,
    stageModels: {
      draft_writer: {
        configId: frozen.draftWriter!.configId,
        contextWindow: frozen.draftWriter!.contextWindow,
        maxOutputTokens: frozen.draftWriter!.maxOutputTokens,
      },
      narrative_architect: {
        configId: frozen.narrativeArchitect!.configId,
        contextWindow: frozen.narrativeArchitect!.contextWindow,
        maxOutputTokens: frozen.narrativeArchitect!.maxOutputTokens,
      },
      revision_writer: {
        configId: frozen.revisionWriter!.configId,
        contextWindow: frozen.revisionWriter!.contextWindow,
        maxOutputTokens: frozen.revisionWriter!.maxOutputTokens,
      },
      adversarial_auditor: {
        configId: frozen.adversarialAuditor!.configId,
        contextWindow: frozen.adversarialAuditor!.contextWindow,
        maxOutputTokens: frozen.adversarialAuditor!.maxOutputTokens,
      },
      final_reviser: {
        configId: frozen.finalReviser!.configId,
        contextWindow: frozen.finalReviser!.contextWindow,
        maxOutputTokens: frozen.finalReviser!.maxOutputTokens,
      },
    },
  };
}
