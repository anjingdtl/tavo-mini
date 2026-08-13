import { estimateTokens } from '../../../utils/tokenEstimator';
import { computeResourceSourceFingerprint } from './resourceFingerprint';
import {
  WORLDBOOK_AWARENESS_COMPILER_VERSION,
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
  return String(value).trim();
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asString).filter(Boolean);
  const text = asString(value);
  return text
    ? text
        .split(/[,，\n、；;]/)
        .map(item => item.trim())
        .filter(Boolean)
    : [];
}

export function parseWorldbookSourcePayload(raw: unknown): {
  id: number;
  title: string;
  category?: string;
  keywords: string[];
  content: string;
  constant: boolean;
  updatedAt?: string | number;
  awarenessHint?: string;
  hintContentFingerprint?: string;
} {
  const record = asRecord(raw);
  const keywords = asStringArray(
    record.keywords ??
      record.keyword_primary ??
      record.key ??
      record.keys ??
      record.keyword,
  );
  const secondary = asStringArray(
    record.keyword_secondary ?? record.secondary_keys ?? record.keysecondary,
  );
  const title =
    asString(record.title) ||
    asString(record.comment) ||
    keywords[0] ||
    `条目#${record.id ?? ''}`;
  const hint = asString(
    record.awareness_hint ??
      asRecord(record.extensions).awareness_hint ??
      asRecord(asRecord(record.extensions).shinewriter_context_awareness_v1)
        .awareness_hint,
  );
  return {
    id: Number(record.id) || 0,
    title,
    category: asString(record.category) || undefined,
    keywords: [...keywords, ...secondary],
    content: asString(record.content),
    constant: record.constant === 1 || record.constant === true,
    updatedAt: (record.updated_at ?? record.updatedAt) as string | number | undefined,
    awarenessHint: hint || undefined,
    hintContentFingerprint: asString(
      record.hint_content_fingerprint ??
        asRecord(asRecord(record.extensions).shinewriter_context_awareness_v1)
          .sourceFingerprint,
    ),
  };
}

export function worldbookSemanticSource(entry: {
  title: string;
  category?: string;
  keywords: string[];
  content: string;
  constant: boolean;
}): string {
  return [
    entry.title,
    entry.category || '',
    entry.keywords.join(','),
    entry.constant ? '1' : '0',
    entry.content,
  ].join('\n');
}

function inferConstraintClasses(entry: {
  title: string;
  category?: string;
  content: string;
}): ResourceConstraintClass[] {
  const haystack = `${entry.title}\n${entry.category || ''}\n${entry.content}`;
  const classes = new Set<ResourceConstraintClass>(['persistent_fact']);
  if (/规则|禁忌|不能|不得|禁止|无法真正|不可复活|硬性/.test(haystack)) {
    classes.add('world_rule');
  }
  if (/不知道|不知情|对外保密|公众不知|隐瞒/.test(haystack)) {
    classes.add('knowledge_boundary');
  }
  if (/目前|当前|封锁|解除|暂时|已经/.test(haystack)) {
    classes.add('mutable_baseline');
  }
  return Array.from(classes);
}

/**
 * P0 worldbook awareness: no reliable independent summary field exists, so
 * the full source is protected. An awareness_hint is used only when it still
 * matches the current content fingerprint.
 */
export function compileWorldbookAwareness(rawSource: unknown): ResourceAwarenessCapsule {
  const entry = parseWorldbookSourcePayload(rawSource);
  if (!entry.id) {
    throw new Error('世界书条目缺少稳定 id，无法编译全局约束。');
  }
  const semantic = worldbookSemanticSource(entry);
  const fingerprint = computeResourceSourceFingerprint({
    kind: 'worldbook',
    id: entry.id,
    semanticContent: semantic,
    compilerVersion: WORLDBOOK_AWARENESS_COMPILER_VERSION,
  });

  const hintValid =
    !!entry.awarenessHint &&
    (!entry.hintContentFingerprint ||
      entry.hintContentFingerprint === fingerprint);

  let awarenessText: string;
  let fallbackMode: ResourceAwarenessCapsule['fallbackMode'];
  if (hintValid) {
    const bits = [
      entry.title,
      entry.category ? `分类：${entry.category}` : '',
      entry.awarenessHint,
    ].filter(Boolean);
    awarenessText = `【世界全局约束】\n${bits.join('；')}`;
    fallbackMode = 'cached_summary';
  } else {
    const bits = [
      `【${entry.title}】`,
      entry.category ? `分类：${entry.category}` : '',
      entry.content,
    ].filter(Boolean);
    awarenessText = `【世界全局约束】\n${bits.join('\n')}`;
    fallbackMode = 'full_source_protected';
  }

  return {
    sourceKind: 'worldbook',
    sourceId: entry.id,
    sourceUpdatedAt: entry.updatedAt,
    sourceFingerprint: fingerprint,
    compilerVersion: WORLDBOOK_AWARENESS_COMPILER_VERSION,
    title: entry.title,
    awarenessText,
    estimatedTokens: estimateTokens(awarenessText),
    constraintClasses: inferConstraintClasses(entry),
    fallbackMode,
  };
}

export function isWorldbookConstant(rawSource: unknown): boolean {
  return parseWorldbookSourcePayload(rawSource).constant;
}

export function listWorldbookKeywords(rawSource: unknown): string[] {
  return parseWorldbookSourcePayload(rawSource).keywords;
}
