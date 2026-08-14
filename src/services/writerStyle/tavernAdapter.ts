import { computeResourceSourceFingerprint, stableJson } from '../context/resources/resourceFingerprint';
import { normalizeWriterStyleSemantic, semanticToRuntimeText } from './semantic';
import type {
  PresetCompatibilityEnvelopeV1,
  TavernPromptMapping,
  WriterStyleSemanticV1,
} from './types';

const MODULE_IDENTIFIERS = new Set([
  'chardescription',
  'charpersonality',
  'scenario',
  'personality',
  'worldinfobefore',
  'worldinfoafter',
  'chathistory',
  'dialogueexamples',
  'enhancedefinitions',
  'personadescription',
]);

const CHAT_ONLY_IDENTIFIERS = new Set([
  'impersonation',
  'groupnudge',
  'continue',
  'swipe',
  'regenerate',
]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeIdentifier(value: unknown): string {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function promptArray(raw: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(raw.prompts)
    ? raw.prompts.filter(item => item && typeof item === 'object' && !Array.isArray(item)) as Record<string, unknown>[]
    : [];
}

function classifyPrompt(prompt: Record<string, unknown>): TavernPromptMapping {
  const identifier = String(prompt.identifier || '').trim() || undefined;
  const name = String(prompt.name || '').trim() || undefined;
  const key = normalizeIdentifier(identifier || name);
  const position = String(prompt.position || '').toLowerCase();
  const content = String(prompt.content || '');
  const unresolvedMacros = Array.from(content.matchAll(/\{\{[^}]+\}\}/g)).map(
    match => match[0],
  );
  if (key === 'shinewriterwriterstyle' || key.startsWith('shinewriterwriterstyle')) {
    return {
      identifier,
      name,
      mapping: 'injected_as_writer_style',
      reason: 'ShineWriter managed Writer Style prompt',
      unresolvedMacros,
    };
  }
  if (MODULE_IDENTIFIERS.has(key)) {
    return {
      identifier,
      name,
      mapping: 'handled_by_shinewriter_module',
      reason: 'Character / World Info / Chat History belongs to a ShineWriter module',
      unresolvedMacros,
    };
  }
  if (CHAT_ONLY_IDENTIFIERS.has(key) || position === 'in_chat' || prompt.depth != null) {
    return {
      identifier,
      name,
      mapping: 'preserved_not_injected',
      reason: 'Chat-only or in-chat prompt has no novel pipeline mapping',
      unresolvedMacros,
    };
  }
  if (key === 'main' || key === 'nsfw' || key === 'jailbreak') {
    return {
      identifier,
      name,
      mapping: 'preserved_not_injected',
      reason: 'SillyTavern chat protocol prompt is preserved but not a root ShineWriter system prompt',
      unresolvedMacros,
    };
  }
  if (content.trim()) {
    return {
      identifier,
      name,
      mapping: 'injected_as_writer_style',
      reason: 'Custom relative prompt treated as a Writer Style candidate',
      unresolvedMacros,
    };
  }
  return {
    identifier,
    name,
    mapping: 'unsupported',
    reason: 'Prompt has no safely mappable novel writing content',
    unresolvedMacros,
  };
}

export function isSillyTavernOpenAIPreset(value: unknown): boolean {
  const raw = record(value);
  if (raw.type && raw.type !== 'openai_preset') return false;
  return Array.isArray(raw.prompts) && Array.isArray(raw.prompt_order);
}

export function parseSillyTavernOpenAIPreset(
  value: unknown,
  sourceName = 'preset.json',
): {
  envelope: PresetCompatibilityEnvelopeV1;
  semantic: WriterStyleSemanticV1;
  legacy: ReturnType<typeof semanticToRuntimeText>;
} {
  const raw = record(value);
  if (!isSillyTavernOpenAIPreset(raw)) {
    throw new Error('TAVERN_PRESET_UNSUPPORTED：当前仅支持 SillyTavern Chat Completion Preset / openai_preset。');
  }
  const promptMappings = promptArray(raw).map(classifyPrompt);
  const candidates = promptArray(raw)
    .filter((_, index) => promptMappings[index]?.mapping === 'injected_as_writer_style')
    .map(prompt => String(prompt.content || '').trim())
    .filter(Boolean);
  const name = String(raw.name || sourceName.replace(/\.json$/i, '') || 'SillyTavern 作家风格');
  const semantic = normalizeWriterStyleSemantic(
    {
      name,
      description: '从 SillyTavern openai_preset 导入；原始协议保存在兼容层。',
      language: { texture: candidates.join('\n\n') },
    },
    name,
  );
  const legacy = semanticToRuntimeText(semantic);
  const sourceFingerprint = computeResourceSourceFingerprint({
    kind: 'sillytavern_openai',
    id: sourceName,
    semanticContent: stableJson(raw),
    compilerVersion: 'tavern-openai-v1',
  });
  return {
    envelope: {
      version: 1,
      format: 'sillytavern_openai_preset',
      importedAt: Date.now(),
      sourceName,
      rawPreset: raw,
      sourceFingerprint,
      promptMappings,
      compatibilityNotes: promptMappings
        .filter(item => item.mapping !== 'injected_as_writer_style')
        .map(item => `${item.name || item.identifier || 'unknown'}: ${item.reason}`),
      semanticDirty: false,
    },
    semantic,
    legacy,
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function patchManagedWriterStylePrompt(
  envelope: PresetCompatibilityEnvelopeV1,
  semantic: WriterStyleSemanticV1,
): PresetCompatibilityEnvelopeV1 {
  const next = clone(envelope);
  const raw = next.rawPreset;
  const prompts = promptArray(raw);
  let identifier = next.managedPromptIdentifier || 'shinewriterWriterStyle';
  let target = prompts.find(prompt => prompt.identifier === identifier);
  if (!target) {
    let suffix = 1;
    while (prompts.some(prompt => prompt.identifier === identifier)) {
      suffix += 1;
      identifier = `shinewriterWriterStyle${suffix}`;
    }
    target = {
      identifier,
      name: 'ShineWriter Writer Style',
      role: 'system',
      position: 'relative',
      enabled: true,
      content: '',
    };
    prompts.push(target);
    raw.prompts = prompts;
    const groups = Array.isArray(raw.prompt_order) ? raw.prompt_order : [];
    for (const group of groups as unknown[]) {
      const groupRecord = record(group);
      const order = Array.isArray(groupRecord.order) ? groupRecord.order : [];
      order.push({ identifier, enabled: true });
      groupRecord.order = order;
    }
    raw.prompt_order = groups;
  }
  target.content = [semanticToRuntimeText(semantic).systemPrompt, semanticToRuntimeText(semantic).writingStyle, semanticToRuntimeText(semantic).extraInstructions]
    .filter(Boolean)
    .join('\n\n');
  target.role = target.role || 'system';
  next.managedPromptIdentifier = identifier;
  next.semanticDirty = true;
  next.promptMappings = promptArray(raw).map(classifyPrompt);
  return next;
}

export function exportSillyTavernOpenAIPreset(
  envelope: PresetCompatibilityEnvelopeV1,
  semantic?: WriterStyleSemanticV1,
): Record<string, unknown> {
  if (!semantic || envelope.semanticDirty !== true) return clone(envelope.rawPreset);
  return patchManagedWriterStylePrompt(envelope, semantic).rawPreset;
}

export const TAVERN_OPENAI_BASELINE_V1: Record<string, unknown> = {
  chat_completion_source: 'openai',
  temperature: 0.8,
  top_p: 0.9,
  frequency_penalty: 0,
  presence_penalty: 0,
  openai_max_tokens: 300,
  prompts: [],
  prompt_order: [],
};

export function exportNewWriterStyleAsTavern(
  semantic: WriterStyleSemanticV1,
): Record<string, unknown> {
  const raw = clone(TAVERN_OPENAI_BASELINE_V1);
  const runtime = semanticToRuntimeText(semantic);
  raw.prompts = [
    {
      name: 'ShineWriter Writer Style',
      identifier: 'shinewriterWriterStyle',
      system_prompt: true,
      role: 'system',
      position: 'relative',
      enabled: true,
      content: [runtime.systemPrompt, runtime.writingStyle, runtime.extraInstructions]
        .filter(Boolean)
        .join('\n\n'),
    },
  ];
  raw.prompt_order = [
    {
      character_id: 100000,
      order: [{ identifier: 'shinewriterWriterStyle', enabled: true }],
    },
  ];
  return raw;
}
