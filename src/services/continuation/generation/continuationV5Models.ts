/**
 * V5 stage model resolution (Kernel Final Closure §8.3): freeze the five
 * V5 stage models (draft writer / architect / revision / auditor / final
 * reviser) from the persisted generation settings before the run row is
 * inserted. Pure pre-Freeze resolution — no stage execution here.
 */
import type { LLMRequestConfig } from '../../llm/types';
import { resolveLLMRequestConfig, resolveLLMRequestConfigById } from '../../llm';
import {
  requireModelContextWindow,
  requireModelMaxOutputTokens,
  resolveModelOutputCapability,
} from '../../llm/providerCapabilities';
import type {
  ContinuationGenerationSettings,
  FrozenContinuationModelConfig,
} from './types';
import { ContinuationCapabilityBlockedError } from './types';

interface V5StageModel {
  configId: number;
  contextWindow: number;
  maxOutputTokens: number;
  providerType?: string | null;
  modelName?: string | null;
  url?: string | null;
  providerAdapterId?: string | null;
}

interface V5StageModels {
  draft_writer: V5StageModel;
  narrative_architect: V5StageModel;
  revision_writer: V5StageModel;
  adversarial_auditor: V5StageModel;
  // Phase 4 §7.2: the compact Standard V5 ledger node is `unified_qa`. Legacy
  // topology continues to populate narrative_architect + adversarial_auditor
  // (both kept) and leaves unified_qa unused.
  unified_qa: V5StageModel;
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

/**
 * DeepSeek V4 writing requests are Thinking Always On. Freeze an explicit
 * enabled value even when an old or manually supplied config says disabled so
 * the post-Freeze Writer Core cannot silently downgrade the writing contract.
 * The provider/parser keep reasoning_content separate from final content;
 * structured-output compatibility must be solved there, not by disabling
 * Thinking at this boundary.
 */
export function freezeContinuationThinking(
  modelName: string | undefined,
  liveThinking?: { type: 'enabled' | 'disabled' },
): { type: 'enabled' | 'disabled' } | undefined {
  if (/^deepseek-v4-(flash|pro)$/i.test(String(modelName || '').trim())) {
    return { type: 'enabled' };
  }
  return liveThinking;
}

export function freezeV5ModelConfig(
  config: LLMRequestConfig | null | undefined,
): FrozenContinuationModelConfig {
  if (!config) {
    throw new ContinuationCapabilityBlockedError('缺少 V5 阶段模型配置。');
  }
  let contextWindow: number;
  let maxOutputTokens: number;
  try {
    contextWindow = requireModelContextWindow(config.context_window);
    maxOutputTokens = requireModelMaxOutputTokens({
      contextWindow,
      configuredMaxOutputTokens: config.max_output_tokens,
    });
  } catch (error) {
    throw new ContinuationCapabilityBlockedError(
      error instanceof Error ? error.message : '模型能力不可用。',
    );
  }
  return {
    configId: modelConfigId(config),
    name: String(config.name || `LLM 配置 #${config.id}`),
    providerType: config.provider_type,
    url: config.url,
    modelName: config.model_name,
    contextWindow,
    maxOutputTokens,
    providerAdapterId: config.provider_adapter_id,
    allowInsecureLanHttp: Boolean(config.allow_insecure_lan_http),
    thinking: freezeContinuationThinking(config.model_name, config.thinking),
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
    const maxOut =
      resolveModelOutputCapability({
        contextWindow: config.context_window,
        configuredMaxOutputTokens: config.max_output_tokens,
      }).maxOutputTokens ?? 0;
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
        providerType: frozen.draftWriter!.providerType,
        modelName: frozen.draftWriter!.modelName,
        url: frozen.draftWriter!.url,
        providerAdapterId: frozen.draftWriter!.providerAdapterId,
      },
      narrative_architect: {
        configId: frozen.narrativeArchitect!.configId,
        contextWindow: frozen.narrativeArchitect!.contextWindow,
        maxOutputTokens: frozen.narrativeArchitect!.maxOutputTokens,
        providerType: frozen.narrativeArchitect!.providerType,
        modelName: frozen.narrativeArchitect!.modelName,
        url: frozen.narrativeArchitect!.url,
        providerAdapterId: frozen.narrativeArchitect!.providerAdapterId,
      },
      revision_writer: {
        configId: frozen.revisionWriter!.configId,
        contextWindow: frozen.revisionWriter!.contextWindow,
        maxOutputTokens: frozen.revisionWriter!.maxOutputTokens,
        providerType: frozen.revisionWriter!.providerType,
        modelName: frozen.revisionWriter!.modelName,
        url: frozen.revisionWriter!.url,
        providerAdapterId: frozen.revisionWriter!.providerAdapterId,
      },
      adversarial_auditor: {
        configId: frozen.adversarialAuditor!.configId,
        contextWindow: frozen.adversarialAuditor!.contextWindow,
        maxOutputTokens: frozen.adversarialAuditor!.maxOutputTokens,
        providerType: frozen.adversarialAuditor!.providerType,
        modelName: frozen.adversarialAuditor!.modelName,
        url: frozen.adversarialAuditor!.url,
        providerAdapterId: frozen.adversarialAuditor!.providerAdapterId,
      },
      // Phase 4 §7.2: the unified_qa node reuses the legacy auditor's model
      // config. The compact driver dispatches round2 through unified_qa only;
      // the legacy narrative_architect / adversarial_auditor paths remain
      // intact for legacy resume.
      unified_qa: {
        configId: frozen.adversarialAuditor!.configId,
        contextWindow: frozen.adversarialAuditor!.contextWindow,
        maxOutputTokens: frozen.adversarialAuditor!.maxOutputTokens,
        providerType: frozen.adversarialAuditor!.providerType,
        modelName: frozen.adversarialAuditor!.modelName,
        url: frozen.adversarialAuditor!.url,
        providerAdapterId: frozen.adversarialAuditor!.providerAdapterId,
      },
      final_reviser: {
        configId: frozen.finalReviser!.configId,
        contextWindow: frozen.finalReviser!.contextWindow,
        maxOutputTokens: frozen.finalReviser!.maxOutputTokens,
        providerType: frozen.finalReviser!.providerType,
        modelName: frozen.finalReviser!.modelName,
        url: frozen.finalReviser!.url,
        providerAdapterId: frozen.finalReviser!.providerAdapterId,
      },
    },
  };
}
