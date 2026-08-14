import { estimateTokens } from '../../utils/tokenEstimator';
import { computeResourceSourceFingerprint, stableJson } from '../context/resources/resourceFingerprint';
import { semanticToRuntimeText } from './semantic';
import type {
  FrozenWriterStyleProjection,
  FrozenWriterStyleV1,
  PresetCompatibilityEnvelopeV1,
  WriterStyleAsset,
  WriterStyleSamplerResolution,
  WriterStyleSemanticV1,
} from './types';
import {
  WRITER_STYLE_COMPILER_VERSION,
  WRITER_STYLE_PROJECTION_COMPILER_VERSION,
} from './types';

function projection(
  stage: FrozenWriterStyleProjection['stage'],
  mode: FrozenWriterStyleProjection['mode'],
  text: string,
): FrozenWriterStyleProjection {
  const protectedText = `【WRITER_STYLE_PROTECTED_V5】\n${text}`;
  return {
    stage,
    mode,
    protected: true,
    text: protectedText,
    estimatedTokens: estimateTokens(protectedText),
    compilerVersion: WRITER_STYLE_PROJECTION_COMPILER_VERSION,
  };
}

export function compileWriterStyleProjections(
  semantic: WriterStyleSemanticV1 | null,
  legacy: { system: string; style: string; extra: string },
): FrozenWriterStyleV1['stageProjections'] {
  const runtime = semantic
    ? semanticToRuntimeText(semantic)
    : {
        systemPrompt: legacy.system,
        writingStyle: legacy.style,
        extraInstructions: legacy.extra,
      };
  const full = [runtime.systemPrompt, runtime.writingStyle, runtime.extraInstructions]
    .filter(Boolean)
    .join('\n\n');
  const evaluation = [
    '将以下作家风格作为审阅标准，不要模仿其文风写审稿：',
    full,
    '检查视角、叙述距离、人物声音、对白、节奏、信息揭示、伏笔和禁止项是否偏离。',
  ]
    .filter(Boolean)
    .join('\n\n');
  const hard = [
    '以下作家风格只提供事实边界与信息揭示约束：',
    semantic?.narration.pointOfView,
    semantic?.narration.narratorDistance,
    semantic?.narrativeMechanics.informationReveal,
    semantic?.narrativeMechanics.continuity,
    semantic?.narrativeMechanics.foreshadowing,
    ...(semantic?.prohibitions || []),
    legacy.system,
    legacy.extra,
  ]
    .filter(Boolean)
    .join('\n');
  const minimal = [
    '本次最终输出必须继续遵守以下硬边界：',
    semantic?.narration.pointOfView,
    semantic?.narrativeMechanics.continuity,
    ...(semantic?.prohibitions || []),
    legacy.extra,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    draft: projection('draft', 'FULL', full),
    review: projection('review', 'EVALUATION', evaluation),
    factCheck: projection('factCheck', 'HARD', hard),
    brief: projection('brief', 'MINIMAL', minimal),
    proof: projection('proof', 'FULL', full),
  };
}

export function resolveWriterStyleSampler(
  asset: Pick<WriterStyleAsset, 'temperature' | 'top_p'>,
  compatibility?: PresetCompatibilityEnvelopeV1 | null,
): WriterStyleSamplerResolution {
  const raw = compatibility?.rawPreset || {};
  const preservedFields = Object.keys(raw).filter(key =>
    /temperature|top_p|top_k|min_p|frequency_penalty|presence_penalty|repetition_penalty|seed|max_tokens|openai_max_tokens/i.test(key),
  );
  const number = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  return {
    temperature: number(raw.temperature) ?? Number(asset.temperature),
    topP: number(raw.top_p) ?? Number(asset.top_p),
    frequencyPenalty: number(raw.frequency_penalty),
    presencePenalty: number(raw.presence_penalty),
    seed: number(raw.seed),
    preservedFields,
    ignoredAtPipeline: ['max_tokens', 'openai_max_tokens', 'openai_max_context'],
  };
}

export function freezeWriterStyle(asset: WriterStyleAsset): FrozenWriterStyleV1 {
  const semantic = asset.semantic_json
    ? (JSON.parse(asset.semantic_json) as WriterStyleSemanticV1)
    : null;
  const compatibility = asset.compatibility_json
    ? (JSON.parse(asset.compatibility_json) as PresetCompatibilityEnvelopeV1)
    : null;
  const legacy = {
    system: String(asset.system_prompt || '').trim(),
    style: String(asset.writing_style || '').trim(),
    extra: String(asset.extra_instructions || '').trim(),
  };
  const stageProjections = compileWriterStyleProjections(semantic, legacy);
  const sourceFingerprint =
    asset.source_fingerprint ||
    computeResourceSourceFingerprint({
      kind: 'writer_style',
      id: asset.id,
      semanticContent: stableJson({ semantic, legacy }),
      compilerVersion: WRITER_STYLE_COMPILER_VERSION,
    });
  return {
    semanticVersion: 1,
    assetId: asset.id,
    assetName: asset.name || '未命名作家风格',
    sourceFormat:
      asset.source_format || (semantic ? 'shinewriter' : 'legacy_shinewriter'),
    semantic,
    legacySystemText: legacy.system,
    legacyWritingStyleText: legacy.style,
    legacyExtraInstructionsText: legacy.extra,
    sourceFingerprint,
    compatibilityFingerprint:
      asset.compatibility_fingerprint || compatibility?.sourceFingerprint,
    samplerResolution: resolveWriterStyleSampler(asset, compatibility),
    stageProjections,
    compatibilitySummary: compatibility
      ? {
          promptCount: Array.isArray(compatibility.rawPreset.prompts)
            ? compatibility.rawPreset.prompts.length
            : 0,
          injectedCount:
            compatibility.promptMappings?.filter(
              item => item.mapping === 'injected_as_writer_style',
            ).length || 0,
          handledByModuleCount:
            compatibility.promptMappings?.filter(
              item => item.mapping === 'handled_by_shinewriter_module',
            ).length || 0,
          preservedCount:
            compatibility.promptMappings?.filter(
              item => item.mapping === 'preserved_not_injected',
            ).length || 0,
          unknownFieldCount: Object.keys(compatibility.rawPreset).filter(
            key => ![
              'prompts',
              'prompt_order',
              'temperature',
              'top_p',
              'frequency_penalty',
              'presence_penalty',
              'seed',
              'openai_max_tokens',
              'max_tokens',
            ].includes(key),
          ).length,
        }
      : undefined,
  };
}

/** Deterministic baseline for a project with no explicit Active Writer Style. */
export function freezeDefaultWriterStyleBaseline(): FrozenWriterStyleV1 {
  return freezeWriterStyle({
    id: 0,
    project_id: 0,
    name: 'Writer Baseline',
    is_default: 1,
    system_prompt: '',
    writing_style: '',
    extra_instructions: '',
    temperature: 0.7,
    top_p: 1,
    max_tokens: 0,
    semantic_json: '',
    compatibility_json: '',
    source_format: 'default_runtime_baseline',
    source_fingerprint: 'writer-baseline-v1',
    compatibility_fingerprint: '',
    asset_contract_version: 2,
  });
}
