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

  // Hard world rules: if locked rule keywords are violated by negation patterns.
  for (const rule of snapshot.bundles.canon.worldRules) {
    if (rule.constraintLevel !== 'hard' && rule.reviewStatus !== 'locked') {
      continue;
    }
    if (levelOff(settings, 'world')) continue;
    // If text claims resurrection while policy forbids.
    if (
      settings.resurrectionPolicy === 'forbid' &&
      /复活|起死回生|死而复生/.test(artifactText)
    ) {
      const m = artifactText.match(/复活|起死回生|死而复生/);
      const idx = m?.index ?? 0;
      issues.push({
        category: 'world',
        subtype: 'resurrection_forbidden',
        severity: 'blocking',
        confidence: 0.9,
        generatedStart: idx,
        generatedEnd: idx + (m?.[0].length ?? 2),
        generatedExcerpt: m?.[0] ?? '复活',
        description: `复活被项目策略禁止；相关硬规则：${rule.title}`,
        evidenceIds: [],
        suggestedFix: '移除复活情节',
      });
      break;
    }
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

  // Long consecutive overlap with seam excerpt.
  const seam = snapshot.bundles.seam?.excerpt || '';
  if (seam.length >= 24 && artifactText.length >= 24) {
    const overlap = longestCommonSubstringLength(seam, artifactText, 80);
    if (overlap >= 24) {
      const idx = artifactText.indexOf(seam.slice(0, Math.min(12, seam.length)));
      issues.push({
        category: 'style',
        subtype: 'source_overlap',
        severity: overlap >= 40 ? 'error' : 'warning',
        confidence: 0.7,
        generatedStart: idx >= 0 ? idx : null,
        generatedEnd: idx >= 0 ? idx + Math.min(overlap, 40) : null,
        generatedExcerpt:
          idx >= 0
            ? artifactText.slice(idx, idx + Math.min(overlap, 40))
            : '',
        description: `与原著接缝存在约 ${overlap} 字连续重合，疑似复制原文`,
        evidenceIds: [],
        suggestedFix: '删除或改写与原著连续重合的片段',
      });
    }
  }

  return issues;
}

export function parseCheckerLlmJson(raw: string): RawCheckIssue[] {
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
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.issues)
      ? parsed.issues
      : null;
  if (!list) throw new Error('Checker JSON 缺少 issues 数组');

  const out: RawCheckIssue[] = [];
  for (const item of list) {
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
    // No evidence → force warning at most
    let sev = severity as RawCheckIssue['severity'];
    if (evidenceIds.length === 0 && (sev === 'error' || sev === 'blocking')) {
      sev = 'warning';
    }
    out.push({
      category: item.category,
      subtype: String(item.subtype ?? 'general'),
      severity: sev,
      confidence,
      generatedStart: start,
      generatedEnd: end,
      generatedExcerpt: String(item.generatedExcerpt ?? ''),
      description: String(item.description ?? ''),
      entityRefType: item.entityRefType ?? null,
      entityRefId:
        item.entityRefId != null ? String(item.entityRefId) : null,
      evidenceIds,
      suggestedFix: item.suggestedFix != null ? String(item.suggestedFix) : null,
    });
  }
  return out;
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
      } else if (!generatedExcerpt) {
        generatedExcerpt = artifactText.slice(generatedStart, generatedEnd);
      }
    }
    const filtered = (evidenceIds ?? []).filter(id => allowedEvidenceIds.has(id));
    let severity = issue.severity;
    if (
      filtered.length === 0 &&
      (severity === 'error' || severity === 'blocking')
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
  return issues.filter(i => !levelOff(settings, i.category));
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
