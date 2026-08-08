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
 * First validation failure keeps the existing one-shot format repair policy;
 * a second failure fails the stage (no infinite retry) — handled by the
 * reconcile loop, not here.
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
export function validateReviewV2Result(params: {
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
