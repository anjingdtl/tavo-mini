import type { LLMResult } from './llm/types';
import type {
  AuditValidationFailureReason,
  AuditValidationResult,
  DraftEchoCheckResult,
  FactCheckItem,
  FactCheckReport,
  ReviewReport,
} from '../types/pipelineAudit';
import { AUDIT_ECHO_THRESHOLDS } from '../types/pipelineAudit';
import { extractJSON } from '../utils/jsonExtractor';

const REVIEW_TOP_LEVEL_KEYS = new Set(['strengths', 'issues', 'suggestions']);
const FACT_CHECK_TOP_LEVEL_KEYS = new Set(['errors', 'warnings', 'confirmed']);
const FACT_ITEM_ALLOWED_KEYS = new Set([
  'description',
  'text',
  'message',
  'issue',
  'category',
  'draftQuote',
  'evidenceType',
  'evidence',
  'suggestedAction',
]);

function fail<T>(
  reason: AuditValidationFailureReason,
  details?: string,
  extra?: Partial<AuditValidationResult<T>>,
): AuditValidationResult<T> {
  return { valid: false, reason, details, ...extra };
}

type NormalizeOk<T> = { ok: true; items: T[] };
type NormalizeErr = { ok: false; details: string };
type NormalizeResult<T> = NormalizeOk<T> | NormalizeErr;

/**
 * Recursively collect every string leaf from a JSON value.
 * Used to catch draft body stuffed into extra / nested fields.
 */
function collectAllStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) out.push(trimmed);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectAllStrings(entry, out);
    return;
  }
  if (value != null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) {
      collectAllStrings(child, out);
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

/**
 * Review arrays only accept non-empty strings. Numbers, booleans, null,
 * empty objects, and unrecognized objects are illegal (not silently dropped).
 */
function normalizeStringArrayStrict(value: unknown): NormalizeResult<string> {
  if (!Array.isArray(value)) {
    return { ok: false, details: '字段必须是数组' };
  }
  const items: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const entry = value[i];
    if (typeof entry === 'string') {
      const trimmed = entry.trim();
      if (trimmed.length > 0) items.push(trimmed);
      continue;
    }
    if (entry == null) {
      return { ok: false, details: `数组元素[${i}] 为 null/undefined` };
    }
    if (typeof entry === 'number' || typeof entry === 'boolean') {
      return {
        ok: false,
        details: `数组元素[${i}] 类型非法 (${typeof entry})`,
      };
    }
    if (typeof entry === 'object') {
      return {
        ok: false,
        details: `数组元素[${i}] 必须是字符串，不能是对象`,
      };
    }
    return { ok: false, details: `数组元素[${i}] 格式无法识别` };
  }
  return { ok: true, items };
}

/**
 * Fact-check arrays accept non-empty strings or objects with a description
 * (or text/message/issue). Illegal element types fail the whole report.
 */
function normalizeFactArrayStrict(
  value: unknown,
): NormalizeResult<string | FactCheckItem> {
  if (!Array.isArray(value)) {
    return { ok: false, details: '字段必须是数组' };
  }
  const items: Array<string | FactCheckItem> = [];
  for (let i = 0; i < value.length; i++) {
    const entry = value[i];
    if (typeof entry === 'string') {
      const trimmed = entry.trim();
      if (trimmed.length > 0) items.push(trimmed);
      continue;
    }
    if (entry == null) {
      return { ok: false, details: `数组元素[${i}] 为 null/undefined` };
    }
    if (typeof entry === 'number' || typeof entry === 'boolean') {
      return {
        ok: false,
        details: `数组元素[${i}] 类型非法 (${typeof entry})`,
      };
    }
    if (Array.isArray(entry)) {
      return { ok: false, details: `数组元素[${i}] 不能是嵌套数组` };
    }
    if (typeof entry === 'object') {
      const obj = entry as Record<string, unknown>;
      const keys = Object.keys(obj);
      if (keys.length === 0) {
        return { ok: false, details: `数组元素[${i}] 为空对象` };
      }
      const unknownKeys = keys.filter(k => !FACT_ITEM_ALLOWED_KEYS.has(k));
      if (unknownKeys.length > 0) {
        return {
          ok: false,
          details: `数组元素[${i}] 含未知字段: ${unknownKeys.join(', ')}`,
        };
      }
      const descriptionRaw =
        obj.description ?? obj.text ?? obj.message ?? obj.issue;
      if (typeof descriptionRaw !== 'string' || !descriptionRaw.trim()) {
        return {
          ok: false,
          details: `数组元素[${i}] 缺少有效 description/text`,
        };
      }
      const item: FactCheckItem = { description: descriptionRaw.trim() };
      if (typeof obj.category === 'string' && obj.category.trim()) {
        item.category = obj.category.trim();
      }
      if (typeof obj.draftQuote === 'string' && obj.draftQuote.trim()) {
        item.draftQuote = obj.draftQuote.trim();
      }
      if (typeof obj.evidenceType === 'string' && obj.evidenceType.trim()) {
        item.evidenceType = obj.evidenceType.trim();
      }
      if (typeof obj.evidence === 'string' && obj.evidence.trim()) {
        item.evidence = obj.evidence.trim();
      }
      if (typeof obj.suggestedAction === 'string' && obj.suggestedAction.trim()) {
        item.suggestedAction = obj.suggestedAction.trim();
      }
      // Non-string values in allowed keys are illegal.
      for (const key of keys) {
        const v = obj[key];
        if (v != null && typeof v !== 'string') {
          return {
            ok: false,
            details: `数组元素[${i}].${key} 必须是字符串`,
          };
        }
      }
      items.push(item);
      continue;
    }
    return { ok: false, details: `数组元素[${i}] 格式无法识别` };
  }
  return { ok: true, items };
}

function itemTextLength(item: string | FactCheckItem): number {
  if (typeof item === 'string') return item.length;
  return (
    (item.description?.length || 0) +
    (item.draftQuote?.length || 0) +
    (item.evidence?.length || 0) +
    (item.suggestedAction?.length || 0)
  );
}

/**
 * Longest shared segment approximation.
 * Fast path: sliding windows of LONG_SHARED_SEGMENT_CHARS via indexOf.
 * Fallback: capped DP for shorter texts (used for similarity score).
 */
function longestSharedSegmentLength(a: string, b: string): number {
  if (!a || !b) return 0;
  const threshold = AUDIT_ECHO_THRESHOLDS.LONG_SHARED_SEGMENT_CHARS;
  // Fast path: any contiguous window of `threshold` chars from a inside b.
  if (a.length >= threshold && b.length >= threshold) {
    const step = Math.max(40, Math.floor(threshold / 8));
    for (let i = 0; i + threshold <= a.length; i += step) {
      if (b.includes(a.slice(i, i + threshold))) {
        return threshold;
      }
    }
    // Also sample from b → a for asymmetric cases.
    for (let i = 0; i + threshold <= b.length; i += step) {
      if (a.includes(b.slice(i, i + threshold))) {
        return threshold;
      }
    }
  }

  const maxWindow = 1200;
  const left = a.length > maxWindow ? a.slice(0, maxWindow) : a;
  const right = b.length > maxWindow ? b.slice(0, maxWindow) : b;
  const n = left.length;
  const m = right.length;
  let prev = new Array<number>(m + 1).fill(0);
  let curr = new Array<number>(m + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (left[i - 1] === right[j - 1]) {
        curr[j] = prev[j - 1] + 1;
        if (curr[j] > best) best = curr[j];
      } else {
        curr[j] = 0;
      }
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
    curr.fill(0);
  }
  return best;
}

function prefixSimilarity(a: string, b: string, prefixLen = 120): number {
  if (!a || !b) return 0;
  const left = a.slice(0, prefixLen);
  const right = b.slice(0, prefixLen);
  if (!left || !right) return 0;
  let match = 0;
  const len = Math.min(left.length, right.length);
  for (let i = 0; i < len; i++) {
    if (left[i] === right[i]) match += 1;
  }
  return match / Math.max(left.length, right.length, 1);
}

/**
 * Detect when an audit response is essentially a rewrite / echo of the draft.
 */
export function detectDraftEcho(
  auditText: string,
  draftText: string,
): DraftEchoCheckResult {
  const audit = (auditText || '').trim();
  const draft = (draftText || '').trim();
  if (!audit || !draft) {
    return { isEcho: false, similarity: 0 };
  }

  const lengthRatio = audit.length / Math.max(draft.length, 1);
  const shared = longestSharedSegmentLength(audit, draft);
  const prefix = prefixSimilarity(audit, draft);
  const similarity = Math.max(
    prefix,
    shared / Math.max(Math.min(audit.length, draft.length), 1),
  );

  // Short drafts: prefer structure checks; only flag extreme copy.
  if (draft.length < AUDIT_ECHO_THRESHOLDS.SHORT_DRAFT_CHARS) {
    if (
      shared >= Math.min(draft.length, AUDIT_ECHO_THRESHOLDS.LONG_SHARED_SEGMENT_CHARS) &&
      lengthRatio >= 0.9
    ) {
      return {
        isEcho: true,
        similarity,
        longestSharedSegment: shared,
        reason: 'short_draft_near_copy',
      };
    }
    return { isEcho: false, similarity, longestSharedSegment: shared };
  }

  if (shared >= AUDIT_ECHO_THRESHOLDS.LONG_SHARED_SEGMENT_CHARS) {
    return {
      isEcho: true,
      similarity,
      longestSharedSegment: shared,
      reason: 'long_shared_segment',
    };
  }

  if (
    lengthRatio >= AUDIT_ECHO_THRESHOLDS.AUDIT_TO_DRAFT_LENGTH_RATIO &&
    (prefix >= 0.7 || similarity >= 0.55)
  ) {
    return {
      isEcho: true,
      similarity,
      longestSharedSegment: shared,
      reason: 'length_and_prefix_match',
    };
  }

  // Continuous novel prose (no JSON markers) that is long vs draft.
  const looksLikeProse =
    !audit.includes('{') &&
    audit.length >= draft.length * 0.5 &&
    audit.length >= 400;
  if (looksLikeProse && (prefix >= 0.5 || similarity >= 0.4)) {
    return {
      isEcho: true,
      similarity,
      longestSharedSegment: shared,
      reason: 'prose_novel_output',
    };
  }

  return { isEcho: false, similarity, longestSharedSegment: shared };
}

interface ExtractedJson {
  jsonText: string | null;
  surroundingProseLength: number;
  truncatedLikely: boolean;
}

/**
 * Extract JSON for audit stages. Unlike raw extractJSON, also measures prose
 * outside the JSON payload and detects likely truncation.
 */
export function extractAuditJsonPayload(raw: string): ExtractedJson {
  const text = (raw || '').trim();
  if (!text) {
    return { jsonText: null, surroundingProseLength: 0, truncatedLikely: false };
  }

  const extracted = extractJSON(text);
  if (!extracted) {
    // Unbalanced braces → likely truncated JSON.
    const open = (text.match(/\{/g) || []).length;
    const close = (text.match(/\}/g) || []).length;
    const truncatedLikely = open > close || /[,:]\s*$/.test(text);
    return {
      jsonText: null,
      surroundingProseLength: text.length,
      truncatedLikely,
    };
  }

  // Measure non-JSON surrounding prose (after stripping fences / think blocks).
  let residual = text
    .replace(/<think[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?\s*\n?[\s\S]*?\n?\s*```/gi, ' ')
    .replace(extracted, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Drop short labels like "说明：" that models sometimes prepend.
  residual = residual.replace(/^[\u4e00-\u9fff\w\s:：.-]{0,40}$/u, '').trim();

  return {
    jsonText: extracted,
    surroundingProseLength: residual.length,
    truncatedLikely: false,
  };
}

function precheckContent(
  result: LLMResult,
): AuditValidationResult<never> | null {
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
    return fail('reasoning_only', 'content 为空，仅返回 reasoning_content');
  }
  if (!text) {
    return fail('empty_content', 'content 为空');
  }
  return null;
}

function checkOversizedItems(
  texts: string[],
): AuditValidationResult<never> | null {
  for (const t of texts) {
    if (t.length > AUDIT_ECHO_THRESHOLDS.MAX_SINGLE_AUDIT_ITEM_CHARS) {
      return fail(
        'oversized_report',
        `单项过长 (${t.length} 字)，疑似塞入整篇正文`,
      );
    }
  }
  return null;
}

/**
 * Scan every string leaf in the parsed JSON for draft echo / oversized body.
 */
function checkRecursiveDraftEcho(
  parsed: unknown,
  draftText: string,
): AuditValidationResult<never> | null {
  const allStrings: string[] = [];
  collectAllStrings(parsed, allStrings);
  const oversized = checkOversizedItems(allStrings);
  if (oversized) return oversized;

  const bodyBlob = allStrings.join('\n');
  if (!bodyBlob) {
    return null;
  }
  const echo = detectDraftEcho(bodyBlob, draftText);
  if (echo.isEcho) {
    return fail('draft_echo', echo.reason, { similarity: echo.similarity });
  }
  // Also flag individual long strings that highly overlap the draft even when
  // the joined blob dilutes the ratio (e.g. short legitimate fields + one
  // stuffed full-body extra field already rejected by top-level whitelist, but
  // nested stuffing in allowed paths still needs coverage).
  for (const s of allStrings) {
    if (s.length < Math.min(200, Math.floor((draftText || '').length * 0.4))) {
      continue;
    }
    const one = detectDraftEcho(s, draftText);
    if (one.isEcho) {
      return fail('draft_echo', one.reason || 'nested_field_draft_echo', {
        similarity: one.similarity,
      });
    }
  }
  return null;
}

/**
 * Validate literary review LLM output. Only valid structured reports pass.
 */
export function validateReviewResult(
  result: LLMResult,
  draftText: string,
): AuditValidationResult<ReviewReport> {
  const pre = precheckContent(result);
  if (pre) return pre as AuditValidationResult<ReviewReport>;

  const rawText = result.text!.trim();

  // Full prose / draft echo before JSON parse (catches pure novel output).
  const echoEarly = detectDraftEcho(rawText, draftText);
  if (echoEarly.isEcho && !rawText.trimStart().startsWith('{') && !rawText.includes('"strengths"')) {
    return fail('draft_echo', echoEarly.reason, {
      similarity: echoEarly.similarity,
    });
  }
  if (
    !rawText.includes('{') &&
    rawText.length >= Math.max(400, (draftText || '').length * 0.5)
  ) {
    return fail('novel_output', '输出为连续正文而非 JSON 报告');
  }

  const extracted = extractAuditJsonPayload(rawText);
  if (!extracted.jsonText) {
    if (
      result.finishReason === 'length' ||
      extracted.truncatedLikely
    ) {
      return fail('truncated_output', 'JSON 不完整或被截断');
    }
    return fail('invalid_json', '无法解析为 JSON 对象');
  }

  if (
    extracted.surroundingProseLength >
    AUDIT_ECHO_THRESHOLDS.MAX_SURROUNDING_PROSE_CHARS
  ) {
    return fail(
      'novel_output',
      `JSON 围栏外存在长篇正文 (${extracted.surroundingProseLength} 字)`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted.jsonText);
  } catch {
    if (result.finishReason === 'length' || extracted.truncatedLikely) {
      return fail('truncated_output', 'JSON 解析失败且 finishReason=length');
    }
    return fail('invalid_json', 'JSON.parse 失败');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail('unexpected_shape', '根节点不是 JSON 对象');
  }

  const obj = parsed as Record<string, unknown>;

  const whitelistError = checkTopLevelWhitelist(obj, REVIEW_TOP_LEVEL_KEYS);
  if (whitelistError) {
    return fail('unexpected_shape', whitelistError);
  }

  if (
    !('strengths' in obj) ||
    !('issues' in obj) ||
    !('suggestions' in obj)
  ) {
    return fail(
      'missing_required_fields',
      '缺少 strengths / issues / suggestions',
    );
  }

  // Recursively scan ALL string leaves (including any nested content) before
  // trusting normalized arrays — catches stuffed body in nested structures.
  const recursiveEcho = checkRecursiveDraftEcho(parsed, draftText);
  if (recursiveEcho) {
    return recursiveEcho as AuditValidationResult<ReviewReport>;
  }

  const strengths = normalizeStringArrayStrict(obj.strengths);
  if (!strengths.ok) {
    return fail(
      'unexpected_shape',
      `strengths: ${strengths.details}`,
    );
  }
  const issues = normalizeStringArrayStrict(obj.issues);
  if (!issues.ok) {
    return fail('unexpected_shape', `issues: ${issues.details}`);
  }
  const suggestions = normalizeStringArrayStrict(obj.suggestions);
  if (!suggestions.ok) {
    return fail(
      'unexpected_shape',
      `suggestions: ${suggestions.details}`,
    );
  }

  const report: ReviewReport = {
    strengths: strengths.items,
    issues: issues.items,
    suggestions: suggestions.items,
  };
  const normalizedText = JSON.stringify(report);

  if (normalizedText.length > AUDIT_ECHO_THRESHOLDS.MAX_REPORT_CHARS) {
    return fail('oversized_report', '报告整体过长');
  }

  const bodyBlob = [
    ...report.strengths,
    ...report.issues,
    ...report.suggestions,
  ].join('\n');
  const echo = detectDraftEcho(bodyBlob, draftText);
  if (echo.isEcho) {
    return fail('draft_echo', echo.reason, { similarity: echo.similarity });
  }

  // finishReason length is OK only when JSON fully parsed above.
  return {
    valid: true,
    report,
    normalizedText,
    similarity: echo.similarity,
  };
}

/**
 * Validate fact-check LLM output. Accepts string or object array items.
 */
export function validateFactCheckResult(
  result: LLMResult,
  draftText: string,
): AuditValidationResult<FactCheckReport> {
  const pre = precheckContent(result);
  if (pre) return pre as AuditValidationResult<FactCheckReport>;

  const rawText = result.text!.trim();

  const echoEarly = detectDraftEcho(rawText, draftText);
  if (
    echoEarly.isEcho &&
    !rawText.trimStart().startsWith('{') &&
    !rawText.includes('"errors"')
  ) {
    return fail('draft_echo', echoEarly.reason, {
      similarity: echoEarly.similarity,
    });
  }
  if (
    !rawText.includes('{') &&
    rawText.length >= Math.max(400, (draftText || '').length * 0.5)
  ) {
    return fail('novel_output', '输出为连续正文而非 JSON 报告');
  }

  const extracted = extractAuditJsonPayload(rawText);
  if (!extracted.jsonText) {
    if (result.finishReason === 'length' || extracted.truncatedLikely) {
      return fail('truncated_output', 'JSON 不完整或被截断');
    }
    return fail('invalid_json', '无法解析为 JSON 对象');
  }

  if (
    extracted.surroundingProseLength >
    AUDIT_ECHO_THRESHOLDS.MAX_SURROUNDING_PROSE_CHARS
  ) {
    return fail(
      'novel_output',
      `JSON 围栏外存在长篇正文 (${extracted.surroundingProseLength} 字)`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted.jsonText);
  } catch {
    if (result.finishReason === 'length' || extracted.truncatedLikely) {
      return fail('truncated_output', 'JSON 解析失败且 finishReason=length');
    }
    return fail('invalid_json', 'JSON.parse 失败');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail('unexpected_shape', '根节点不是 JSON 对象');
  }

  const obj = parsed as Record<string, unknown>;

  const whitelistError = checkTopLevelWhitelist(obj, FACT_CHECK_TOP_LEVEL_KEYS);
  if (whitelistError) {
    return fail('unexpected_shape', whitelistError);
  }

  if (!('errors' in obj) || !('warnings' in obj) || !('confirmed' in obj)) {
    return fail(
      'missing_required_fields',
      '缺少 errors / warnings / confirmed',
    );
  }

  const recursiveEcho = checkRecursiveDraftEcho(parsed, draftText);
  if (recursiveEcho) {
    return recursiveEcho as AuditValidationResult<FactCheckReport>;
  }

  const errors = normalizeFactArrayStrict(obj.errors);
  if (!errors.ok) {
    return fail('unexpected_shape', `errors: ${errors.details}`);
  }
  const warnings = normalizeFactArrayStrict(obj.warnings);
  if (!warnings.ok) {
    return fail('unexpected_shape', `warnings: ${warnings.details}`);
  }
  const confirmed = normalizeFactArrayStrict(obj.confirmed);
  if (!confirmed.ok) {
    return fail('unexpected_shape', `confirmed: ${confirmed.details}`);
  }

  for (const item of [...errors.items, ...warnings.items, ...confirmed.items]) {
    if (itemTextLength(item) > AUDIT_ECHO_THRESHOLDS.MAX_SINGLE_AUDIT_ITEM_CHARS) {
      return fail(
        'oversized_report',
        '单项过长，疑似把整篇正文塞入核查字段',
      );
    }
  }

  const report: FactCheckReport = {
    errors: errors.items,
    warnings: warnings.items,
    confirmed: confirmed.items,
  };
  const normalizedText = JSON.stringify(report);

  if (normalizedText.length > AUDIT_ECHO_THRESHOLDS.MAX_REPORT_CHARS) {
    return fail('oversized_report', '报告整体过长');
  }

  const allTexts: string[] = [];
  for (const item of [...report.errors, ...report.warnings, ...report.confirmed]) {
    if (typeof item === 'string') {
      allTexts.push(item);
    } else {
      allTexts.push(item.description);
      if (item.draftQuote) allTexts.push(item.draftQuote);
      if (item.evidence) allTexts.push(item.evidence);
    }
  }

  const bodyBlob = allTexts.join('\n');
  const echo = detectDraftEcho(bodyBlob, draftText);
  if (echo.isEcho) {
    return fail('draft_echo', echo.reason, { similarity: echo.similarity });
  }

  return {
    valid: true,
    report,
    normalizedText,
    similarity: echo.similarity,
  };
}

/** Short Chinese label for repair prompts / logs (SPEC §12.4). */
export function describeAuditFailureReason(
  reason?: AuditValidationFailureReason,
): string {
  switch (reason) {
    case 'empty_content':
      return '输出为空';
    case 'reasoning_only':
      return '仅返回推理过程';
    case 'invalid_json':
      return '非合法 JSON';
    case 'missing_required_fields':
      return '缺少必要字段';
    case 'draft_echo':
      return '初稿回显';
    case 'truncated_output':
      return '输出被截断';
    case 'oversized_report':
      return '报告过长或单项塞入正文';
    case 'novel_output':
      return '输出了完整正文';
    case 'unexpected_shape':
      return '结构不符合要求';
    default:
      return '输出格式无效';
  }
}

/** Human-readable Chinese error for stage cards / notifications. */
export function formatAuditFailureMessage(
  stage: 'review' | 'factCheck',
  reason?: AuditValidationFailureReason,
): string {
  const base =
    stage === 'review' ? '文学评估返回格式无效' : '事实核查返回格式无效';
  if (!reason) return base;
  return `${base}（${describeAuditFailureReason(reason)}）`;
}

export function logPipelineAudit(fields: {
  stage: 'review' | 'factCheck';
  attempt: number;
  valid: boolean;
  reason?: AuditValidationFailureReason;
  textLength?: number;
  reasoningLength?: number;
  finishReason?: string | null;
  similarity?: number;
  retry?: boolean;
  taskId?: string;
}): void {
  const parts = [
    '[pipeline-audit]',
    `stage=${fields.stage}`,
    fields.retry ? 'retry=true' : `attempt=${fields.attempt}`,
    `valid=${fields.valid}`,
  ];
  if (fields.reason) parts.push(`reason=${fields.reason}`);
  if (fields.taskId) parts.push(`taskId=${fields.taskId}`);
  if (fields.textLength != null) parts.push(`textLength=${fields.textLength}`);
  if (fields.reasoningLength != null) {
    parts.push(`reasoningLength=${fields.reasoningLength}`);
  }
  if (fields.finishReason) parts.push(`finishReason=${fields.finishReason}`);
  if (fields.similarity != null) {
    parts.push(`similarity=${fields.similarity.toFixed(3)}`);
  }
  // Never log full body / reasoning / keys.
  console.log(parts.join(' '));
}
