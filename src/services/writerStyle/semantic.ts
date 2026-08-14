import { stableJson } from '../context/resources/resourceFingerprint';
import { sha256Hex } from '../continuation/hashUtils';
import type {
  WriterStyleSemanticV1,
  WriterStyleSourceFormat,
} from './types';
import { WRITER_STYLE_SEMANTIC_VERSION } from './types';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || undefined;
}

function stringArray(value: unknown): string[] | undefined {
  const values = Array.isArray(value)
    ? value
        .map(item => text(item))
        .filter((item): item is string => Boolean(item))
    : text(value)
      ? [text(value)!]
      : [];
  return values.length > 0 ? values : undefined;
}

function section<T extends Record<string, unknown>>(
  source: Record<string, unknown>,
  key: string,
  fields: readonly string[],
): T {
  const input = record(source[key]);
  const output: Record<string, unknown> = {};
  for (const field of fields) {
    const value = text(input[field]);
    if (value) output[field] = value;
  }
  return output as T;
}

export function normalizeWriterStyleSemantic(
  value: unknown,
  fallbackName = '未命名作家风格',
): WriterStyleSemanticV1 {
  const source = record(value);
  return {
    version: WRITER_STYLE_SEMANTIC_VERSION,
    name: text(source.name) || fallbackName,
    ...(text(source.description) ? { description: text(source.description) } : {}),
    applicability: {
      genres: stringArray(record(source.applicability).genres),
      audience: text(record(source.applicability).audience),
      tone: text(record(source.applicability).tone),
    },
    narration: section(source, 'narration', [
      'pointOfView',
      'narratorDistance',
      'viewpointSwitching',
      'interiority',
    ]),
    language: section(source, 'language', [
      'texture',
      'syntax',
      'vocabulary',
      'paragraphStructure',
    ]),
    sceneAndCharacter: section(source, 'sceneAndCharacter', [
      'sceneEnvironment',
      'characterPresentation',
      'characterVoice',
      'dialogue',
    ]),
    narrativeMechanics: section(source, 'narrativeMechanics', [
      'pacing',
      'conflict',
      'informationReveal',
      'suspense',
      'foreshadowing',
      'chapterStructure',
      'continuity',
    ]),
    literaryTexture: section(source, 'literaryTexture', ['imagery', 'sensory']),
    ...(stringArray(source.prohibitions)
      ? { prohibitions: stringArray(source.prohibitions) }
      : {}),
    ...(stringArray(source.extraInstructions)
      ? { extraInstructions: stringArray(source.extraInstructions) }
      : {}),
  };
}

export function parseWriterStyleSemantic(
  value: unknown,
  fallbackName?: string,
): WriterStyleSemanticV1 {
  const semantic = normalizeWriterStyleSemantic(value, fallbackName);
  if (!semantic.name.trim()) throw new Error('作家风格名称不能为空。');
  return semantic;
}

export function semanticToRuntimeText(semantic: WriterStyleSemanticV1): {
  systemPrompt: string;
  writingStyle: string;
  extraInstructions: string;
} {
  const lines = (entries: Array<[string, unknown]>) =>
    entries
      .flatMap(([label, value]) => {
        if (Array.isArray(value)) {
          return value.length ? [`${label}：${value.join('；')}`] : [];
        }
        return text(value) ? [`${label}：${String(value)}`] : [];
      })
      .join('\n');
  const systemPrompt = [
    `你是一位${semantic.applicability.tone || '稳定、克制'}的中文小说作者。`,
    semantic.applicability.audience
      ? `面向${semantic.applicability.audience}读者。`
      : '',
    semantic.narration.pointOfView
      ? `坚持${semantic.narration.pointOfView}的叙述视角。`
      : '',
    semantic.narration.narratorDistance
      ? `叙述距离保持${semantic.narration.narratorDistance}。`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
  const writingStyle = lines([
    ['叙述视角', semantic.narration.pointOfView],
    ['叙述距离', semantic.narration.narratorDistance],
    ['视角切换', semantic.narration.viewpointSwitching],
    ['内心呈现', semantic.narration.interiority],
    ['语言质感', semantic.language.texture],
    ['句法', semantic.language.syntax],
    ['词汇', semantic.language.vocabulary],
    ['段落组织', semantic.language.paragraphStructure],
    ['场景环境', semantic.sceneAndCharacter.sceneEnvironment],
    ['人物呈现', semantic.sceneAndCharacter.characterPresentation],
    ['人物声音', semantic.sceneAndCharacter.characterVoice],
    ['对白', semantic.sceneAndCharacter.dialogue],
    ['节奏', semantic.narrativeMechanics.pacing],
    ['冲突', semantic.narrativeMechanics.conflict],
    ['信息揭示', semantic.narrativeMechanics.informationReveal],
    ['悬念', semantic.narrativeMechanics.suspense],
    ['伏笔', semantic.narrativeMechanics.foreshadowing],
    ['章节结构', semantic.narrativeMechanics.chapterStructure],
    ['连续性', semantic.narrativeMechanics.continuity],
    ['意象', semantic.literaryTexture.imagery],
    ['感官', semantic.literaryTexture.sensory],
  ]);
  const extraInstructions = lines([
    ['禁止项', semantic.prohibitions],
    ['其他要求', semantic.extraInstructions],
  ]);
  return { systemPrompt, writingStyle, extraInstructions };
}

export function semanticFingerprint(
  semantic: WriterStyleSemanticV1 | null,
  legacyText: string,
  sourceFormat: WriterStyleSourceFormat,
): string {
  return sha256Hex(stableJson({ semantic, legacyText, sourceFormat }));
}
