/**
 * Continuity Checker — structured issues bound to artifact hash + UTF-16 ranges.
 * Spec §9.3. Supports deterministic local checks + optional LLM JSON.
 */
import { stripModelJson } from '../canon/canonJsonValidators';
import type {
  CheckCategory,
  ContinuationCheckResult,
  ContinuationContextSnapshot,
  ContinuationGenerationSettings,
} from './types';
import {
  evaluateContinuationLength,
  isContinuationLengthIssueSubtype,
  resolveContinuationLengthContract,
} from './continuationLengthContract';

export interface RawCheckIssue {
  category: CheckCategory;
  subtype: string;
  severity: 'info' | 'warning' | 'error' | 'blocking';
  confidence: number;
  generatedStart: number | null;
  generatedEnd: number | null;
  generatedExcerpt: string;
  description: string;
  entityRefType?: string | null;
  entityRefId?: string | null;
  evidenceIds?: number[];
  suggestedFix?: string | null;
}

/**
 * A Checker issue is repair-ready only when Repair can locate the affected
 * text and has a concrete action to perform. Severity alone is not enough:
 * an abstract warning must remain an audit note instead of becoming a fake
 * "applied" checkbox in the single Repair call.
 */
export function isRepairableCheckerIssue(
  issue: Pick<
    RawCheckIssue,
    | 'severity'
    | 'generatedStart'
    | 'generatedEnd'
    | 'generatedExcerpt'
    | 'suggestedFix'
  >,
): boolean {
  if (issue.severity === 'info') return false;
  const hasRange =
    typeof issue.generatedStart === 'number' &&
    typeof issue.generatedEnd === 'number' &&
    issue.generatedStart >= 0 &&
    issue.generatedEnd > issue.generatedStart;
  const hasExcerpt = (issue.generatedExcerpt ?? '').trim().length >= 4;
  return Boolean(issue.suggestedFix?.trim()) && (hasRange || hasExcerpt);
}

const CATEGORIES: CheckCategory[] = [
  'world',
  'character',
  'relationship',
  'plot',
  'experience',
  'knowledge',
  'timeline',
  'style',
];


function levelOff(
  settings: ContinuationGenerationSettings,
  cat: CheckCategory,
): boolean {
  const map: Record<CheckCategory, string> = {
    world: settings.worldRuleLevel,
    character: settings.characterLevel,
    relationship: settings.relationshipLevel,
    plot: settings.plotLevel,
    experience: settings.experienceLevel,
    knowledge: settings.knowledgeLevel,
    timeline: settings.worldRuleLevel,
    style: settings.styleLevel,
  };
  return map[cat] === 'off';
}

/** Deterministic local checks (no LLM) — always run. */
export function runDeterministicChecks(
  artifactText: string,
  snapshot: ContinuationContextSnapshot,
): RawCheckIssue[] {
  const issues: RawCheckIssue[] = [];
  const settings = snapshot.settingsSnapshot.values;

  const lengthContract = resolveContinuationLengthContract(
    settings.targetChapterChars,
  );
  const lengthEvaluation = evaluateContinuationLength(
    artifactText,
    lengthContract,
  );
  if (lengthEvaluation.status !== 'within') {
    const under = lengthEvaluation.status === 'under';
    issues.push({
      category: 'style',
      subtype: under
        ? 'chapter_length_under_target'
        : 'chapter_length_over_target',
      severity: 'error',
      confidence: 1,
      generatedStart: null,
      generatedEnd: null,
      generatedExcerpt: '',
      description: under
        ? `正文含汉字 ${lengthEvaluation.actualHanCharacters} 个，低于本次允许下限 ${lengthContract.minHanCharacters}；目标为 ${lengthContract.targetHanCharacters}。`
        : `正文含汉字 ${lengthEvaluation.actualHanCharacters} 个，高于本次允许上限 ${lengthContract.maxHanCharacters}；目标为 ${lengthContract.targetHanCharacters}。`,
      evidenceIds: [],
      suggestedFix: under
        ? `在保留完整事件链的基础上自然扩写约 ${Math.max(
            1,
            lengthContract.targetHanCharacters -
              lengthEvaluation.actualHanCharacters,
          )} 个汉字，最终保持在 ${lengthContract.minHanCharacters}–${lengthContract.maxHanCharacters} 个汉字。`
        : `优先压缩重复描写、重复心理和不推进剧情的对话，减少约 ${Math.max(
            1,
            lengthEvaluation.actualHanCharacters -
              lengthContract.targetHanCharacters,
          )} 个汉字，最终保持在 ${lengthContract.minHanCharacters}–${lengthContract.maxHanCharacters} 个汉字。`,
    });
  }

  // Future leakage markers in generated text (test fixture convention).
  const futureMarkers = [
    '【未来揭示】',
    'FUTURE_SOURCE_LEAK',
    'BOUNDARY_AFTER_SECRET',
  ];
  for (const marker of futureMarkers) {
    const idx = artifactText.indexOf(marker);
    if (idx >= 0) {
      issues.push({
        category: 'plot',
        subtype: 'future_leakage',
        severity: 'blocking',
        confidence: 1,
        generatedStart: idx,
        generatedEnd: idx + marker.length,
        generatedExcerpt: artifactText.slice(idx, idx + marker.length),
        description: '正文疑似包含原著边界之后信息',
        evidenceIds: [],
        suggestedFix: '删除未来揭示内容',
      });
    }
  }

  // H6 修复：resurrection 检查原嵌在 worldRules 循环里，若项目无任何
  // hard/locked 规则，即使 resurrectionPolicy='forbid' 也永远不会执行。
  // 抽出来独立检查；worldRules 只用于附上相关规则名到 description。
  if (
    !levelOff(settings, 'world') &&
    settings.resurrectionPolicy === 'forbid' &&
    /复活|起死回生|死而复生/.test(artifactText)
  ) {
    const m = artifactText.match(/复活|起死回生|死而复生/);
    const idx = m?.index ?? 0;
    // 找一条相关的 hard/locked 规则名用于描述，没有就用通用文案。
    const relatedRule = snapshot.bundles.canon.worldRules.find(
      r => r.constraintLevel === 'hard' || r.reviewStatus === 'locked',
    );
    issues.push({
      category: 'world',
      subtype: 'resurrection_forbidden',
      severity: 'blocking',
      confidence: 0.9,
      generatedStart: idx,
      generatedEnd: idx + (m?.[0].length ?? 2),
      generatedExcerpt: m?.[0] ?? '复活',
      description: relatedRule
        ? `复活被项目策略禁止；相关硬规则：${relatedRule.title}`
        : '复活被项目策略禁止',
      evidenceIds: [],
      suggestedFix: '移除复活情节',
    });
  }

  // Hard world rules: if locked rule keywords are violated by negation patterns.
  for (const rule of snapshot.bundles.canon.worldRules) {
    if (rule.constraintLevel !== 'hard' && rule.reviewStatus !== 'locked') {
      continue;
    }
    if (levelOff(settings, 'world')) continue;
  }

  // Knowledge boundary: if text has character knowing FUTURE secrets list
  for (const k of snapshot.bundles.effectiveState.knowledge) {
    if (levelOff(settings, 'knowledge')) break;
    if (k.knowledgeState === 'unknown' && k.factSummary) {
      // crude: if fact summary substring appears as "知道了X"
      const needle = k.factSummary.slice(0, 12);
      if (needle.length >= 4 && artifactText.includes(`知道了${needle}`)) {
        const idx = artifactText.indexOf(`知道了${needle}`);
        issues.push({
          category: 'knowledge',
          subtype: 'knowledge_violation',
          severity: 'error',
          confidence: 0.7,
          generatedStart: idx,
          generatedEnd: idx + 4 + needle.length,
          generatedExcerpt: artifactText.slice(idx, idx + 4 + needle.length),
          description: `人物可能知道了其不应知晓的信息：${k.factKey}`,
          entityRefType: k.ref.refType,
          entityRefId: String(k.ref.id),
          evidenceIds: [],
          suggestedFix: '改为未知或误解状态',
        });
      }
    }
  }

  // Style drift heuristics from frozen thin metrics / V2 narrative hints.
  // Skip gracefully when metrics are missing (Spec §8.3 deterministic subset).
  if (!levelOff(settings, 'style')) {
    issues.push(...runStyleDriftChecks(artifactText, snapshot));
  }

  issues.push(...runAnchorOverlapChecks(artifactText, snapshot));

  return issues;
}

/** Rough sentence split for CJK + ASCII terminals (UTF-16 length aware). */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?…])\s*/)
    .map(s => s.trim())
    .filter(Boolean);
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n|\r\n\s*\r\n/)
    .map(p => p.trim())
    .filter(Boolean);
}

function dialogueCharRatio(text: string): number {
  if (!text) return 0;
  // Count chars inside Chinese or ASCII quotation marks.
  let inQuote = false;
  let dialogueChars = 0;
  for (const ch of text) {
    if (ch === '“' || ch === '「' || ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (ch === '”' || ch === '」') {
      inQuote = false;
      continue;
    }
    if (inQuote) dialogueChars += 1;
  }
  return dialogueChars / Math.max(1, text.length);
}

/** Common AI-ish template openers / transitions in Chinese web-novel output. */
const AI_TEMPLATE_PHRASES = [
  '不禁心中一动',
  '与此同时',
  '值得一提的是',
  '总而言之',
  '综上所述',
  '他深吸一口气',
  '她深吸一口气',
  '就在这时',
  '话音刚落',
  '令人意外的是',
  '不可否认',
  '毫无疑问',
];

function longestCommonSubstringLength(a: string, b: string, cap = 80): number {
  // Bounded DP for short excerpts only — avoid O(n*m) blowups.
  const s = a.length > 400 ? a.slice(-400) : a;
  const t = b.length > 400 ? b.slice(0, 400) : b;
  if (!s || !t) return 0;
  let best = 0;
  let prev = new Array(t.length + 1).fill(0);
  let cur = new Array(t.length + 1).fill(0);
  for (let i = 1; i <= s.length; i++) {
    for (let j = 1; j <= t.length; j++) {
      if (s[i - 1] === t[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
        if (best >= cap) return best;
      } else {
        cur[j] = 0;
      }
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
    cur.fill(0);
  }
  return best;
}

function runStyleDriftChecks(
  artifactText: string,
  snapshot: ContinuationContextSnapshot,
): RawCheckIssue[] {
  const issues: RawCheckIssue[] = [];
  const style = snapshot.bundles.style;
  const frozenPerson =
    typeof (snapshot.style?.frozenProfile as any)?.global?.narrative?.person ===
    'string'
      ? String((snapshot.style!.frozenProfile as any).global.narrative.person)
      : '';
  const narrativePerson = style?.narrativePerson || frozenPerson;

  if (
    narrativePerson.includes('三') &&
    /我(?:觉得|心想|看到|听见)/.test(artifactText) &&
    /他|她|其/.test(artifactText)
  ) {
    issues.push({
      category: 'style',
      subtype: 'pov_shift',
      severity: 'warning',
      confidence: 0.5,
      generatedStart: null,
      generatedEnd: null,
      generatedExcerpt: '',
      description: '疑似视角在第一人称与第三人称之间切换（推测，无强证据）',
      evidenceIds: [],
      suggestedFix: '统一叙事人称',
    });
  }

  // Tense drift: sudden dense present-tense first person if profile leans past narrative.
  const frozenTense =
    typeof (snapshot.style?.frozenProfile as any)?.global?.narrative
      ?.tenseAndTimeHandling === 'string'
      ? String(
          (snapshot.style!.frozenProfile as any).global.narrative
            .tenseAndTimeHandling,
        )
      : style?.tense || '';
  if (
    /过去|叙述|回顾/.test(frozenTense) &&
    (artifactText.match(/着$/gm) || []).length === 0 &&
    /现在|此刻|正在/.test(artifactText) &&
    (artifactText.match(/正在/g) || []).length >= 3
  ) {
    issues.push({
      category: 'style',
      subtype: 'tense_drift',
      severity: 'info',
      confidence: 0.4,
      generatedStart: null,
      generatedEnd: null,
      generatedExcerpt: '',
      description: '正文出现较密集的“正在/此刻”表述，可能与原著时态处理偏移',
      evidenceIds: [],
      suggestedFix: '检查时态与时间处理是否贴近原著',
    });
  }

  // Sentence / paragraph length rough offset vs frozen metrics.
  if (style && style.averageSentenceLength > 0) {
    const sentences = splitSentences(artifactText);
    if (sentences.length >= 4) {
      const avg =
        sentences.reduce((s, x) => s + x.length, 0) / sentences.length;
      const target = style.averageSentenceLength;
      if (target > 0 && (avg > target * 2.2 || avg < target * 0.35)) {
        issues.push({
          category: 'style',
          subtype: 'sentence_length',
          severity: 'warning',
          confidence: 0.45,
          generatedStart: null,
          generatedEnd: null,
          generatedExcerpt: '',
          description: `均句长约 ${avg.toFixed(1)}，与原著参考 ${target.toFixed(1)} 明显偏移`,
          evidenceIds: [],
          suggestedFix: '调整句长分布以贴近原著节奏',
        });
      }
    }
  }

  if (style && style.averageParagraphLength > 0) {
    const paragraphs = splitParagraphs(artifactText);
    if (paragraphs.length >= 2) {
      const avg =
        paragraphs.reduce((s, x) => s + x.length, 0) / paragraphs.length;
      const target = style.averageParagraphLength;
      if (target > 0 && (avg > target * 2.5 || avg < target * 0.3)) {
        issues.push({
          category: 'style',
          subtype: 'paragraph_length',
          severity: 'info',
          confidence: 0.4,
          generatedStart: null,
          generatedEnd: null,
          generatedExcerpt: '',
          description: `均段长约 ${avg.toFixed(1)}，与原著参考 ${target.toFixed(1)} 明显偏移`,
          evidenceIds: [],
          suggestedFix: '调整段落切分以贴近原著',
        });
      }
    }
  }

  if (style && style.dialogueRatio > 0) {
    const ratio = dialogueCharRatio(artifactText);
    const target = style.dialogueRatio;
    if (Math.abs(ratio - target) > 0.35 && artifactText.length > 200) {
      issues.push({
        category: 'style',
        subtype: 'dialogue_ratio',
        severity: 'info',
        confidence: 0.4,
        generatedStart: null,
        generatedEnd: null,
        generatedExcerpt: '',
        description: `对话占比约 ${(ratio * 100).toFixed(0)}%，原著参考约 ${(target * 100).toFixed(0)}%`,
        evidenceIds: [],
        suggestedFix: '调整对白与叙述比例',
      });
    }
  }

  // AI-ish template phrases.
  for (const phrase of AI_TEMPLATE_PHRASES) {
    const idx = artifactText.indexOf(phrase);
    if (idx >= 0) {
      issues.push({
        category: 'style',
        subtype: 'ai_template',
        severity: 'warning',
        confidence: 0.55,
        generatedStart: idx,
        generatedEnd: idx + phrase.length,
        generatedExcerpt: phrase,
        description: `疑似模板化 AI 腔表述：「${phrase}」`,
        evidenceIds: [],
        suggestedFix: '改写为更贴合原著克制/具体的叙述',
      });
      break; // one is enough for deterministic pass
    }
  }

  return issues;
}

/**
 * Anchor-copy detection is a safety gate, not a style preference. It must run
 * even when the user turns ordinary style checks off.
 */
function runAnchorOverlapChecks(
  artifactText: string,
  snapshot: ContinuationContextSnapshot,
): RawCheckIssue[] {
  const issues: RawCheckIssue[] = [];
  // Schema 1 runs use the legacy seam; Schema 2 continuation runs never
  // compare against the original tail because their primary anchor is the
  // prior continuation.
  const anchor = snapshot.primaryAnchor;
  const seam = anchor?.excerpt || snapshot.bundles.seam?.excerpt || '';
  if (seam.length >= 24 && artifactText.length >= 24) {
    const overlap = longestCommonSubstringLength(seam, artifactText, 80);
    const subtype =
      anchor?.kind === 'continuation_chapter'
        ? 'continuation_anchor_overlap'
        : 'source_overlap';
    const sourceLabel =
      subtype === 'source_overlap' ? '原著接缝' : '最近续写接缝';
    if (overlap >= 24) {
      const idx = artifactText.indexOf(
        seam.slice(0, Math.min(12, seam.length)),
      );
      issues.push({
        category: 'style',
        subtype,
        // Any confirmed continuous copy is a safety failure. Keep this local
        // gate independent from the ordinary style level.
        severity: 'error',
        // This is a deterministic local copy detector, not an LLM semantic
        // judgement. A confirmed continuous match is recorded as certainty
        // for the narrow claim "the candidate repeats the frozen seam";
        // Canon/plot/style quality still requires Checker evidence.
        confidence: 1,
        generatedStart: idx >= 0 ? idx : null,
        generatedEnd: idx >= 0 ? idx + Math.min(overlap, 40) : null,
        generatedExcerpt:
          idx >= 0
            ? artifactText.slice(idx, idx + Math.min(overlap, 40))
            : '',
        description: `与${sourceLabel}存在约 ${overlap} 字连续重合，疑似复制接缝正文`,
        evidenceIds: [],
        suggestedFix: '删除或改写与原著连续重合的片段',
      });
    }
  }

  return issues;
}

export interface CheckerLlmEnvelope {
  schemaVersion: number | null;
  /** Model-echoed Writer artifact hash; null when absent. The V4 Runner is the
   * authority that compares this against the actual artifact contentHash and
   * decides whether to adopt the issues. */
  writerArtifactHash: string | null;
  issues: RawCheckIssue[];
}

/**
 * Standardize a raw model issue object to the internal field names BEFORE any
 * severity/evidence downgrade logic runs. This is the only place where legacy
 * field aliases (`draftQuote`/`suggestedAction`/`draftStart`/`draftEnd`/`quote`/
 * `fix`) are tolerated; downstream code only ever sees the standard fields.
 *
 * The legacy Prompt asked models to emit `draftQuote`/`suggestedAction`, while
 * the Parser read `generatedExcerpt`/`suggestedFix`. Without this normalization
 * a model that correctly followed the old Prompt would have its fields dropped,
 * the complete-contract check below would downgrade a legitimate error to a
 * warning, and Repair would never receive the task.
 */
function normalizeRawCheckIssueFields(item: any): any {
  if (!item || typeof item !== 'object') return item;
  const normalized: Record<string, unknown> = { ...item };
  if (
    normalized.generatedExcerpt == null &&
    typeof (normalized as any).draftQuote === 'string'
  ) {
    normalized.generatedExcerpt = (normalized as any).draftQuote;
  }
  if (
    normalized.generatedExcerpt == null &&
    typeof (normalized as any).quote === 'string'
  ) {
    normalized.generatedExcerpt = (normalized as any).quote;
  }
  if (
    normalized.suggestedFix == null &&
    typeof (normalized as any).suggestedAction === 'string'
  ) {
    normalized.suggestedFix = (normalized as any).suggestedAction;
  }
  if (
    normalized.suggestedFix == null &&
    typeof (normalized as any).fix === 'string'
  ) {
    normalized.suggestedFix = (normalized as any).fix;
  }
  if (
    normalized.generatedStart == null &&
    typeof (normalized as any).draftStart === 'number'
  ) {
    normalized.generatedStart = (normalized as any).draftStart;
  }
  if (
    normalized.generatedEnd == null &&
    typeof (normalized as any).draftEnd === 'number'
  ) {
    normalized.generatedEnd = (normalized as any).draftEnd;
  }
  return normalized;
}

function coerceRawIssuesToList(list: any[]): RawCheckIssue[] {
  const out: RawCheckIssue[] = [];
  for (const rawItem of list) {
    // Standardize aliases first, so severity/evidence validation operates on a
    // unified field surface and never downgrades a legitimate error merely
    // because the model followed the legacy Prompt field names.
    const item = normalizeRawCheckIssueFields(rawItem);
    if (!item || typeof item !== 'object') continue;
    if (!CATEGORIES.includes(item.category)) continue;
    const severity = item.severity;
    if (!['info', 'warning', 'error', 'blocking'].includes(severity)) continue;
    let start =
      typeof item.generatedStart === 'number' ? item.generatedStart : null;
    let end = typeof item.generatedEnd === 'number' ? item.generatedEnd : null;
    if (start != null && end != null && !(start >= 0 && end > start)) {
      start = null;
      end = null;
    }
    const confidence = Math.min(
      1,
      Math.max(0, Number(item.confidence) || 0),
    );
    const evidenceIds = Array.isArray(item.evidenceIds)
      ? item.evidenceIds.filter((x: any) => typeof x === 'number')
      : [];
    const description = String(item.description ?? '').trim();
    const suggestedFix =
      item.suggestedFix != null ? String(item.suggestedFix).trim() : '';
    const generatedExcerpt = String(item.generatedExcerpt ?? '').trim();
    // A severe issue must be actionable in the single Repair call: evidence,
    // a location/excerpt, a concrete description, and a suggested fix. If the
    // Checker cannot supply that complete contract, keep it visible as a
    // warning instead of spending the only Repair call on an ambiguous task.
    let sev = severity as RawCheckIssue['severity'];
    if (
      (sev === 'error' || sev === 'blocking') &&
      (evidenceIds.length === 0 ||
        (!generatedExcerpt && (start == null || end == null)) ||
        !description ||
        !suggestedFix)
    ) {
      sev = 'warning';
    }
    out.push({
      category: item.category,
      subtype: String(item.subtype ?? 'general'),
      severity: sev,
      confidence,
      generatedStart: start,
      generatedEnd: end,
      generatedExcerpt,
      description,
      entityRefType: item.entityRefType ?? null,
      entityRefId:
        item.entityRefId != null ? String(item.entityRefId) : null,
      evidenceIds,
      suggestedFix: suggestedFix || null,
    });
  }
  return out;
}

/**
 * Parse the full V4 Checker envelope, including the `writerArtifactHash` echo.
 * The Runner validates the hash against the actual Writer artifact contentHash
 * and drops the issues when they disagree (see `runCheckerNode`).
 */
export function parseCheckerLlmEnvelope(raw: string): CheckerLlmEnvelope {
  const stripped = stripModelJson(raw);
  let parsed: any;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    // one more try: wrap
    try {
      parsed = JSON.parse(`{"issues":${stripped}}`);
    } catch {
      throw new Error('Checker JSON 解析失败');
    }
  }
  const isBareArray = Array.isArray(parsed);
  const issueList = isBareArray
    ? parsed
    : Array.isArray(parsed?.issues)
      ? parsed.issues
      : null;
  if (!issueList) throw new Error('Checker JSON 缺少 issues 数组');
  const warningList = isBareArray
    ? []
    : Array.isArray(parsed?.warnings)
      ? parsed.warnings
      : [];
  // The V4 contract keeps warnings separate from repair-worthy issues. They
  // still need to reach persistence/UI instead of being silently discarded.
  // Force their severity to warning so a model cannot smuggle a warning into
  // the single Repair reservation as an unsupported severe issue.
  const list = [
    ...issueList,
    ...warningList.map((item: unknown) =>
      item && typeof item === 'object'
        ? { ...(item as Record<string, unknown>), severity: 'warning' }
        : item,
    ),
  ];
  const issues = coerceRawIssuesToList(list);
  const hash = !isBareArray && typeof parsed?.writerArtifactHash === 'string'
    ? parsed.writerArtifactHash.trim() || null
    : null;
  const schemaVersion =
    !isBareArray && typeof parsed?.schemaVersion === 'number'
      ? parsed.schemaVersion
      : null;
  return { schemaVersion, writerArtifactHash: hash, issues };
}

/** Backward-compatible wrapper returning only the issues. V1/V2 callers
 * (`continuationGenerationRunner.ts`) keep using this; the alias normalization
 * is a pure improvement for them and does not change the return shape. */
export function parseCheckerLlmJson(raw: string): RawCheckIssue[] {
  return parseCheckerLlmEnvelope(raw).issues;
}

/** Validate UTF-16 ranges against artifact and evidence ids against snapshot. */
export function bindIssuesToArtifact(
  issues: RawCheckIssue[],
  artifactText: string,
  allowedEvidenceIds: Set<number>,
): RawCheckIssue[] {
  return issues.map(issue => {
    let { generatedStart, generatedEnd, generatedExcerpt, evidenceIds } = issue;
    if (generatedStart != null && generatedEnd != null) {
      if (
        generatedStart < 0 ||
        generatedEnd > artifactText.length ||
        generatedEnd <= generatedStart
      ) {
        generatedStart = null;
        generatedEnd = null;
      } else {
        // The range is authoritative for Repair. Replace a hallucinated
        // excerpt with the exact UTF-16 slice that the user can inspect.
        generatedExcerpt = artifactText.slice(generatedStart, generatedEnd);
      }
    } else if (generatedExcerpt) {
      const located = artifactText.indexOf(generatedExcerpt);
      if (located >= 0) {
        generatedStart = located;
        generatedEnd = located + generatedExcerpt.length;
      }
    }
    const filtered = (evidenceIds ?? []).filter(id => allowedEvidenceIds.has(id));
    let severity = issue.severity;
    const localDeterministicGate =
      issue.subtype === 'source_overlap' ||
      issue.subtype === 'continuation_anchor_overlap' ||
      issue.subtype === 'future_leakage' ||
      issue.subtype === 'resurrection_forbidden' ||
      isContinuationLengthIssueSubtype(issue.subtype);
    if (
      filtered.length === 0 &&
      !localDeterministicGate &&
      (severity === 'error' || severity === 'blocking')
    ) {
      severity = 'warning';
    }
    if (
      !localDeterministicGate &&
      (severity === 'error' || severity === 'blocking') &&
      (!generatedExcerpt ||
        generatedStart == null ||
        generatedEnd == null ||
        !issue.description.trim() ||
        !issue.suggestedFix?.trim())
    ) {
      severity = 'warning';
    }
    return {
      ...issue,
      generatedStart,
      generatedEnd,
      generatedExcerpt,
      evidenceIds: filtered,
      severity,
    };
  });
}

export function filterBySettings(
  issues: RawCheckIssue[],
  settings: ContinuationGenerationSettings,
): RawCheckIssue[] {
  return issues.filter(
    i =>
      isContinuationLengthIssueSubtype(i.subtype) ||
      !levelOff(settings, i.category),
  );
}

export function uncheckedCategories(
  settings: ContinuationGenerationSettings,
  ranLlm: boolean,
  capabilities: Record<string, boolean>,
): string[] {
  const out: string[] = [];
  for (const cat of CATEGORIES) {
    if (levelOff(settings, cat)) {
      out.push(`${cat}:off`);
      continue;
    }
    // Map categories to capabilities for display
    if (cat === 'world' && !capabilities.worldRules) out.push(`${cat}:no_capability`);
    if (cat === 'character' && !capabilities.characterProfiles) {
      out.push(`${cat}:no_capability`);
    }
    if (cat === 'relationship' && !capabilities.relationships) {
      out.push(`${cat}:no_capability`);
    }
    if (cat === 'plot' && !capabilities.plotThreads) out.push(`${cat}:no_capability`);
    if (cat === 'experience' && !capabilities.experiences) {
      out.push(`${cat}:no_capability`);
    }
    if (cat === 'knowledge' && !capabilities.knowledgeBoundaries) {
      out.push(`${cat}:no_capability`);
    }
    if (cat === 'timeline' && !capabilities.timelineEvents) {
      out.push(`${cat}:no_capability`);
    }
    if (!ranLlm && cat === 'style') {
      // deterministic may still run
    }
  }
  return out;
}

export type { ContinuationCheckResult };
