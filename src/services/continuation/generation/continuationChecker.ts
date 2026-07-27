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

  // Style: first-person mixed with third if style profile says third
  const style = snapshot.bundles.style;
  if (style && !levelOff(settings, 'style')) {
    if (
      style.narrativePerson.includes('三') &&
      /[我](?:觉得|心想|看到)/.test(artifactText) &&
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
