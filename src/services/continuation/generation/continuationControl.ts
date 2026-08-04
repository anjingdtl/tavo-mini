/**
 * Continuation V4 Control — original-style consistency review.
 *
 * Length metrics remain local and authoritative for UI soft hints only.
 * expand/compress and expectedDeltaHan no longer drive Repair eligibility.
 * Only precise, evidence-backed, high-confidence style issues with
 * repairReady=true enter the single Repair request.
 */
import {
  countHanCharacters,
  resolveContinuationLengthContract,
  type ContinuationLengthContract,
} from './continuationLengthContract';
import type {
  ContinuationControlAction,
  ContinuationControlFinding,
  ContinuationControlReport,
  ContinuationPlan,
  ContinuationStyleDimension,
  ContinuationStyleIssue,
  ContinuationV4Metrics,
} from './types';

/** Central confidence floor for style issues entering Repair. */
export const STYLE_REPAIR_CONFIDENCE_MIN = 0.75;

/**
 * @deprecated Length progress is no longer a Repair hard gate.
 * Kept as exports so historical imports resolve; always returns 0 for new code paths.
 */
export const CONTROL_PROGRESS_RATIO = 0;
export const CONTROL_PROGRESS_FLOOR_HAN = 0;

/** @deprecated Progress hard gate removed; always returns 0. */
export function requiredControlProgressHan(_requiredDeltaHan: number): number {
  return 0;
}

const STYLE_DIMENSIONS: ContinuationStyleDimension[] = [
  'narrative_voice',
  'pov',
  'sentence_rhythm',
  'dialogue_voice',
  'emotional_expression',
  'description_density',
  'subtext',
  'scene_transition',
  'ai_template',
  'padding',
];

function paragraphRanges(text: string): Array<{ start: number; end: number; value: string }> {
  const ranges: Array<{ start: number; end: number; value: string }> = [];
  const pattern = /[^\r\n]+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const value = match[0].trim();
    if (!value) continue;
    const leading = match[0].indexOf(value);
    const start = match.index + Math.max(0, leading);
    ranges.push({ start, end: start + value.length, value });
  }
  if (!ranges.length && text.trim()) {
    const value = text.trim();
    const start = text.indexOf(value);
    ranges.push({ start, end: start + value.length, value });
  }
  return ranges;
}

function dialogueHanRatio(text: string): number {
  const dialoguePattern = /[“「『"]([\s\S]*?)[”」』"]/g;
  let dialogueText = '';
  let match: RegExpExecArray | null;
  while ((match = dialoguePattern.exec(text)) !== null) {
    dialogueText += match[1];
  }
  const total = countHanCharacters(text);
  return total > 0 ? countHanCharacters(dialogueText) / total : 0;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function normalizedParagraph(value: string): string {
  return value.replace(/[\s，。！？、；：,.!?;:'"“”‘’（）()【】[\]「」『』]/g, '');
}

function duplicateWindows(
  ranges: Array<{ start: number; end: number; value: string }>,
): ContinuationV4Metrics['duplicateWindows'] {
  const groups = new Map<string, Array<{ start: number; end: number }>>();
  for (const range of ranges) {
    const key = normalizedParagraph(range.value);
    if (key.length < 8) continue;
    const group = groups.get(key) ?? [];
    group.push({ start: range.start, end: range.end });
    groups.set(key, group);
  }
  return Array.from(groups.values())
    .filter(group => group.length > 1)
    .map(group => ({
      start: group[0].start,
      end: group[group.length - 1].end,
      count: group.length,
    }));
}

function beatCoverage(
  ranges: Array<{ id: string; value: string }>,
  plan?: ContinuationPlan,
): ContinuationV4Metrics['beatCoverage'] {
  return (plan?.beats ?? []).map((beat, index) => {
    const beatId = `beat_${beat.order || index + 1}`;
    const terms = beat.summary
      .split(/[\s，。！？、；：,.!?;]+/)
      .map(term => term.trim())
      .filter(term => term.length >= 2);
    const paragraphIds = ranges
      .filter(range => terms.some(term => range.value.includes(term)))
      .map(range => range.id);
    return { beatId, paragraphIds };
  });
}

export function buildContinuationControlMetrics(input: {
  text: string;
  target: number | ContinuationLengthContract;
  plan?: ContinuationPlan;
}): ContinuationV4Metrics {
  const contract =
    typeof input.target === 'number'
      ? resolveContinuationLengthContract(input.target)
      : input.target;
  const ranges = paragraphRanges(input.text);
  const paragraphValues = ranges.map(range => countHanCharacters(range.value));
  const actualHanCharacters = countHanCharacters(input.text);
  const paragraphObjects = ranges.map((range, index) => ({
    id: `p_${index + 1}`,
    start: range.start,
    end: range.end,
    hanCharacters: paragraphValues[index],
  }));
  const missingToMinimum = Math.max(
    0,
    contract.minHanCharacters - actualHanCharacters,
  );
  const excessOverMaximum = Math.max(
    0,
    actualHanCharacters - contract.maxHanCharacters,
  );
  return {
    actualHanCharacters,
    targetHanCharacters: contract.targetHanCharacters,
    minHanCharacters: contract.minHanCharacters,
    maxHanCharacters: contract.maxHanCharacters,
    missingToMinimum,
    excessOverMaximum,
    deltaToTarget: actualHanCharacters - contract.targetHanCharacters,
    paragraphs: paragraphObjects,
    dialogueHanRatio: dialogueHanRatio(input.text),
    paragraphLengthDistribution: {
      min: paragraphValues.length ? Math.min(...paragraphValues) : 0,
      max: paragraphValues.length ? Math.max(...paragraphValues) : 0,
      mean: paragraphValues.length
        ? paragraphValues.reduce((sum, value) => sum + value, 0) /
          paragraphValues.length
        : 0,
      median: median(paragraphValues),
    },
    duplicateWindows: duplicateWindows(ranges),
    beatCoverage: beatCoverage(
      paragraphObjects.map((paragraph, index) => ({
        id: paragraph.id,
        value: ranges[index].value,
      })),
      input.plan,
    ),
    insertionBoundaries: Array.from(
      new Set([0, ...paragraphObjects.map(paragraph => paragraph.end)]),
    ).sort((a, b) => a - b),
  };
}

/** Diagnostic length direction for UI only — never a Repair trigger alone. */
export function reportLengthAction(
  metrics: ContinuationV4Metrics,
): ContinuationControlAction {
  if (metrics.missingToMinimum > 0) return 'expand';
  if (metrics.excessOverMaximum > 0) return 'compress';
  return 'keep';
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter(item => typeof item === 'string')
        .map(item => item.trim())
        .filter(Boolean)
    : [];
}

function isStyleDimension(value: unknown): value is ContinuationStyleDimension {
  return (
    typeof value === 'string' &&
    (STYLE_DIMENSIONS as string[]).includes(value)
  );
}

/**
 * A style issue is repair-ready only when it is precise, evidence-backed,
 * high-confidence, and does not demand whole-chapter rewrite or new facts.
 */
export function isStyleIssueRepairReady(
  issue: Pick<
    ContinuationStyleIssue,
    | 'severity'
    | 'confidence'
    | 'generatedStart'
    | 'generatedEnd'
    | 'generatedExcerpt'
    | 'styleEvidenceIds'
    | 'rewriteGoal'
    | 'preserveMeaning'
    | 'description'
  >,
): boolean {
  if (issue.severity !== 'error') return false;
  if (
    !Number.isFinite(issue.confidence) ||
    issue.confidence < STYLE_REPAIR_CONFIDENCE_MIN
  ) {
    return false;
  }
  const hasRange =
    typeof issue.generatedStart === 'number' &&
    typeof issue.generatedEnd === 'number' &&
    issue.generatedStart >= 0 &&
    issue.generatedEnd > issue.generatedStart;
  const hasExcerpt = (issue.generatedExcerpt ?? '').trim().length >= 4;
  if (!hasRange && !hasExcerpt) return false;
  if (!issue.styleEvidenceIds?.length) return false;
  const rewriteGoal = (issue.rewriteGoal ?? '').trim();
  if (!rewriteGoal) return false;
  if (!issue.preserveMeaning?.length) return false;
  if (!issue.description?.trim()) return false;
  // Reject whole-chapter / new-fact demands — audit only.
  if (
    /整章|全文重构|全部重写|重新创作|新增事实|补写剧情|重构整章/.test(
      rewriteGoal,
    )
  ) {
    return false;
  }
  return true;
}

function styleIssueToFinding(
  issue: ContinuationStyleIssue,
): ContinuationControlFinding {
  return {
    findingId: issue.findingId,
    subtype: issue.styleDimension,
    severity: issue.repairReady ? 'error' : 'warning',
    location:
      issue.generatedStart != null && issue.generatedEnd != null
        ? `utf16:${issue.generatedStart}-${issue.generatedEnd}`
        : issue.styleDimension,
    generatedStart: issue.generatedStart,
    generatedEnd: issue.generatedEnd,
    generatedExcerpt: issue.generatedExcerpt,
    description: issue.description,
    suggestedFix: issue.rewriteGoal || issue.description,
    repairReady: issue.repairReady,
    rewriteGoal: issue.rewriteGoal,
    preserveMeaning: issue.preserveMeaning,
    styleEvidenceIds: issue.styleEvidenceIds,
    styleDimension: issue.styleDimension,
  };
}

function bindStyleIssueToArtifact(
  issue: ContinuationStyleIssue,
  artifactText: string,
): ContinuationStyleIssue {
  let { generatedStart, generatedEnd, generatedExcerpt } = issue;
  const excerpt = (generatedExcerpt ?? '').trim();
  if (
    generatedStart != null &&
    generatedEnd != null &&
    generatedStart >= 0 &&
    generatedEnd > generatedStart &&
    generatedEnd <= artifactText.length
  ) {
    generatedExcerpt = artifactText.slice(generatedStart, generatedEnd);
  } else if (excerpt.length >= 4) {
    const located = artifactText.indexOf(excerpt);
    if (located >= 0) {
      generatedStart = located;
      generatedEnd = located + excerpt.length;
      generatedExcerpt = excerpt;
    } else {
      // Non-unique or missing excerpt → cannot repair.
      generatedStart = null;
      generatedEnd = null;
      generatedExcerpt = excerpt;
    }
  } else {
    generatedStart = null;
    generatedEnd = null;
    generatedExcerpt = excerpt;
  }
  const bound: ContinuationStyleIssue = {
    ...issue,
    generatedStart,
    generatedEnd,
    generatedExcerpt: generatedExcerpt ?? '',
  };
  return {
    ...bound,
    repairReady: isStyleIssueRepairReady(bound),
  };
}

function parseStyleIssueItem(
  item: Record<string, unknown>,
  index: number,
  forceWarning: boolean,
): ContinuationStyleIssue | null {
  const dimensionRaw =
    item.styleDimension ?? item.subtype ?? item.dimension ?? '';
  if (!isStyleDimension(dimensionRaw)) return null;
  const description =
    typeof item.description === 'string' ? item.description.trim() : '';
  if (!description) return null;
  const rewriteGoal =
    typeof item.rewriteGoal === 'string'
      ? item.rewriteGoal.trim()
      : typeof item.suggestedFix === 'string'
        ? item.suggestedFix.trim()
        : '';
  const preserveMeaning = asStringArray(
    item.preserveMeaning ?? item.preserve ?? [],
  );
  const styleEvidenceIds = asStringArray(
    item.styleEvidenceIds ?? item.evidenceIds ?? [],
  );
  const rawId =
    typeof item.findingId === 'string' && item.findingId.trim()
      ? item.findingId.trim()
      : `style_${index + 1}`;
  const start = asFiniteNumber(item.generatedStart);
  const end = asFiniteNumber(item.generatedEnd);
  const excerpt =
    typeof item.generatedExcerpt === 'string'
      ? item.generatedExcerpt.trim()
      : '';
  const confidence = Math.min(
    1,
    Math.max(0, Number(item.confidence) || 0),
  );
  let severity: 'warning' | 'error' =
    item.severity === 'error' && !forceWarning ? 'error' : 'warning';
  // Abstract whole-work feelings stay warnings.
  if (
    /整体不像|整体节奏|节奏平淡|不够像原著|全文风格/.test(description) &&
    !excerpt &&
    (start == null || end == null)
  ) {
    severity = 'warning';
  }
  const draft: ContinuationStyleIssue = {
    findingId: rawId,
    styleDimension: dimensionRaw,
    severity,
    confidence,
    generatedStart: start != null && start >= 0 ? start : null,
    generatedEnd: end != null && end >= 0 ? end : null,
    generatedExcerpt: excerpt,
    description,
    styleEvidenceIds,
    rewriteGoal,
    preserveMeaning,
    repairReady: false,
  };
  // repairReady computed after bind; preliminary:
  draft.repairReady =
    !forceWarning && severity === 'error' && isStyleIssueRepairReady(draft);
  return draft;
}

function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return fenced?.[1]?.trim() ?? trimmed;
}

function dedupeStyleIssues(
  issues: ContinuationStyleIssue[],
): ContinuationStyleIssue[] {
  const seen = new Set<string>();
  const out: ContinuationStyleIssue[] = [];
  for (const issue of issues) {
    const id = issue.findingId.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(issue);
  }
  return out;
}

/**
 * Local fallback when Control LLM is unavailable: length diagnostics only,
 * no expand/compress force tasks, no structural beat/paragraph Repair tasks.
 */
export function buildContinuationControlFallback(
  metrics: ContinuationV4Metrics,
  options?: { writerArtifactHash?: string | null; styleProfileRevision?: number | null },
): ContinuationControlReport {
  return {
    schemaVersion: 2,
    action: reportLengthAction(metrics),
    currentHan: metrics.actualHanCharacters,
    targetHan: metrics.targetHanCharacters,
    allowedMinHan: metrics.minHanCharacters,
    allowedMaxHan: metrics.maxHanCharacters,
    suggestions: [],
    findings: [],
    preserve: ['人物关系', '章末钩子', '未标记段落原文'],
    styleIssues: [],
    styleWarnings: [],
    styleProfileRevision: options?.styleProfileRevision ?? null,
    writerArtifactHash: options?.writerArtifactHash ?? null,
  };
}

export interface ContinuationControlParseResult {
  report: ContinuationControlReport | null;
  metricEchoMismatch: boolean;
  errorCode: string | null;
  actionEchoMismatch?: boolean;
  localSuggestionInjected?: boolean;
  droppedSuggestionCount?: number;
}

/**
 * Parse Control LLM output as original-style review (schema v2), with
 * graceful acceptance of legacy v1 expand/compress envelopes (metrics only;
 * length suggestions discarded for Repair).
 */
export function parseContinuationControlReport(input: {
  raw: string;
  metrics: ContinuationV4Metrics;
  artifactText?: string;
  writerArtifactHash?: string | null;
  styleProfileRevision?: number | null;
}): ContinuationControlParseResult {
  let parsed: any;
  try {
    parsed = JSON.parse(stripJsonFence(input.raw));
  } catch {
    return {
      report: null,
      metricEchoMismatch: false,
      errorCode: 'control_invalid_json',
    };
  }
  if (!parsed || typeof parsed !== 'object') {
    return {
      report: null,
      metricEchoMismatch: false,
      errorCode: 'control_invalid_shape',
    };
  }

  const metrics = input.metrics;
  const localLengthAction = reportLengthAction(metrics);
  const modelCurrent = asFiniteNumber(parsed.currentHan);
  const metricEchoMismatch =
    modelCurrent != null && modelCurrent !== metrics.actualHanCharacters;

  const artifactText = input.artifactText ?? '';
  const rawIssues: unknown[] = Array.isArray(parsed.issues)
    ? parsed.issues
    : [];
  const rawWarnings: unknown[] = Array.isArray(parsed.warnings)
    ? parsed.warnings
    : [];
  // Legacy v1 findings → treat as style candidates only when they look style-like.
  const legacyFindings: unknown[] = Array.isArray(parsed.findings)
    ? parsed.findings
    : [];

  const parsedIssues: ContinuationStyleIssue[] = [];
  let index = 0;
  for (const item of rawIssues) {
    if (!item || typeof item !== 'object') continue;
    const issue = parseStyleIssueItem(
      item as Record<string, unknown>,
      index,
      false,
    );
    index += 1;
    if (issue) parsedIssues.push(issue);
  }
  for (const item of rawWarnings) {
    if (!item || typeof item !== 'object') continue;
    const issue = parseStyleIssueItem(
      item as Record<string, unknown>,
      index,
      true,
    );
    index += 1;
    if (issue) parsedIssues.push(issue);
  }
  for (const item of legacyFindings) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    // Map legacy structural findings into audit warnings only (no Repair).
    const issue = parseStyleIssueItem(
      {
        ...row,
        styleDimension:
          isStyleDimension(row.subtype) || isStyleDimension(row.styleDimension)
            ? row.styleDimension ?? row.subtype
            : 'ai_template',
        severity: 'warning',
        rewriteGoal: row.suggestedFix ?? row.rewriteGoal,
        styleEvidenceIds: row.styleEvidenceIds ?? ['legacy_finding'],
        preserveMeaning: row.preserveMeaning ?? ['保留原事件与结果'],
        confidence: row.confidence ?? 0.4,
      },
      index,
      true,
    );
    index += 1;
    if (issue) parsedIssues.push(issue);
  }

  const bound = dedupeStyleIssues(
    parsedIssues.map(issue =>
      artifactText
        ? bindStyleIssueToArtifact(issue, artifactText)
        : {
            ...issue,
            repairReady: isStyleIssueRepairReady(issue),
          },
    ),
  );

  const styleIssues = bound.filter(issue => issue.repairReady);
  const styleWarnings = bound.filter(issue => !issue.repairReady);
  const findings = styleIssues.map(styleIssueToFinding);

  // Length suggestions from legacy models are intentionally discarded.
  const droppedSuggestionCount = Array.isArray(parsed.suggestions)
    ? parsed.suggestions.length
    : 0;

  const modelAction = parsed.action;
  const actionEchoMismatch =
    modelAction === 'keep' ||
    modelAction === 'expand' ||
    modelAction === 'compress'
      ? modelAction !== localLengthAction
      : false;

  return {
    report: {
      schemaVersion: 2,
      action: localLengthAction,
      currentHan: metrics.actualHanCharacters,
      targetHan: metrics.targetHanCharacters,
      allowedMinHan: metrics.minHanCharacters,
      allowedMaxHan: metrics.maxHanCharacters,
      suggestions: [],
      findings,
      preserve: Array.from(
        new Set([
          '人物关系',
          '章末钩子',
          '未标记段落原文',
          ...asStringArray(parsed.preserve),
        ]),
      ),
      styleIssues,
      styleWarnings,
      styleProfileRevision: input.styleProfileRevision ?? null,
      writerArtifactHash:
        typeof parsed.writerArtifactHash === 'string'
          ? parsed.writerArtifactHash
          : input.writerArtifactHash ?? null,
      ...(metricEchoMismatch ? { metricEchoMismatch: true } : {}),
      ...(actionEchoMismatch ? { actionEchoMismatch: true } : {}),
    },
    metricEchoMismatch,
    errorCode: null,
    actionEchoMismatch,
    localSuggestionInjected: false,
    droppedSuggestionCount,
  };
}

export function resolveContinuationControlReport(input: {
  metrics: ContinuationV4Metrics;
  raw?: string;
  artifactText?: string;
  writerArtifactHash?: string | null;
  styleProfileRevision?: number | null;
}): ContinuationControlParseResult & { report: ContinuationControlReport } {
  if (!input.raw) {
    return {
      report: buildContinuationControlFallback(input.metrics, {
        writerArtifactHash: input.writerArtifactHash,
        styleProfileRevision: input.styleProfileRevision,
      }),
      metricEchoMismatch: false,
      errorCode: 'control_llm_unavailable',
      actionEchoMismatch: false,
      localSuggestionInjected: false,
      droppedSuggestionCount: 0,
    };
  }
  const parsed = parseContinuationControlReport({
    raw: input.raw,
    metrics: input.metrics,
    artifactText: input.artifactText,
    writerArtifactHash: input.writerArtifactHash,
    styleProfileRevision: input.styleProfileRevision,
  });
  if (parsed.report) {
    return parsed as ContinuationControlParseResult & {
      report: ContinuationControlReport;
    };
  }
  return {
    report: buildContinuationControlFallback(input.metrics, {
      writerArtifactHash: input.writerArtifactHash,
      styleProfileRevision: input.styleProfileRevision,
    }),
    metricEchoMismatch: parsed.metricEchoMismatch,
    errorCode: parsed.errorCode,
    actionEchoMismatch: false,
    localSuggestionInjected: false,
    droppedSuggestionCount: 0,
  };
}

/** Actionable style findings that may enter Repair. */
export function getRepairReadyStyleFindings(
  report: ContinuationControlReport,
): ContinuationControlFinding[] {
  if (report.findings?.some(f => f.repairReady)) {
    return report.findings.filter(f => f.repairReady);
  }
  return (report.styleIssues ?? [])
    .filter(issue => issue.repairReady)
    .map(styleIssueToFinding);
}
