import type {
  NovelPresetDraft,
  ShineWriterPresetV1,
} from './targets';
import {
  normalizeWriterStyleSemantic,
  semanticToRuntimeText,
} from '../writerStyle/semantic';
import type { WriterStyleSemanticV1 } from '../writerStyle/types';

/** 与现有 presets 表 / OpenAI 兼容 provider 使用的默认值保持一致。 */
export const PRESET_DEFAULT_VALUES = {
  temperature: 0.8,
  top_p: 0.9,
  max_tokens: 4000,
} as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function requireText(source: Record<string, unknown>, field: string): string {
  const value = asText(source[field]);
  if (!value) throw new Error(`生成的预设缺少必填字段「${field}」。`);
  return value;
}

/**
 * 只读取四个文学语义字段，明确丢弃模型可能擅自返回的 spec、采样和 DB
 * 元数据；这些字段由本地 deterministic Adapter 补齐。
 */
export function parseNovelPresetDraft(value: unknown): NovelPresetDraft {
  const source = asRecord(value);
  const semantic = source.semantic
    ? normalizeWriterStyleSemantic(source.semantic, asText(source.name) || '未命名作家风格')
    : undefined;
  const compiled = semantic ? semanticToRuntimeText(semantic) : null;
  return {
    name: semantic?.name || requireText(source, 'name'),
    system_prompt: compiled?.systemPrompt || requireText(source, 'system_prompt'),
    writing_style: compiled?.writingStyle || requireText(source, 'writing_style'),
    extra_instructions:
      compiled?.extraInstructions || requireText(source, 'extra_instructions'),
    ...(semantic ? { semantic } : {}),
  };
}

export function novelPresetDraftToPreset(
  draft: NovelPresetDraft,
): ShineWriterPresetV1 {
  const normalized = parseNovelPresetDraft(draft);
  return {
    spec: normalized.semantic
      ? 'shinewriter-writer-style-v1'
      : 'shinewriter-preset-v1',
    ...normalized,
    ...PRESET_DEFAULT_VALUES,
  };
}

function finiteNumber(value: unknown, field: string): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`预设字段「${field}」不是有效数字。`);
  }
  return number;
}

/** 读取现有 ShineWriter Preset v1 文件并验证 round-trip 合同。 */
export function parseShineWriterPresetV1(
  value: unknown,
): ShineWriterPresetV1 {
  const source = asRecord(value);
  if (
    source.spec !== 'shinewriter-preset-v1' &&
    source.spec !== 'shinewriter-writer-style-v1'
  ) {
    throw new Error('不是 ShineWriter Preset v1 文件。');
  }
  const preset: ShineWriterPresetV1 = {
    spec:
      source.spec === 'shinewriter-writer-style-v1'
        ? 'shinewriter-writer-style-v1'
        : 'shinewriter-preset-v1',
    name: requireText(source, 'name'),
    system_prompt: requireText(source, 'system_prompt'),
    writing_style: requireText(source, 'writing_style'),
    extra_instructions: requireText(source, 'extra_instructions'),
    temperature: finiteNumber(source.temperature, 'temperature'),
    top_p: finiteNumber(source.top_p, 'top_p'),
    max_tokens: Math.floor(finiteNumber(source.max_tokens, 'max_tokens')),
    ...(source.semantic
      ? { semantic: normalizeSemantic(source.semantic, String(source.name || '')) }
      : {}),
    ...(typeof source.source_format === 'string'
      ? { source_format: source.source_format }
      : {}),
    ...(source.compatibility && typeof source.compatibility === 'object'
      ? { compatibility: source.compatibility as ShineWriterPresetV1['compatibility'] }
      : {}),
  };
  if (preset.temperature < 0 || preset.temperature > 2) {
    throw new Error('预设温度必须在 0 到 2 之间。');
  }
  if (preset.top_p <= 0 || preset.top_p > 1) {
    throw new Error('预设 Top P 必须大于 0 且不超过 1。');
  }
  if (preset.max_tokens <= 0) {
    throw new Error('预设最大输出 Token 必须大于 0。');
  }
  return preset;
}

function normalizeSemantic(value: unknown, fallbackName: string): WriterStyleSemanticV1 {
  return normalizeWriterStyleSemantic(value, fallbackName || '未命名作家风格');
}

export type { NovelPresetDraft, ShineWriterPresetV1 };
