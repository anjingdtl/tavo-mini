import { estimateTokens } from '../../../utils/tokenEstimator';
import {
  readNovelCharacterDraft,
  unwrapCharacterDraftSource,
} from '../../construction/characterDraftAdapter';
import type { NovelCharacterDraft } from '../../construction/targets';
import { computeResourceSourceFingerprint, stableJson } from './resourceFingerprint';
import {
  CHARACTER_AWARENESS_COMPILER_VERSION,
  type ResourceAwarenessCapsule,
  type ResourceConstraintClass,
} from './resourceAwarenessTypes';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value.map(asString).filter(Boolean).join('；');
  }
  return String(value).trim();
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asString).filter(Boolean);
  const text = asString(value);
  return text
    ? text
        .split(/[\n、；;，,]/)
        .map(item => item.trim())
        .filter(Boolean)
    : [];
}

export function parseCharacterSourcePayload(raw: unknown): {
  name: string;
  dataJson: string;
  updatedAt?: string | number;
  id: number;
} {
  const record = asRecord(raw);
  const id = Number(record.id) || 0;
  const name = asString(record.name);
  const dataJson =
    typeof record.data_json === 'string'
      ? record.data_json
      : typeof record.dataJson === 'string'
        ? record.dataJson
        : stableJson(record.data ?? record);
  return {
    id,
    name,
    dataJson,
    updatedAt: (record.updated_at ?? record.updatedAt) as string | number | undefined,
  };
}

export function characterSemanticSource(dataJson: string, name: string): string {
  return `${name}\n${dataJson}`;
}

function pushLine(lines: string[], line: string | undefined): void {
  const text = asString(line);
  if (text) lines.push(text);
}

function knowledgeBoundaryLines(draft: NovelCharacterDraft): string[] {
  const lines: string[] = [];
  const secrets = asString(draft.secrets);
  if (secrets) lines.push(`知识边界/秘密：${secrets}`);
  for (const fact of asStringArray(draft.continuity)) {
    if (/不知|不知道|未告知|隐瞒|误以为|以为|读者|pov|视角/i.test(fact)) {
      lines.push(`连续性约束：${fact}`);
    }
  }
  return lines;
}

function compileNovelSkeleton(draft: NovelCharacterDraft): {
  text: string;
  constraintClasses: ResourceConstraintClass[];
} {
  const classes = new Set<ResourceConstraintClass>(['identity']);
  const head: string[] = [];
  const identityBits = [draft.name];
  if (draft.role) identityBits.push(asString(draft.role));
  if (draft.identity) identityBits.push(asString(draft.identity));
  head.push(identityBits.filter(Boolean).join('；'));

  const relationships = asStringArray(draft.relationships);
  if (relationships.length > 0) {
    classes.add('relationship');
    head.push(`关系：${relationships.join('；')}`);
  }

  const bounds = knowledgeBoundaryLines(draft);
  if (bounds.length > 0) {
    classes.add('knowledge_boundary');
    head.push(...bounds);
  }

  if (draft.motivation) {
    classes.add('persistent_fact');
    head.push(`长期目标：${asString(draft.motivation)}`);
  }
  if (draft.conflict) {
    classes.add('persistent_fact');
    head.push(`长期冲突：${asString(draft.conflict)}`);
  }
  if (draft.personality) {
    classes.add('identity');
    head.push(`核心人格：${asString(draft.personality)}`);
  }
  if (draft.limitations) {
    classes.add('world_rule');
    head.push(`不可轻易变化的约束：${asString(draft.limitations)}`);
  }

  return {
    text: `【角色全局骨架】\n${head.filter(Boolean).join('\n')}`,
    constraintClasses: Array.from(classes),
  };
}

function compileLegacySkeleton(card: Record<string, unknown>, name: string): {
  text: string;
  constraintClasses: ResourceConstraintClass[];
} {
  const lines: string[] = [`${name}`];
  pushLine(lines, asString(card.description) && `描述：${asString(card.description)}`);
  pushLine(lines, asString(card.personality) && `性格：${asString(card.personality)}`);
  pushLine(lines, asString(card.scenario) && `情境基线：${asString(card.scenario)}`);
  return {
    text: `【角色全局骨架｜legacy】\n${lines.join('\n')}`,
    constraintClasses: ['identity', 'reference_fact'],
  };
}

/**
 * Deterministic Character Global Awareness compiler.
 * Prefers shinewriter_novel_character_v1. Legacy CCv3 chat fields never
 * become system-level instructions.
 */
export function compileCharacterAwareness(rawSource: unknown): ResourceAwarenessCapsule {
  const parsed = parseCharacterSourcePayload(rawSource);
  if (!parsed.id) {
    throw new Error('角色资料缺少稳定 id，无法编译全局骨架。');
  }
  let data: Record<string, unknown> = {};
  try {
    data = unwrapCharacterDraftSource(JSON.parse(parsed.dataJson || '{}'));
  } catch {
    data = unwrapCharacterDraftSource(parsed.dataJson);
  }
  const name = parsed.name || asString(data.name) || '未命名角色';
  const novel = readNovelCharacterDraft(data);
  const fingerprint = computeResourceSourceFingerprint({
    kind: 'character',
    id: parsed.id,
    semanticContent: characterSemanticSource(parsed.dataJson, name),
    compilerVersion: CHARACTER_AWARENESS_COMPILER_VERSION,
  });

  if (novel) {
    const compiled = compileNovelSkeleton(novel);
    return {
      sourceKind: 'character',
      sourceId: parsed.id,
      sourceUpdatedAt: parsed.updatedAt,
      sourceFingerprint: fingerprint,
      compilerVersion: CHARACTER_AWARENESS_COMPILER_VERSION,
      title: novel.name || name,
      awarenessText: compiled.text,
      estimatedTokens: estimateTokens(compiled.text),
      constraintClasses: compiled.constraintClasses,
      fallbackMode: 'structured',
    };
  }

  const compiled = compileLegacySkeleton(data, name);
  return {
    sourceKind: 'character',
    sourceId: parsed.id,
    sourceUpdatedAt: parsed.updatedAt,
    sourceFingerprint: fingerprint,
    compilerVersion: CHARACTER_AWARENESS_COMPILER_VERSION,
    title: name,
    awarenessText: compiled.text,
    estimatedTokens: estimateTokens(compiled.text),
    constraintClasses: compiled.constraintClasses,
    fallbackMode: 'full_source_protected',
    legacyCharacterFallback: true,
  };
}

export function listCharacterRelationshipHints(rawSource: unknown): string[] {
  const parsed = parseCharacterSourcePayload(rawSource);
  let data: Record<string, unknown> = {};
  try {
    data = unwrapCharacterDraftSource(JSON.parse(parsed.dataJson || '{}'));
  } catch {
    data = {};
  }
  const novel = readNovelCharacterDraft(data);
  if (novel) return asStringArray(novel.relationships);
  return [];
}

export function listCharacterNames(rawSource: unknown): string[] {
  const parsed = parseCharacterSourcePayload(rawSource);
  let data: Record<string, unknown> = {};
  try {
    data = unwrapCharacterDraftSource(JSON.parse(parsed.dataJson || '{}'));
  } catch {
    data = {};
  }
  const novel = readNovelCharacterDraft(data);
  const names = [parsed.name || asString(data.name)];
  if (novel) names.push(...asStringArray(novel.aliases));
  return names.map(asString).filter(Boolean);
}
