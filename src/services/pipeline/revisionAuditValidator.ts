/**
 * Outline pipeline V5-Lite — Review V2 / FactCheck V2 parser & validator.
 *
 * Keeps the ~900-line legacy `pipelineAuditValidator.ts` untouched (V1 path).
 * V2 contract validation rules (§9):
 *   1. top-level field whitelist;
 *   2. schemaVersion === 2;
 *   3. draftHash exactly matches the client hash of the canonical draft;
 *   4. correction scope ↔ locator fields match;
 *   5. every referenced anchor exists;
 *   6. required/hard corrections have non-empty diagnosis + rewriteGoal;
 *   7. arrays and single items are size-bounded;
 *   8. no full-draft echo;
 *   9. no novel body / prompt / reasoning leakage;
 *  10. normalized JSON field order is stable (resume + fingerprint safe).
 *
 * Review V2 uses a strict fast path followed by deterministic local
 * normalization. FactCheck V2 remains strict and keeps its existing repair
 * policy in the reconciler.
 */
import type { LLMResult } from '../llm/types';
import type {
  AuditValidationFailureReason,
  AuditValidationResult,
} from '../../types/pipelineAudit';
import type {
  PipelineAuditCorrectionV2,
  PipelineFactCheckReportV2,
  PipelineRevisionAnchor,
  PipelineReviewReportV2,
} from '../../types/pipelineRevision';
import type {
  NormalizedCorrectionV3,
  NormalizedFactCheckV3,
  NormalizedReviewV3,
} from './briefCompilerTypes';
import { detectDraftEcho, extractAuditJsonPayload } from '../pipelineAuditValidator';

/** Upper bounds for V2 arrays / items (§9.7). */
export const REVISION_V2_LIMITS = {
  /** Max corrections in one report. */
  MAX_CORRECTIONS: 60,
  /** Max protected anchors / facts / constraints. */
  MAX_PROTECTED_ITEMS: 200,
  /** Max preserveMeaning entries per correction. */
  MAX_PRESERVE_MEANING_ITEMS: 40,
  /** Max chars for one preserveMeaning entry. */
  MAX_PRESERVE_MEANING_CHARS: 200,
  /** Max chars for diagnosis / rewriteGoal. */
  MAX_CORRECTION_TEXT_CHARS: 800,
  /** Max chars for the whole normalized report. */
  MAX_REPORT_CHARS: 20000,
  /** Max outlineExecution beat strings. */
  MAX_BEAT_ITEMS: 60,
  /** Anchor markers must not leak into report strings. */
  ANCHOR_MARKER_RE: /\[draft-p-\d{3}/,
  /** Prompt leakage fingerprints (system identity lines). */
  PROMPT_LEAK_FINGERPRINTS: ['你是终审校对员', '【不可违背的项目约束】', '【初稿】'],
} as const;

const REVIEW_V2_TOP_LEVEL_KEYS = new Set([
  'schemaVersion',
  'draftHash',
  'requiredCorrections',
  'protectedAnchorIds',
  'outlineExecution',
]);

const FACTCHECK_V2_TOP_LEVEL_KEYS = new Set([
  'schemaVersion',
  'draftHash',
  'requiredCorrections',
  'protectedFacts',
  'hardConstraints',
]);

const CORRECTION_ALLOWED_KEYS = new Set([
  'id',
  'scope',
  'anchorId',
  'anchorIds',
  'insertionBeforeAnchorId',
  'insertionAfterAnchorId',
  'boundary',
  'dimension',
  'severity',
  'diagnosis',
  'rewriteGoal',
  'preserveMeaning',
]);

const SCOPES = new Set(['anchor', 'range', 'insertion', 'chapter', 'boundary']);
const SEVERITIES = new Set(['required', 'hard', 'warning']);

function failV2<T>(
  reason: AuditValidationFailureReason,
  details?: string,
): AuditValidationResult<T> {
  return { valid: false, reason, details };
}

/** Collect every non-empty string leaf (echo / leak scanning). */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    const t = value.trim();
    if (t) out.push(t);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, out);
    return;
  }
  if (value != null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) {
      collectStrings(child, out);
    }
  }
}

function checkTopLevelWhitelist(
  obj: Record<string, unknown>,
  allowed: Set<string>,
): string | null {
  const extra = Object.keys(obj).filter(k => !allowed.has(k));
  if (extra.length === 0) return null;
  return `不允许的顶层字段: ${extra.join(', ')}`;
}

function checkAnchorMarkerLeak(strings: string[]): string | null {
  for (const s of strings) {
    if (REVISION_V2_LIMITS.ANCHOR_MARKER_RE.test(s)) {
      return `字符串含锚点标记，疑似泄漏定位信息: ${s.slice(0, 60)}`;
    }
  }
  return null;
}

function checkPromptLeak(strings: string[]): string | null {
  for (const s of strings) {
    for (const fp of REVISION_V2_LIMITS.PROMPT_LEAK_FINGERPRINTS) {
      if (s.includes(fp)) {
        return `字符串疑似泄漏提示词片段: ${fp}`;
      }
    }
  }
  return null;
}

/**
 * Validate one correction against the anchor set.
 * Returns null on success or a Chinese failure detail.
 */
function validateCorrection(
  value: unknown,
  anchors: PipelineRevisionAnchor[],
  index: number,
): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return `requiredCorrections[${index}] 必须是对象`;
  }
  const c = value as Record<string, unknown>;
  const extra = Object.keys(c).filter(k => !CORRECTION_ALLOWED_KEYS.has(k));
  if (extra.length > 0) {
    return `requiredCorrections[${index}] 含未知字段: ${extra.join(', ')}`;
  }
  const scope = c.scope;
  if (typeof scope !== 'string' || !SCOPES.has(scope)) {
    return `requiredCorrections[${index}].scope 非法: ${String(scope)}`;
  }
  const severity = c.severity;
  if (typeof severity !== 'string' || !SEVERITIES.has(severity)) {
    return `requiredCorrections[${index}].severity 非法: ${String(severity)}`;
  }
  if (typeof c.id !== 'string' || !c.id.trim()) {
    return `requiredCorrections[${index}].id 缺失`;
  }
  if (typeof c.dimension !== 'string' || !c.dimension.trim()) {
    return `requiredCorrections[${index}].dimension 缺失`;
  }
  const diagnosis = typeof c.diagnosis === 'string' ? c.diagnosis.trim() : '';
  const rewriteGoal =
    typeof c.rewriteGoal === 'string' ? c.rewriteGoal.trim() : '';
  if (severity !== 'warning') {
    if (!diagnosis) {
      return `requiredCorrections[${index}] (${severity}) 缺少 diagnosis`;
    }
    if (!rewriteGoal) {
      return `requiredCorrections[${index}] (${severity}) 缺少 rewriteGoal`;
    }
  } else if (!diagnosis && !rewriteGoal) {
    return `requiredCorrections[${index}] (warning) 缺少描述`;
  }
  if (diagnosis.length > REVISION_V2_LIMITS.MAX_CORRECTION_TEXT_CHARS) {
    return `requiredCorrections[${index}].diagnosis 过长`;
  }
  if (rewriteGoal.length > REVISION_V2_LIMITS.MAX_CORRECTION_TEXT_CHARS) {
    return `requiredCorrections[${index}].rewriteGoal 过长`;
  }

  const anchorExists = (id: unknown): boolean => {
    if (typeof id !== 'string' || !id.trim()) return false;
    return anchors.some(a => a.id === id);
  };

  // Scope ↔ locator match (§6 table).
  switch (scope) {
    case 'anchor':
      if (!anchorExists(c.anchorId)) {
        return `requiredCorrections[${index}] scope=anchor 需要存在的 anchorId`;
      }
      break;
    case 'range': {
      if (!Array.isArray(c.anchorIds) || c.anchorIds.length < 2) {
        return `requiredCorrections[${index}] scope=range 需要至少两个 anchorIds`;
      }
      for (const id of c.anchorIds) {
        if (!anchorExists(id)) {
          return `requiredCorrections[${index}] scope=range 引用了不存在的 anchor: ${String(id)}`;
        }
      }
      break;
    }
    case 'insertion': {
      const beforeOk = anchorExists(c.insertionBeforeAnchorId);
      const afterOk = anchorExists(c.insertionAfterAnchorId);
      if (!beforeOk && !afterOk) {
        return `requiredCorrections[${index}] scope=insertion 需要 before/after 至少一个存在的 anchor`;
      }
      break;
    }
    case 'chapter':
      if (
        c.anchorId != null ||
        c.anchorIds != null ||
        c.insertionBeforeAnchorId != null ||
        c.insertionAfterAnchorId != null
      ) {
        return `requiredCorrections[${index}] scope=chapter 不得携带 anchor 定位`;
      }
      break;
    case 'boundary': {
      const boundary = c.boundary;
      if (boundary !== 'opening' && boundary !== 'ending') {
        return `requiredCorrections[${index}] scope=boundary 需要 boundary=opening|ending`;
      }
      if (c.anchorId != null && !anchorExists(c.anchorId)) {
        return `requiredCorrections[${index}] scope=boundary 的邻近 anchor 不存在`;
      }
      break;
    }
    default:
      return `requiredCorrections[${index}] 未知 scope`;
  }

  // preserveMeaning bounded string array.
  if (c.preserveMeaning != null) {
    if (!Array.isArray(c.preserveMeaning)) {
      return `requiredCorrections[${index}].preserveMeaning 必须是数组`;
    }
    if (c.preserveMeaning.length > REVISION_V2_LIMITS.MAX_PRESERVE_MEANING_ITEMS) {
      return `requiredCorrections[${index}].preserveMeaning 超上限`;
    }
    for (const p of c.preserveMeaning) {
      if (typeof p !== 'string' || !p.trim()) {
        return `requiredCorrections[${index}].preserveMeaning 元素必须是非空字符串`;
      }
      if (p.length > REVISION_V2_LIMITS.MAX_PRESERVE_MEANING_CHARS) {
        return `requiredCorrections[${index}].preserveMeaning 单项过长`;
      }
    }
  }
  return null;
}

function normalizeCorrection(
  value: unknown,
  _anchors: PipelineRevisionAnchor[],
): PipelineAuditCorrectionV2 | null {
  const c = value as Record<string, unknown>;
  const out: PipelineAuditCorrectionV2 = {
    id: String(c.id).trim(),
    scope: c.scope as PipelineAuditCorrectionV2['scope'],
    dimension: String(c.dimension).trim(),
    severity: c.severity as PipelineAuditCorrectionV2['severity'],
    diagnosis: String(c.diagnosis ?? '').trim(),
    rewriteGoal: String(c.rewriteGoal ?? '').trim(),
    preserveMeaning: Array.isArray(c.preserveMeaning)
      ? c.preserveMeaning.map(p => String(p).trim())
      : [],
  };
  const scope = out.scope;
  if (scope === 'anchor' && c.anchorId != null) {
    out.anchorId = String(c.anchorId).trim();
  } else if (scope === 'range' && Array.isArray(c.anchorIds)) {
    out.anchorIds = c.anchorIds.map(id => String(id).trim());
  } else if (scope === 'insertion') {
    if (c.insertionBeforeAnchorId != null) {
      out.insertionBeforeAnchorId = String(c.insertionBeforeAnchorId).trim();
    }
    if (c.insertionAfterAnchorId != null) {
      out.insertionAfterAnchorId = String(c.insertionAfterAnchorId).trim();
    }
  } else if (scope === 'boundary' && c.boundary != null) {
    out.boundary = c.boundary as 'opening' | 'ending';
    if (c.anchorId != null) {
      out.anchorId = String(c.anchorId).trim();
    }
  }
  return out;
}

function normalizeStringArray(
  value: unknown,
  maxItems: number,
): { ok: true; items: string[] } | { ok: false; details: string } {
  if (!Array.isArray(value)) return { ok: false, details: '必须是数组' };
  if (value.length > maxItems) return { ok: false, details: `超上限 ${maxItems}` };
  const items: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const entry = value[i];
    if (typeof entry !== 'string' || !entry.trim()) {
      return { ok: false, details: `元素[${i}] 必须是非空字符串` };
    }
    items.push(entry.trim());
  }
  return { ok: true, items };
}

/**
 * Shared V2 pipeline: precheck → JSON extraction → whitelist → echo/leak scan
 * → draftHash check → field normalization. Returns parsed object or failure.
 */
function parseV2Report(
  result: LLMResult,
  canonicalDraft: string,
  expectedHash: string,
  allowedKeys: Set<string>,
  kind: 'review' | 'factCheck',
): { ok: true; obj: Record<string, unknown> } | { ok: false; reason: AuditValidationFailureReason; details: string } {
  const text =
    typeof result.text === 'string' && result.text.trim().length > 0
      ? result.text
      : null;
  const reasoning =
    typeof result.reasoningText === 'string' &&
    result.reasoningText.trim().length > 0
      ? result.reasoningText
      : null;
  if (!text && reasoning) {
    return { ok: false, reason: 'reasoning_only', details: 'content 为空，仅返回 reasoning_content' };
  }
  if (!text) {
    return { ok: false, reason: 'empty_content', details: 'content 为空' };
  }
  const rawText = text.trim();

  if (/<think[\s\S]*?<\/think>/i.test(rawText) || /^<think\b/i.test(rawText)) {
    return { ok: false, reason: 'unexpected_shape', details: '输出含 <think> 推理泄漏' };
  }

  const echoEarly = detectDraftEcho(rawText, canonicalDraft);
  if (
    echoEarly.isEcho &&
    !rawText.trimStart().startsWith('{') &&
    !rawText.includes('"draftHash"')
  ) {
    return { ok: false, reason: 'draft_echo', details: echoEarly.reason || 'draft_echo' };
  }
  if (!rawText.includes('{')) {
    return { ok: false, reason: 'novel_output', details: '输出为连续正文而非 JSON 报告' };
  }

  const extracted = extractAuditJsonPayload(rawText);
  if (!extracted.jsonText) {
    if (result.finishReason === 'length' || extracted.truncatedLikely) {
      return { ok: false, reason: 'truncated_output', details: 'JSON 不完整或被截断' };
    }
    return { ok: false, reason: 'invalid_json', details: '无法解析为 JSON 对象' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted.jsonText);
  } catch {
    if (result.finishReason === 'length' || extracted.truncatedLikely) {
      return { ok: false, reason: 'truncated_output', details: 'JSON 解析失败且 finishReason=length' };
    }
    return { ok: false, reason: 'invalid_json', details: 'JSON.parse 失败' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'unexpected_shape', details: '根节点不是 JSON 对象' };
  }
  const obj = parsed as Record<string, unknown>;

  const whitelistError = checkTopLevelWhitelist(obj, allowedKeys);
  if (whitelistError) {
    return { ok: false, reason: 'unexpected_shape', details: whitelistError };
  }
  if (Number(obj.schemaVersion) !== 2) {
    return { ok: false, reason: 'missing_required_fields', details: 'schemaVersion 必须为 2' };
  }
  if (typeof obj.draftHash !== 'string' || obj.draftHash !== expectedHash) {
    return { ok: false, reason: 'missing_required_fields', details: `draftHash 与客户端不一致 (${kind})` };
  }
  if (!Array.isArray(obj.requiredCorrections)) {
    return { ok: false, reason: 'missing_required_fields', details: '缺少 requiredCorrections 数组' };
  }
  if (obj.requiredCorrections.length > REVISION_V2_LIMITS.MAX_CORRECTIONS) {
    return { ok: false, reason: 'oversized_report', details: 'requiredCorrections 超上限' };
  }

  const allStrings: string[] = [];
  collectStrings(parsed, allStrings);
  const markerLeak = checkAnchorMarkerLeak(allStrings);
  if (markerLeak) {
    return { ok: false, reason: 'unexpected_shape', details: markerLeak };
  }
  const promptLeak = checkPromptLeak(allStrings);
  if (promptLeak) {
    return { ok: false, reason: 'unexpected_shape', details: promptLeak };
  }
  const echo = detectDraftEcho(allStrings.join('\n'), canonicalDraft);
  if (echo.isEcho) {
    return { ok: false, reason: 'draft_echo', details: echo.reason || '报告回显初稿' };
  }

  return { ok: true, obj };
}

/**
 * Validate Review V2 LLM output against the canonical draft + anchors.
 * `expectedHash` must be `computeDraftHash(canonicalDraft)` (client-side).
 */
function validateReviewV2StrictResult(params: {
  result: LLMResult;
  canonicalDraft: string;
  expectedHash: string;
  anchors: PipelineRevisionAnchor[];
}): AuditValidationResult<PipelineReviewReportV2> {
  const parsed = parseV2Report(
    params.result,
    params.canonicalDraft,
    params.expectedHash,
    REVIEW_V2_TOP_LEVEL_KEYS,
    'review',
  );
  if (!parsed.ok) {
    return failV2<PipelineReviewReportV2>(parsed.reason, parsed.details);
  }
  const obj = parsed.obj;

  const protectedAnchorIds = normalizeStringArray(
    obj.protectedAnchorIds,
    REVISION_V2_LIMITS.MAX_PROTECTED_ITEMS,
  );
  if (!protectedAnchorIds.ok) {
    return failV2('unexpected_shape', `protectedAnchorIds: ${protectedAnchorIds.details}`);
  }
  for (const id of protectedAnchorIds.items) {
    if (!params.anchors.some(a => a.id === id)) {
      return failV2('unexpected_shape', `protectedAnchorIds 引用了不存在的 anchor: ${id}`);
    }
  }

  const outlineExec = obj.outlineExecution;
  if (!outlineExec || typeof outlineExec !== 'object' || Array.isArray(outlineExec)) {
    return failV2('missing_required_fields', '缺少 outlineExecution 对象');
  }
  const oe = outlineExec as Record<string, unknown>;
  const oeWhitelist = new Set([
    'fulfilledBeats',
    'missingBeats',
    'deviations',
    'prematureBeats',
    'mustPreserve',
    'endingGoal',
    'mustNotAdvance',
  ]);
  const oeExtra = Object.keys(oe).filter(k => !oeWhitelist.has(k));
  if (oeExtra.length > 0) {
    return failV2('unexpected_shape', `outlineExecution 含未知字段: ${oeExtra.join(', ')}`);
  }
  const normalizedOe: PipelineReviewReportV2['outlineExecution'] = {
    fulfilledBeats: [],
    missingBeats: [],
    deviations: [],
    prematureBeats: [],
    mustPreserve: [],
    mustNotAdvance: [],
  };
  const oeArrays: Array<'fulfilledBeats' | 'missingBeats' | 'deviations' | 'prematureBeats' | 'mustPreserve' | 'mustNotAdvance'> = [
    'fulfilledBeats',
    'missingBeats',
    'deviations',
    'prematureBeats',
    'mustPreserve',
    'mustNotAdvance',
  ];
  for (const key of oeArrays) {
    const norm = normalizeStringArray(oe[key], REVISION_V2_LIMITS.MAX_BEAT_ITEMS);
    if (!norm.ok) {
      return failV2('unexpected_shape', `outlineExecution.${key}: ${norm.details}`);
    }
    normalizedOe[key] = norm.items;
  }
  if (oe.endingGoal != null) {
    if (typeof oe.endingGoal !== 'string' || !oe.endingGoal.trim()) {
      return failV2('unexpected_shape', 'outlineExecution.endingGoal 必须是字符串');
    }
    normalizedOe.endingGoal = oe.endingGoal.trim();
  }

  const corrections: PipelineAuditCorrectionV2[] = [];
  const correctionsRaw = obj.requiredCorrections as unknown[];
  for (let i = 0; i < correctionsRaw.length; i += 1) {
    const err = validateCorrection(correctionsRaw[i], params.anchors, i);
    if (err) return failV2('unexpected_shape', err);
    corrections.push(normalizeCorrection(correctionsRaw[i], params.anchors)!);
  }

  // Protocol conflict (§6.2): a protected anchor that is ALSO the target of
  // a required/hard correction in the SAME report contradicts itself (the
  // Final Reviser is told to both preserve and modify it). Reject with
  // `conflict` so the one-shot format repair fires; the contract compiler
  // resolves cross-report (review protection vs FactCheck hard revision)
  // conflicts separately with fact-first semantics.
  const protectedIds = new Set(protectedAnchorIds.items);
  for (const c of corrections) {
    if (c.severity === 'warning') continue;
    const targets: string[] = [];
    if (c.scope === 'anchor' && c.anchorId) targets.push(c.anchorId);
    if (c.scope === 'range' && Array.isArray(c.anchorIds)) {
      for (const id of c.anchorIds) if (id) targets.push(id);
    }
    for (const id of targets) {
      if (protectedIds.has(id)) {
        return failV2(
          'conflict',
          `保护锚点 ${id} 与 required/hard 修订定位重叠`,
        );
      }
    }
  }

  const report: PipelineReviewReportV2 = {
    schemaVersion: 2,
    draftHash: params.expectedHash,
    requiredCorrections: corrections,
    protectedAnchorIds: protectedAnchorIds.items,
    outlineExecution: normalizedOe,
  };
  const normalizedText = JSON.stringify(report);
  if (normalizedText.length > REVISION_V2_LIMITS.MAX_REPORT_CHARS) {
    return failV2('oversized_report', '报告整体过长');
  }
  return {
    valid: true,
    report,
    normalizedText,
    similarity: detectDraftEcho(normalizedText, params.canonicalDraft).similarity,
  };
}

const REVIEW_NARRATIVE_HINT_RE =
  /(建议|问题|不足|需要|节奏|文风|逻辑|评价|评估|优点|缺点|修改|改进)/;

function tolerantText(value: unknown, maxChars: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxChars) : '';
}

function tolerantStringArray(
  value: unknown,
  maxItems: number,
  label: string,
  warnings: string[],
): string[] {
  if (!Array.isArray(value)) {
    warnings.push(`${label} 已归一化为空数组`);
    return [];
  }
  if (value.length > maxItems) {
    warnings.push(`${label} 超上限，已截断`);
  }
  const result: string[] = [];
  for (const entry of value.slice(0, maxItems)) {
    if (typeof entry !== 'string' || !entry.trim()) {
      warnings.push(`${label} 含非法元素，已丢弃`);
      continue;
    }
    result.push(entry.trim().slice(0, REVISION_V2_LIMITS.MAX_CORRECTION_TEXT_CHARS));
  }
  return result;
}

function pickTolerantText(
  obj: Record<string, unknown>,
  keys: string[],
): string {
  for (const key of keys) {
    const text = tolerantText(obj[key], REVISION_V2_LIMITS.MAX_CORRECTION_TEXT_CHARS);
    if (text) return text;
  }
  return '';
}

function normalizeTolerantCorrection(
  value: unknown,
  index: number,
  anchors: PipelineRevisionAnchor[],
  warnings: string[],
  usedIds: Set<string>,
): PipelineAuditCorrectionV2 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    warnings.push(`requiredCorrections[${index}] 非对象，已丢弃`);
    return null;
  }
  const c = value as Record<string, unknown>;
  const exists = (id: unknown): id is string =>
    typeof id === 'string' && anchors.some(anchor => anchor.id === id.trim());
  const anchorId = exists(c.anchorId) ? String(c.anchorId).trim() : undefined;
  const anchorIds = Array.isArray(c.anchorIds)
    ? c.anchorIds.filter(exists).map(id => id.trim())
    : [];
  const insertionBeforeAnchorId = exists(c.insertionBeforeAnchorId)
    ? String(c.insertionBeforeAnchorId).trim()
    : undefined;
  const insertionAfterAnchorId = exists(c.insertionAfterAnchorId)
    ? String(c.insertionAfterAnchorId).trim()
    : undefined;
  const boundary =
    c.boundary === 'opening' || c.boundary === 'ending' ? c.boundary : undefined;

  const rawScope = typeof c.scope === 'string' ? c.scope.trim() : '';
  let scope: PipelineAuditCorrectionV2['scope'];
  if (SCOPES.has(rawScope)) {
    scope = rawScope as PipelineAuditCorrectionV2['scope'];
  } else if (anchorId) {
    scope = 'anchor';
    warnings.push(`requiredCorrections[${index}].scope 已根据 anchorId 推断`);
  } else if (anchorIds.length >= 2) {
    scope = 'range';
    warnings.push(`requiredCorrections[${index}].scope 已根据 anchorIds 推断`);
  } else if (insertionBeforeAnchorId || insertionAfterAnchorId) {
    scope = 'insertion';
    warnings.push(`requiredCorrections[${index}].scope 已根据插入定位推断`);
  } else if (boundary) {
    scope = 'boundary';
    warnings.push(`requiredCorrections[${index}].scope 已根据 boundary 推断`);
  } else {
    scope = 'chapter';
    warnings.push(`requiredCorrections[${index}].scope 已归一化为 chapter`);
  }

  const requestedScope = scope;
  if (
    (scope === 'anchor' && !anchorId) ||
    (scope === 'range' && anchorIds.length < 2) ||
    (scope === 'insertion' && !insertionBeforeAnchorId && !insertionAfterAnchorId) ||
    (scope === 'boundary' && !boundary)
  ) {
    scope = 'chapter';
    warnings.push(
      `requiredCorrections[${index}] 的 ${requestedScope} 定位无效，已降级为 chapter`,
    );
  }

  const rawSeverity = typeof c.severity === 'string' ? c.severity.trim() : '';
  const diagnosis = pickTolerantText(c, [
    'diagnosis',
    'problem',
    'issue',
    'description',
    'message',
  ]);
  const rewriteGoal = pickTolerantText(c, [
    'rewriteGoal',
    'suggestedAction',
    'suggestion',
    'action',
    'fix',
  ]);
  const severity: PipelineAuditCorrectionV2['severity'] = SEVERITIES.has(
    rawSeverity,
  )
    ? (rawSeverity as PipelineAuditCorrectionV2['severity'])
    : /(必须|错误|冲突|硬约束|事实)/.test(`${diagnosis}${rewriteGoal}`)
      ? 'required'
      : 'warning';
  if (!SEVERITIES.has(rawSeverity)) {
    warnings.push(`requiredCorrections[${index}].severity 已归一化为 ${severity}`);
  }

  if (!diagnosis && !rewriteGoal) {
    warnings.push(`requiredCorrections[${index}] 缺少可用描述，已丢弃`);
    return null;
  }
  const normalizedDiagnosis =
    diagnosis || '模型未提供具体诊断，将按修订目标处理。';
  const normalizedRewriteGoal =
    rewriteGoal || '根据该评估修订对应内容，同时保持既有事实与大纲边界。';
  const preserveMeaning = Array.isArray(c.preserveMeaning)
    ? c.preserveMeaning
        .filter(p => typeof p === 'string' && p.trim())
        .slice(0, REVISION_V2_LIMITS.MAX_PRESERVE_MEANING_ITEMS)
        .map(p => String(p).trim().slice(0, REVISION_V2_LIMITS.MAX_PRESERVE_MEANING_CHARS))
    : [];
  if (c.preserveMeaning != null && !Array.isArray(c.preserveMeaning)) {
    warnings.push(`requiredCorrections[${index}].preserveMeaning 已归一化为空数组`);
  }

  let id = tolerantText(c.id, 120);
  if (!id) {
    id = `review-normalized-${String(index + 1).padStart(3, '0')}`;
    warnings.push(`requiredCorrections[${index}].id 已生成`);
  }
  const baseId = id;
  let suffix = 2;
  while (usedIds.has(id)) id = `${baseId}-${suffix++}`;
  if (id !== baseId) warnings.push(`requiredCorrections[${index}].id 重复，已去重`);
  usedIds.add(id);

  const out: PipelineAuditCorrectionV2 = {
    id,
    scope,
    dimension:
      tolerantText(c.dimension, 120) ||
      (warnings.push(`requiredCorrections[${index}].dimension 已归一化为 literary`), 'literary'),
    severity,
    diagnosis: normalizedDiagnosis,
    rewriteGoal: normalizedRewriteGoal,
    preserveMeaning,
  };
  if (scope === 'anchor' && anchorId) out.anchorId = anchorId;
  if (scope === 'range') out.anchorIds = [...new Set(anchorIds)];
  if (scope === 'insertion') {
    if (insertionBeforeAnchorId) out.insertionBeforeAnchorId = insertionBeforeAnchorId;
    if (insertionAfterAnchorId) out.insertionAfterAnchorId = insertionAfterAnchorId;
  }
  if (scope === 'boundary' && boundary) {
    out.boundary = boundary;
    if (anchorId) out.anchorId = anchorId;
  }
  return out;
}

function emptyOutlineExecution(): PipelineReviewReportV2['outlineExecution'] {
  return {
    fulfilledBeats: [],
    missingBeats: [],
    deviations: [],
    prematureBeats: [],
    mustPreserve: [],
    mustNotAdvance: [],
  };
}

function buildNarrativeReviewFallback(
  text: string,
  expectedHash: string,
): AuditValidationResult<PipelineReviewReportV2> | null {
  const trimmed = text.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 2400 ||
    !REVIEW_NARRATIVE_HINT_RE.test(trimmed)
  ) {
    return null;
  }
  const diagnosis = trimmed.slice(0, REVISION_V2_LIMITS.MAX_CORRECTION_TEXT_CHARS);
  const report: PipelineReviewReportV2 = {
    schemaVersion: 2,
    draftHash: expectedHash,
    requiredCorrections: [
      {
        id: 'review-narrative-fallback-001',
        scope: 'chapter',
        dimension: 'literary',
        severity: 'warning',
        diagnosis,
        rewriteGoal: '结合该文学评估统一修订本章，同时保持既有事实与大纲边界。',
        preserveMeaning: [],
      },
    ],
    protectedAnchorIds: [],
    outlineExecution: emptyOutlineExecution(),
  };
  return {
    valid: true,
    report,
    normalizedText: JSON.stringify(report),
    warnings: ['review_narrative_fallback'],
    similarity: 0,
  };
}

/**
 * Tolerant Review V2 path. It accepts protocol drift (missing fields,
 * harmless extra fields, malformed locators and narrative review prose),
 * but still fails closed for reasoning-only output, prompt/anchor leakage,
 * draft echo, truncated JSON and genuinely novel non-review output.
 */
export function validateReviewV2Result(params: {
  result: LLMResult;
  canonicalDraft: string;
  expectedHash: string;
  anchors: PipelineRevisionAnchor[];
}): AuditValidationResult<PipelineReviewReportV2> {
  const strict = validateReviewV2StrictResult(params);
  if (strict.valid) return strict;

  const text =
    typeof params.result.text === 'string' && params.result.text.trim()
      ? params.result.text.trim()
      : '';
  const reasoning =
    typeof params.result.reasoningText === 'string' && params.result.reasoningText.trim()
      ? params.result.reasoningText.trim()
      : '';
  if (!text && reasoning) {
    return failV2('reasoning_only', 'content 为空，仅返回 reasoning_content');
  }
  if (!text) return failV2('empty_content', 'content 为空');
  if (/<think[\s\S]*?<\/think>/i.test(text) || /^<think\b/i.test(text)) {
    return failV2('unexpected_shape', '输出含 <think> 推理泄漏');
  }
  const rawLeak = checkAnchorMarkerLeak([text]) || checkPromptLeak([text]);
  if (rawLeak) return failV2('unexpected_shape', rawLeak);

  const earlyEcho = detectDraftEcho(text, params.canonicalDraft);
  if (
    earlyEcho.isEcho &&
    !text.startsWith('{') &&
    !text.includes('"draftHash"')
  ) {
    return failV2('draft_echo', earlyEcho.reason || 'draft_echo');
  }

  const extracted = extractAuditJsonPayload(text);
  if (!extracted.jsonText) {
    if (params.result.finishReason === 'length' || extracted.truncatedLikely) {
      return failV2('truncated_output', 'JSON 不完整或被截断');
    }
    const narrative = buildNarrativeReviewFallback(text, params.expectedHash);
    if (narrative) return narrative;
    return failV2('novel_output', '输出不是可归一化的 Review 报告');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted.jsonText);
  } catch {
    return failV2('invalid_json', 'JSON.parse 失败');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return failV2('unexpected_shape', '根节点不是 JSON 对象');
  }
  const obj = parsed as Record<string, unknown>;
  const allStrings: string[] = [];
  collectStrings(parsed, allStrings);
  const markerLeak = checkAnchorMarkerLeak(allStrings);
  if (markerLeak) return failV2('unexpected_shape', markerLeak);
  const promptLeak = checkPromptLeak(allStrings);
  if (promptLeak) return failV2('unexpected_shape', promptLeak);
  const echo = detectDraftEcho(allStrings.join('\n'), params.canonicalDraft);
  if (echo.isEcho) return failV2('draft_echo', echo.reason || '报告回显初稿');
  if (extracted.surroundingProseLength > 2000) {
    return failV2('novel_output', 'JSON 外围包含过多连续正文');
  }

  const warnings: string[] = ['review_protocol_normalized'];
  const allowedTopLevel = REVIEW_V2_TOP_LEVEL_KEYS;
  const extras = Object.keys(obj).filter(key => !allowedTopLevel.has(key));
  if (extras.length > 0) warnings.push(`忽略未知顶层字段: ${extras.join(', ')}`);
  if (Number(obj.schemaVersion) !== 2) warnings.push('schemaVersion 已归一化为 2');
  if (obj.draftHash !== params.expectedHash) {
    warnings.push('draftHash 缺失或不一致，已采用客户端 hash');
  }

  const protectedAnchorIds = tolerantStringArray(
    obj.protectedAnchorIds,
    REVISION_V2_LIMITS.MAX_PROTECTED_ITEMS,
    'protectedAnchorIds',
    warnings,
  ).filter(id => {
    const exists = params.anchors.some(anchor => anchor.id === id);
    if (!exists) warnings.push(`protectedAnchorIds 丢弃未知 anchor: ${id}`);
    return exists;
  });

  const outlineExecution = emptyOutlineExecution();
  const rawOutline = obj.outlineExecution;
  if (!rawOutline || typeof rawOutline !== 'object' || Array.isArray(rawOutline)) {
    warnings.push('outlineExecution 缺失，已填充空对象');
  } else {
    const oe = rawOutline as Record<string, unknown>;
    const outlineKeys = new Set([
      'fulfilledBeats',
      'missingBeats',
      'deviations',
      'prematureBeats',
      'mustPreserve',
      'endingGoal',
      'mustNotAdvance',
    ]);
    const outlineExtras = Object.keys(oe).filter(key => !outlineKeys.has(key));
    if (outlineExtras.length > 0) {
      warnings.push(`忽略 outlineExecution 未知字段: ${outlineExtras.join(', ')}`);
    }
    for (const key of [
      'fulfilledBeats',
      'missingBeats',
      'deviations',
      'prematureBeats',
      'mustPreserve',
      'mustNotAdvance',
    ] as const) {
      outlineExecution[key] = tolerantStringArray(
        oe[key],
        REVISION_V2_LIMITS.MAX_BEAT_ITEMS,
        `outlineExecution.${key}`,
        warnings,
      );
    }
    if (typeof oe.endingGoal === 'string' && oe.endingGoal.trim()) {
      outlineExecution.endingGoal = tolerantText(
        oe.endingGoal,
        REVISION_V2_LIMITS.MAX_CORRECTION_TEXT_CHARS,
      );
    } else if (oe.endingGoal != null) {
      warnings.push('outlineExecution.endingGoal 已丢弃');
    }
  }

  const corrections: PipelineAuditCorrectionV2[] = [];
  const usedIds = new Set<string>();
  const rawCorrections = Array.isArray(obj.requiredCorrections)
    ? obj.requiredCorrections
    : [];
  if (!Array.isArray(obj.requiredCorrections)) {
    warnings.push('requiredCorrections 缺失，已填充为空数组');
  }
  if (rawCorrections.length > REVISION_V2_LIMITS.MAX_CORRECTIONS) {
    warnings.push('requiredCorrections 超上限，已截断');
  }
  for (let index = 0; index < Math.min(rawCorrections.length, REVISION_V2_LIMITS.MAX_CORRECTIONS); index += 1) {
    const correction = normalizeTolerantCorrection(
      rawCorrections[index],
      index,
      params.anchors,
      warnings,
      usedIds,
    );
    if (correction) corrections.push(correction);
  }

  const protectedSet = new Set(protectedAnchorIds);
  for (const correction of corrections) {
    if (correction.severity === 'warning') continue;
    const targets =
      correction.scope === 'anchor' && correction.anchorId
        ? [correction.anchorId]
        : correction.scope === 'range'
          ? correction.anchorIds || []
          : [];
    const conflict = targets.find(id => protectedSet.has(id));
    if (conflict) {
      return failV2('conflict', `保护锚点 ${conflict} 与 required/hard 修订定位重叠`);
    }
  }

  const report: PipelineReviewReportV2 = {
    schemaVersion: 2,
    draftHash: params.expectedHash,
    requiredCorrections: corrections,
    protectedAnchorIds,
    outlineExecution,
  };
  const normalizedText = JSON.stringify(report);
  if (normalizedText.length > REVISION_V2_LIMITS.MAX_REPORT_CHARS) {
    return failV2('oversized_report', '归一化报告整体过长');
  }
  return {
    valid: true,
    report,
    normalizedText,
    warnings,
    similarity: detectDraftEcho(normalizedText, params.canonicalDraft).similarity,
  };
}

/**
 * Validate FactCheck V2 LLM output against the canonical draft + anchors.
 */
export function validateFactCheckV2Result(params: {
  result: LLMResult;
  canonicalDraft: string;
  expectedHash: string;
  anchors: PipelineRevisionAnchor[];
}): AuditValidationResult<PipelineFactCheckReportV2> {
  const parsed = parseV2Report(
    params.result,
    params.canonicalDraft,
    params.expectedHash,
    FACTCHECK_V2_TOP_LEVEL_KEYS,
    'factCheck',
  );
  if (!parsed.ok) {
    return failV2<PipelineFactCheckReportV2>(parsed.reason, parsed.details);
  }
  const obj = parsed.obj;

  const protectedFacts = normalizeStringArray(
    obj.protectedFacts,
    REVISION_V2_LIMITS.MAX_PROTECTED_ITEMS,
  );
  if (!protectedFacts.ok) {
    return failV2('unexpected_shape', `protectedFacts: ${protectedFacts.details}`);
  }
  const hardConstraints = normalizeStringArray(
    obj.hardConstraints,
    REVISION_V2_LIMITS.MAX_PROTECTED_ITEMS,
  );
  if (!hardConstraints.ok) {
    return failV2('unexpected_shape', `hardConstraints: ${hardConstraints.details}`);
  }

  const corrections: PipelineAuditCorrectionV2[] = [];
  const correctionsRaw = obj.requiredCorrections as unknown[];
  for (let i = 0; i < correctionsRaw.length; i += 1) {
    const err = validateCorrection(correctionsRaw[i], params.anchors, i);
    if (err) return failV2('unexpected_shape', err);
    corrections.push(normalizeCorrection(correctionsRaw[i], params.anchors)!);
  }

  const report: PipelineFactCheckReportV2 = {
    schemaVersion: 2,
    draftHash: params.expectedHash,
    requiredCorrections: corrections,
    protectedFacts: protectedFacts.items,
    hardConstraints: hardConstraints.items,
  };
  const normalizedText = JSON.stringify(report);
  if (normalizedText.length > REVISION_V2_LIMITS.MAX_REPORT_CHARS) {
    return failV2('oversized_report', '报告整体过长');
  }
  return {
    valid: true,
    report,
    normalizedText,
    similarity: detectDraftEcho(normalizedText, params.canonicalDraft).similarity,
  };
}

// ---------------------------------------------------------------------------
// Workflow V3 normalized audit boundary
// ---------------------------------------------------------------------------

function v3Text(value: unknown, max = 800): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function v3Array(value: unknown, max = 60): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(item => typeof item === 'string' && item.trim())
    .slice(0, max)
    .map(item => v3Text(item, 320));
}

function v3Severity(value: unknown, diagnosis: string, goal: string): 'hard' | 'required' | 'warning' {
  if (value === 'hard' || value === 'required' || value === 'warning') return value;
  return /(必须|硬约束|事实|冲突|错误)/.test(`${diagnosis}${goal}`)
    ? 'required'
    : 'warning';
}

function v3Location(
  raw: Record<string, unknown>,
  anchors: PipelineRevisionAnchor[],
): { valid: boolean; explicitChapter: boolean; location: string } {
  const scope = v3Text(raw.scope, 40);
  const anchorId = v3Text(raw.anchorId, 120);
  const anchorIds = Array.isArray(raw.anchorIds)
    ? raw.anchorIds.map(item => v3Text(item, 120)).filter(Boolean)
    : [];
  const hasAnchor = (id: string) => anchors.some(anchor => anchor.id === id);
  if (scope === 'chapter') return { valid: true, explicitChapter: true, location: 'chapter' };
  if (scope === 'boundary' && (raw.boundary === 'opening' || raw.boundary === 'ending')) {
    return {
      valid: raw.anchorId == null || hasAnchor(anchorId),
      explicitChapter: false,
      location: raw.boundary,
    };
  }
  if (scope === 'anchor') {
    return { valid: hasAnchor(anchorId), explicitChapter: false, location: 'middle' };
  }
  if (scope === 'range') {
    return {
      valid: anchorIds.length >= 2 && anchorIds.every(hasAnchor),
      explicitChapter: false,
      location: 'middle',
    };
  }
  if (scope === 'insertion') {
    const before = v3Text(raw.insertionBeforeAnchorId, 120);
    const after = v3Text(raw.insertionAfterAnchorId, 120);
    return {
      valid: Boolean((before && hasAnchor(before)) || (after && hasAnchor(after))),
      explicitChapter: false,
      location: raw.boundary === 'opening' || raw.boundary === 'ending' ? raw.boundary : 'middle',
    };
  }
  const explicitHint = v3Text(raw.locationHint, 80);
  return { valid: false, explicitChapter: false, location: explicitHint || 'unlocated' };
}

function v3Correction(
  raw: unknown,
  index: number,
  source: 'review' | 'factCheck',
  anchors: PipelineRevisionAnchor[],
  warnings: string[],
): { item: NormalizedCorrectionV3 | null; advisory?: string; unlocated?: boolean } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push(`${source} corrections[${index}] 非对象，已丢弃`);
    return { item: null };
  }
  const row = raw as Record<string, unknown>;
  const diagnosis = v3Text(row.diagnosis ?? row.problem ?? row.issue);
  const rewriteGoal = v3Text(row.rewriteGoal ?? row.action ?? row.suggestion ?? row.fix);
  if (!diagnosis && !rewriteGoal) {
    warnings.push(`${source} corrections[${index}] 无诊断/目标，已丢弃`);
    return { item: null };
  }
  const severity = v3Severity(row.severity, diagnosis, rewriteGoal);
  const location = v3Location(row, anchors);
  const sourceId = v3Text(row.id, 120) || `${source}-v3-${String(index + 1).padStart(3, '0')}`;
  const item: NormalizedCorrectionV3 = {
    sourceId,
    source,
    severity,
    dimension: v3Text(row.dimension, 120) || 'literary',
    diagnosis,
    rewriteGoal,
    preserveMeaning: v3Array(row.preserveMeaning, 20),
    locationHint: location.location,
    evidenceQuote: v3Text(row.evidenceQuote ?? row.quote, 80) || undefined,
  };
  if (severity === 'warning') {
    return {
      item: null,
      advisory: `${item.dimension}：${diagnosis || rewriteGoal}`,
    };
  }
  if (!location.valid && !location.explicitChapter) {
    warnings.push(`${source} ${sourceId} 定位无效，转为 unlocatedRequired，不扩大为 chapter`);
    return { item: { ...item, locationHint: 'unlocated' }, unlocated: true };
  }
  return { item };
}

function v3ReportPayload(result: LLMResult):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: AuditValidationFailureReason; details: string } {
  const text = typeof result.text === 'string' ? result.text.trim() : '';
  const reasoning = typeof result.reasoningText === 'string' ? result.reasoningText.trim() : '';
  if (!text && reasoning) return { ok: false, reason: 'reasoning_only', details: 'content 为空，仅返回 reasoning_content' };
  if (!text) return { ok: false, reason: 'empty_content', details: 'content 为空' };
  if (/<think[\s\S]*?<\/think>/i.test(text) || /^<think\b/i.test(text)) {
    return { ok: false, reason: 'unexpected_shape', details: '输出含 <think> 推理泄漏' };
  }
  const extracted = extractAuditJsonPayload(text);
  if (!extracted.jsonText) return { ok: false, reason: 'invalid_json', details: '无法提取 JSON' };
  try {
    const parsed = JSON.parse(extracted.jsonText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'unexpected_shape', details: '根节点不是对象' };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, reason: 'invalid_json', details: 'JSON.parse 失败' };
  }
}

/** V3 Review normalizer: invalid locators reduce authority, never widen it. */
export function validateReviewV3Result(params: {
  result: LLMResult;
  expectedHash: string;
  anchors: PipelineRevisionAnchor[];
}): AuditValidationResult<NormalizedReviewV3> {
  const payload = v3ReportPayload(params.result);
  if (!payload.ok) return failV2<NormalizedReviewV3>(payload.reason, payload.details);
  const warnings: string[] = [];
  const obj = payload.value;
  if (obj.draftHash != null && obj.draftHash !== params.expectedHash) {
    return failV2<NormalizedReviewV3>(
      'missing_required_fields',
      'draftHash 与客户端不一致（Review V3）',
    );
  }
  if (obj.draftHash == null) warnings.push('draftHash 缺失，已由客户端补齐');
  const rawCorrections = Array.isArray(obj.requiredCorrections)
    ? obj.requiredCorrections
    : Array.isArray(obj.corrections)
      ? obj.corrections
      : [];
  const executableCorrections: NormalizedCorrectionV3[] = [];
  const unlocatedRequired: NormalizedCorrectionV3[] = [];
  const advisoryNotes = v3Array(obj.advisoryNotes, 40);
  for (let i = 0; i < rawCorrections.length && i < 60; i += 1) {
    const normalized = v3Correction(rawCorrections[i], i, 'review', params.anchors, warnings);
    if (normalized.advisory) advisoryNotes.push(normalized.advisory);
    else if (normalized.item && normalized.unlocated) unlocatedRequired.push(normalized.item);
    else if (normalized.item) executableCorrections.push(normalized.item);
  }
  const rawOutline = obj.outlineExecution;
  const outline = rawOutline && typeof rawOutline === 'object' && !Array.isArray(rawOutline)
    ? rawOutline as Record<string, unknown>
    : {};
  const report: NormalizedReviewV3 = {
    schemaVersion: 3,
    draftHash: params.expectedHash,
    executableCorrections,
    unlocatedRequired,
    advisoryNotes: [...new Set(advisoryNotes.filter(Boolean))],
    outlineExecution: {
      fulfilledBeats: v3Array(outline.fulfilledBeats),
      missingBeats: v3Array(outline.missingBeats),
      deviations: v3Array(outline.deviations),
      prematureBeats: v3Array(outline.prematureBeats),
      mustPreserve: v3Array(outline.mustPreserve),
      endingGoal: v3Text(outline.endingGoal, 800),
      mustNotAdvance: v3Array(outline.mustNotAdvance),
    },
    protectedFacts: v3Array(obj.protectedFacts),
    warnings,
  };
  return {
    valid: true,
    report,
    normalizedText: JSON.stringify(report),
    warnings,
    similarity: 0,
  };
}

/** V3 FactCheck normalizer; it shares locator authority rules with Review. */
export function validateFactCheckV3Result(params: {
  result: LLMResult;
  expectedHash: string;
  anchors: PipelineRevisionAnchor[];
}): AuditValidationResult<NormalizedFactCheckV3> {
  const payload = v3ReportPayload(params.result);
  if (!payload.ok) return failV2<NormalizedFactCheckV3>(payload.reason, payload.details);
  const warnings: string[] = [];
  const obj = payload.value;
  if (obj.draftHash != null && obj.draftHash !== params.expectedHash) {
    return failV2<NormalizedFactCheckV3>(
      'missing_required_fields',
      'draftHash 与客户端不一致（FactCheck V3）',
    );
  }
  if (obj.draftHash == null) warnings.push('draftHash 缺失，已由客户端补齐');
  const rawCorrections = Array.isArray(obj.requiredCorrections)
    ? obj.requiredCorrections
    : Array.isArray(obj.corrections)
      ? obj.corrections
      : [];
  const corrections: NormalizedCorrectionV3[] = [];
  for (let i = 0; i < rawCorrections.length && i < 60; i += 1) {
    const normalized = v3Correction(rawCorrections[i], i, 'factCheck', params.anchors, warnings);
    if (normalized.item && !normalized.unlocated) corrections.push(normalized.item);
    else if (normalized.item) corrections.push(normalized.item);
  }
  const report: NormalizedFactCheckV3 = {
    schemaVersion: 3,
    draftHash: params.expectedHash,
    corrections,
    protectedFacts: v3Array(obj.protectedFacts),
    hardConstraints: v3Array(obj.hardConstraints),
    warnings,
  };
  return {
    valid: true,
    report,
    normalizedText: JSON.stringify(report),
    warnings,
    similarity: 0,
  };
}
