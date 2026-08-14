import type { Preset } from '../../../types/novel';
import { estimateTokens } from '../../../utils/tokenEstimator';
import { computeResourceSourceFingerprint } from './resourceFingerprint';
import { ResourceContextError } from './resourceContextErrors';
import type {
  FrozenPresetContext,
  FrozenSourceRecord,
  PipelineResourceStage,
  PresetSourceKind,
} from './resourceAwarenessTypes';

export const DEFAULT_RUNTIME_PRESET_NAME = 'ShineWriter 默认小说基线';

export const DEFAULT_RUNTIME_SYSTEM_PROMPT =
  '你是一位经验丰富的中文小说作者。请根据既有设定、人物状态、章节概要和前文内容，继续创作自然、连贯、有画面感的中文小说。';

export const PRESET_CONTEXT_COMPILER_VERSION = 'preset-context-v1';

export interface BuildFrozenPresetInput {
  /** Explicit pipeline binding. Null/undefined = no explicit selection. */
  requestedPresetId?: number | null;
  /** Loaded preset row matching requestedPresetId, if any. */
  preset?: Preset | null;
  /** All project presets, used only to detect a failed explicit lookup. */
  availablePresets?: Array<Pick<Preset, 'id' | 'name'>>;
}

function parseFrozenPresetSource(source: FrozenSourceRecord): Preset {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.payload);
  } catch (error) {
    throw new ResourceContextError(
      'PRESET_SOURCE_READ_FAILED',
      '冻结作家风格 payload 不是有效 JSON，已阻止生成。请重新选择作家风格。',
      'open_resources',
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ResourceContextError(
      'PRESET_SOURCE_READ_FAILED',
      '冻结作家风格 payload 结构无效，已阻止生成。请重新选择作家风格。',
      'open_resources',
    );
  }
  const raw = parsed as Record<string, unknown>;
  const id = Number(raw.id ?? source.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new ResourceContextError(
      'PRESET_SOURCE_READ_FAILED',
      '冻结作家风格缺少有效 id，已阻止生成。请重新选择作家风格。',
      'open_resources',
    );
  }
  return {
    id,
    project_id: Number(raw.project_id) || 0,
    name: String(raw.name || ''),
    is_default: Number(raw.is_default) || 0,
    system_prompt: String(raw.system_prompt || ''),
    writing_style: String(raw.writing_style || ''),
    temperature: Number(raw.temperature) || 0,
    top_p: Number(raw.top_p) || 0,
    max_tokens: Number(raw.max_tokens) || 0,
    extra_instructions: String(raw.extra_instructions || ''),
    ...(raw.enabled_for_project != null
      ? { enabled_for_project: Number(raw.enabled_for_project) || 0 }
      : {}),
  };
}

export function buildFrozenPresetContext(
  input: BuildFrozenPresetInput,
): FrozenPresetContext {
  const requested =
    input.requestedPresetId == null || input.requestedPresetId === undefined
      ? null
      : Number(input.requestedPresetId);

  if (requested != null && Number.isInteger(requested) && requested > 0) {
    if (!input.preset || Number(input.preset.id) !== requested) {
      const known = (input.availablePresets || []).some(
        item => Number(item.id) === requested,
      );
      throw new ResourceContextError(
        'PRESET_SOURCE_READ_FAILED',
        known
          ? `已选择的作家风格 #${requested} 读取失败，已阻止生成，以免静默换成默认文风。`
          : `已选择的作家风格 #${requested} 不存在或已损坏，已阻止生成，以免静默换成默认文风。`,
        'open_resources',
        { requestedPresetId: requested },
      );
    }
    return compileUserPreset(input.preset, requested);
  }

  if (input.preset && Number(input.preset.id) > 0) {
    return compileUserPreset(input.preset, Number(input.preset.id));
  }

  return compileDefaultBaseline();
}

/**
 * Compile the preset from the ResourceSourceSnapshot payload. V7 uses this
 * after capture so the preset fingerprint and injected text share the same
 * frozen source as the other phase-2 resources.
 */
export function buildFrozenPresetContextFromSource(
  source: FrozenSourceRecord | undefined,
  options: { requestedPresetId?: number | null } = {},
): FrozenPresetContext {
  if (!source) {
    return buildFrozenPresetContext({
      requestedPresetId: options.requestedPresetId,
      preset: null,
    });
  }
  if (source.kind !== 'preset') {
    throw new ResourceContextError(
      'PRESET_SOURCE_READ_FAILED',
      '冻结资源不是有效作家风格，已阻止生成。请重新选择作家风格。',
      'open_resources',
      { sourceKind: source.kind },
    );
  }
  const preset = parseFrozenPresetSource(source);
  const frozen = buildFrozenPresetContext({
    requestedPresetId:
      options.requestedPresetId == null
        ? Number(source.id)
        : options.requestedPresetId,
    preset,
  });
  if (frozen.sourceFingerprint !== source.fingerprint) {
    throw new ResourceContextError(
      'RESOURCE_SOURCE_CHANGED_DURING_BUILD',
      '构建上下文时作家风格冻结指纹与正文不一致，已阻止把两个版本拼进同一次冻结。请稍后重试。',
      'restart_task',
      {
        sourceFingerprint: source.fingerprint,
        compiledFingerprint: frozen.sourceFingerprint,
      },
    );
  }
  return frozen;
}

function compileUserPreset(
  preset: Preset,
  requestedPresetId: number,
): FrozenPresetContext {
  const systemText = String(preset.system_prompt || '').trim();
  const writingStyleText = String(preset.writing_style || '').trim();
  const extraInstructionsText = String(preset.extra_instructions || '').trim();
  const combinedText = [
    systemText || DEFAULT_RUNTIME_SYSTEM_PROMPT,
    writingStyleText && `写作风格：${writingStyleText}`,
    extraInstructionsText && `附加要求：${extraInstructionsText}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  return {
    presetId: Number(preset.id),
    presetName: preset.name || '未命名作家风格',
    sourceFingerprint: computeResourceSourceFingerprint({
      kind: 'preset',
      id: Number(preset.id),
      semanticContent: [systemText, writingStyleText, extraInstructionsText].join(
        '\n',
      ),
      compilerVersion: PRESET_CONTEXT_COMPILER_VERSION,
    }),
    presetSource: 'user_selected' as PresetSourceKind,
    systemText: systemText || DEFAULT_RUNTIME_SYSTEM_PROMPT,
    writingStyleText,
    extraInstructionsText,
    combinedText,
    requestedPresetId,
  };
}

function compileDefaultBaseline(): FrozenPresetContext {
  return {
    presetName: DEFAULT_RUNTIME_PRESET_NAME,
    sourceFingerprint: computeResourceSourceFingerprint({
      kind: 'preset',
      id: 'default_runtime_baseline',
      semanticContent: DEFAULT_RUNTIME_SYSTEM_PROMPT,
      compilerVersion: PRESET_CONTEXT_COMPILER_VERSION,
    }),
    presetSource: 'default_runtime_baseline',
    systemText: DEFAULT_RUNTIME_SYSTEM_PROMPT,
    writingStyleText: '',
    extraInstructionsText: '',
    combinedText: DEFAULT_RUNTIME_SYSTEM_PROMPT,
    requestedPresetId: null,
  };
}

export function renderPresetForStage(
  frozen: FrozenPresetContext,
  stage: PipelineResourceStage,
): {
  systemText: string;
  writingStyleText: string;
  extraInstructionsText: string;
  combinedText: string;
  policy: string;
} {
  if (stage === 'draft' || stage === 'proof') {
    return {
      systemText: frozen.systemText,
      writingStyleText: frozen.writingStyleText,
      extraInstructionsText: frozen.extraInstructionsText,
      combinedText: frozen.combinedText,
      policy: 'full',
    };
  }
  if (stage === 'review') {
    const combined = [
      frozen.systemText && `【预设规则｜评判目标，不是已发生事实】\n${frozen.systemText}`,
      frozen.writingStyleText &&
        `【预设文风｜只用于判断是否偏离，不要模仿该文风写审稿】\n${frozen.writingStyleText}`,
      frozen.extraInstructionsText &&
        `【预设附加约束】\n${frozen.extraInstructionsText}`,
    ]
      .filter(Boolean)
      .join('\n\n');
    return {
      systemText: frozen.systemText,
      writingStyleText: frozen.writingStyleText,
      extraInstructionsText: frozen.extraInstructionsText,
      combinedText: combined,
      policy: 'evaluation_target',
    };
  }
  if (stage === 'factCheck') {
    const hard = [frozen.systemText, frozen.extraInstructionsText]
      .filter(Boolean)
      .join('\n\n');
    const styleRef = frozen.writingStyleText
      ? `【文风参考｜事实判断不受审美偏好影响】\n${frozen.writingStyleText}`
      : '';
    return {
      systemText: frozen.systemText,
      writingStyleText: styleRef,
      extraInstructionsText: frozen.extraInstructionsText,
      combinedText: [hard, styleRef].filter(Boolean).join('\n\n'),
      policy: 'hard_constraints',
    };
  }
  const hard = [frozen.systemText, frozen.extraInstructionsText]
    .filter(Boolean)
    .join('\n\n');
  return {
    systemText: frozen.systemText,
    writingStyleText: '',
    extraInstructionsText: frozen.extraInstructionsText,
    combinedText: hard,
    policy: 'minimal_hard',
  };
}

export function estimatePresetTokens(frozen: FrozenPresetContext): number {
  return estimateTokens(frozen.combinedText);
}
