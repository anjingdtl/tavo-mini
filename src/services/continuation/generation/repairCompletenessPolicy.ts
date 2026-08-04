/**
 * Repair completeness & anti-collapse policy for Continuation V4.
 *
 * Thresholds are intentional structural safety floors relative to the Writer
 * draft — never relative to the user's target chapter length. Length soft
 * warnings stay in the length contract; this module only answers:
 * "Did Repair return a complete chapter that preserves unmarked content?"
 *
 * Calibration notes (initial defaults, 2026-08):
 * - minCandidateToWriterHanRatio 0.45: absolute 1000-han floor already exists
 *   elsewhere; relative ratio catches mid-length collapses that stay >1000.
 * - minUnaffectedParagraphRetentionRatio 0.55: majority of untargeted paragraphs
 *   must still be recognisable; allows seam rewrites around targeted ranges.
 * - minParagraphCountRatio 0.5: combined with ratio/anchors for blocking.
 * - Summary phrases are supporting evidence only (never sole blockers).
 */

import { countHanCharacters } from './continuationLengthContract';

export interface RepairCompletenessPolicy {
  /** Floor for candidateHan / writerHan (Writer-relative, not user target). */
  minCandidateToWriterHanRatio: number;
  /** Share of untargeted Writer paragraphs that must still appear (normalized). */
  minUnaffectedParagraphRetentionRatio: number;
  /** Floor for candidateParagraphCount / writerParagraphCount. */
  minParagraphCountRatio: number;
  requireOpeningAnchor: boolean;
  requireMiddleAnchor: boolean;
  requireEndingAnchor: boolean;
  /** UTF-16 length of opening/middle/ending anchors taken from Writer. */
  anchorCharLength: number;
  /** Below this ratio of untargeted retention, treat as non-minimal rewrite. */
  minMinimalInterventionRetentionRatio: number;
}

/**
 * Central thresholds. Do not scatter magic numbers in the runner or prompts.
 */
export const DEFAULT_REPAIR_COMPLETENESS_POLICY: RepairCompletenessPolicy = {
  minCandidateToWriterHanRatio: 0.45,
  minUnaffectedParagraphRetentionRatio: 0.55,
  minParagraphCountRatio: 0.5,
  requireOpeningAnchor: true,
  requireMiddleAnchor: true,
  requireEndingAnchor: true,
  anchorCharLength: 48,
  minMinimalInterventionRetentionRatio: 0.4,
};

/** Supporting-only summary / placeholder phrases (never sole blockers). */
export const REPAIR_SUMMARY_PHRASES = [
  '本章主要讲述',
  '随后众人',
  '经过一番',
  '最终他们',
  '以上为修订',
  '其余内容不变',
  '以下为修改部分',
  '其余内容保持不变',
  '以下是修改',
  '修改说明',
  '此处省略',
  '内容略',
  '（略）',
  '(略)',
  '……（后文不变）',
  '后文不变',
  '全文从略',
];

export type RepairCompletenessErrorCode =
  | 'repair_empty_content'
  | 'repair_partial_output'
  | 'repair_summary_output'
  | 'repair_content_collapsed'
  | 'repair_missing_unaffected_sections'
  | 'repair_envelope_leakage'
  | 'repair_prompt_leakage'
  | 'repair_non_minimal_rewrite';

export interface RepairParagraphRange {
  index: number;
  start: number;
  end: number;
  value: string;
  normalized: string;
}

export interface RepairCompletenessMetrics {
  writerParagraphCount: number;
  candidateParagraphCount: number;
  targetedWriterParagraphCount: number;
  unaffectedWriterParagraphCount: number;
  retainedUnaffectedParagraphCount: number;
  unaffectedRetentionRatio: number;
  openingAnchorRetained: boolean;
  middleAnchorRetained: boolean;
  endingAnchorRetained: boolean;
  candidateToWriterHanRatio: number;
  writerHan: number;
  candidateHan: number;
  paragraphCountRatio: number;
  summaryPhraseHits: string[];
  minimalInterventionPassed: boolean;
}

export interface RepairCompletenessIssue {
  code: RepairCompletenessErrorCode;
  severity: 'warning' | 'error' | 'blocking';
  description: string;
  suggestedFix: string;
}

export interface RepairCompletenessResult {
  passed: boolean;
  minimalInterventionPassed: boolean;
  metrics: RepairCompletenessMetrics;
  issues: RepairCompletenessIssue[];
}

function normalizeParagraph(value: string): string {
  return value.replace(
    /[\s，。！？、；：,.!?;:'"“”‘’（）()【】[\]「」『』《》…—\-·]/g,
    '',
  );
}

export function splitNaturalParagraphs(text: string): RepairParagraphRange[] {
  const ranges: RepairParagraphRange[] = [];
  const pattern = /[^\r\n]+/g;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(text)) !== null) {
    const raw = match[0];
    const value = raw.trim();
    if (!value) continue;
    const leading = raw.indexOf(value);
    const start = match.index + Math.max(0, leading);
    ranges.push({
      index,
      start,
      end: start + value.length,
      value,
      normalized: normalizeParagraph(value),
    });
    index += 1;
  }
  if (!ranges.length && text.trim()) {
    const value = text.trim();
    const start = text.indexOf(value);
    ranges.push({
      index: 0,
      start,
      end: start + value.length,
      value,
      normalized: normalizeParagraph(value),
    });
  }
  return ranges;
}

export interface TargetedRepairSpan {
  generatedStart: number | null;
  generatedEnd: number | null;
  generatedExcerpt?: string | null;
}

/**
 * Mark Writer paragraphs that intersect any actionable Checker/Control span.
 * Adjacent paragraphs (±1) are treated as seam and also "targeted".
 */
export function markTargetedWriterParagraphs(
  writerParagraphs: RepairParagraphRange[],
  spans: TargetedRepairSpan[],
  writerText: string,
): Set<number> {
  const targeted = new Set<number>();
  for (const span of spans) {
    let start = span.generatedStart;
    let end = span.generatedEnd;
    const excerpt = (span.generatedExcerpt ?? '').trim();
    if (
      (start == null || end == null || end <= start) &&
      excerpt.length >= 4
    ) {
      const located = writerText.indexOf(excerpt);
      if (located >= 0) {
        start = located;
        end = located + excerpt.length;
      }
    }
    if (start == null || end == null || end <= start) continue;
    for (const paragraph of writerParagraphs) {
      const overlaps =
        paragraph.start < end && paragraph.end > start;
      if (overlaps) {
        targeted.add(paragraph.index);
        if (paragraph.index > 0) targeted.add(paragraph.index - 1);
        if (paragraph.index < writerParagraphs.length - 1) {
          targeted.add(paragraph.index + 1);
        }
      }
    }
  }
  return targeted;
}

function takeAnchor(text: string, length: number, where: 'start' | 'middle' | 'end'): string {
  const compact = text.replace(/\s+/g, '');
  if (!compact) return '';
  const n = Math.min(length, compact.length);
  if (where === 'start') return compact.slice(0, n);
  if (where === 'end') return compact.slice(-n);
  const mid = Math.max(0, Math.floor((compact.length - n) / 2));
  return compact.slice(mid, mid + n);
}

function containsNormalized(haystack: string, needle: string): boolean {
  if (!needle || needle.length < 8) return true;
  return normalizeParagraph(haystack).includes(normalizeParagraph(needle));
}

function detectSummaryPhrases(text: string): string[] {
  return REPAIR_SUMMARY_PHRASES.filter(phrase => text.includes(phrase));
}

/**
 * Evaluate whether a Repair candidate is a complete chapter relative to Writer.
 * Summary phrases alone never block; they only support multi-signal collapse.
 * Every Repair uses the same targeted-span/minimal-intervention policy;
 * chapter length never grants a whole-document exemption.
 */
export function evaluateRepairCompleteness(input: {
  writerText: string;
  candidateText: string;
  targetedSpans?: TargetedRepairSpan[];
  policy?: RepairCompletenessPolicy;
}): RepairCompletenessResult {
  const policy = input.policy ?? DEFAULT_REPAIR_COMPLETENESS_POLICY;
  const writerText = input.writerText ?? '';
  const candidateText = input.candidateText ?? '';
  const writerParagraphs = splitNaturalParagraphs(writerText);
  const candidateParagraphs = splitNaturalParagraphs(candidateText);
  const targeted = markTargetedWriterParagraphs(
    writerParagraphs,
    input.targetedSpans ?? [],
    writerText,
  );
  const candidateNormalized = new Set(
    candidateParagraphs.map(p => p.normalized).filter(n => n.length >= 6),
  );
  let retainedUnaffected = 0;
  let unaffectedTotal = 0;
  for (const paragraph of writerParagraphs) {
    if (targeted.has(paragraph.index)) continue;
    unaffectedTotal += 1;
    if (
      paragraph.normalized.length >= 6 &&
      candidateNormalized.has(paragraph.normalized)
    ) {
      retainedUnaffected += 1;
    } else if (
      paragraph.normalized.length >= 6 &&
      normalizeParagraph(candidateText).includes(paragraph.normalized)
    ) {
      retainedUnaffected += 1;
    }
  }
  const writerHan = countHanCharacters(writerText);
  const candidateHan = countHanCharacters(candidateText);
  const candidateToWriterHanRatio =
    writerHan > 0 ? candidateHan / writerHan : candidateHan > 0 ? 1 : 0;
  const paragraphCountRatio =
    writerParagraphs.length > 0
      ? candidateParagraphs.length / writerParagraphs.length
      : candidateParagraphs.length > 0
        ? 1
        : 0;
  const unaffectedRetentionRatio =
    unaffectedTotal > 0 ? retainedUnaffected / unaffectedTotal : 1;

  const openingAnchor = takeAnchor(
    writerText,
    policy.anchorCharLength,
    'start',
  );
  const middleAnchor = takeAnchor(
    writerText,
    policy.anchorCharLength,
    'middle',
  );
  const endingAnchor = takeAnchor(writerText, policy.anchorCharLength, 'end');
  const openingAnchorRetained =
    !policy.requireOpeningAnchor ||
    containsNormalized(candidateText, openingAnchor);
  const middleAnchorRetained =
    !policy.requireMiddleAnchor ||
    containsNormalized(candidateText, middleAnchor);
  const endingAnchorRetained =
    !policy.requireEndingAnchor ||
    containsNormalized(candidateText, endingAnchor);

  const summaryPhraseHits = detectSummaryPhrases(candidateText);
  const minimalInterventionPassed =
    unaffectedTotal === 0 ||
    unaffectedRetentionRatio >= policy.minMinimalInterventionRetentionRatio;

  const metrics: RepairCompletenessMetrics = {
    writerParagraphCount: writerParagraphs.length,
    candidateParagraphCount: candidateParagraphs.length,
    targetedWriterParagraphCount: targeted.size,
    unaffectedWriterParagraphCount: unaffectedTotal,
    retainedUnaffectedParagraphCount: retainedUnaffected,
    unaffectedRetentionRatio,
    openingAnchorRetained,
    middleAnchorRetained,
    endingAnchorRetained,
    candidateToWriterHanRatio,
    writerHan,
    candidateHan,
    paragraphCountRatio,
    summaryPhraseHits,
    minimalInterventionPassed,
  };

  const issues: RepairCompletenessIssue[] = [];

  if (!candidateText.trim() || candidateHan === 0) {
    issues.push({
      code: 'repair_empty_content',
      severity: 'blocking',
      description: 'Repair 终稿没有可采纳的汉字正文。',
      suggestedFix: '返回从章节开头到自然结尾的完整终稿。',
    });
  }

  const missingAnchors = [
    !openingAnchorRetained ? '开头' : null,
    !middleAnchorRetained ? '中段' : null,
    !endingAnchorRetained ? '结尾' : null,
  ].filter(Boolean) as string[];

  // Partial / fragment: very few paragraphs vs Writer, or missing multiple anchors
  // with severe content loss.
  const looksPartial =
    writerParagraphs.length >= 3 &&
    (candidateParagraphs.length <= 1 ||
      paragraphCountRatio < policy.minParagraphCountRatio) &&
    candidateToWriterHanRatio < policy.minCandidateToWriterHanRatio;

  if (looksPartial) {
    issues.push({
      code: 'repair_partial_output',
      severity: 'blocking',
      description: `Repair 疑似只返回了片段或局部修订（段落 ${candidateParagraphs.length}/${writerParagraphs.length}，相对 Writer 汉字比例 ${(candidateToWriterHanRatio * 100).toFixed(0)}%）。`,
      suggestedFix:
        '即使只修改一句话，也必须返回从章节开头到自然结尾的完整终稿，禁止只输出修改片段。',
    });
  }

  // Missing large unaffected sections: low retention + at least one anchor miss.
  if (
    unaffectedTotal >= 2 &&
    unaffectedRetentionRatio < policy.minUnaffectedParagraphRetentionRatio &&
    missingAnchors.length > 0
  ) {
    issues.push({
      code: 'repair_missing_unaffected_sections',
      severity: 'blocking',
      description: `Repair 丢失了大量未标记修改的正文（未涉及段落保留率 ${(unaffectedRetentionRatio * 100).toFixed(0)}%，缺失锚点：${missingAnchors.join('、')}）。`,
      suggestedFix: '未涉及段落必须原样或近原样保留，并与修订部分一起完整输出。',
    });
  }

  // Collapse: relative shortening + paragraph drop + optional summary support.
  const collapsed =
    writerHan > 0 &&
    candidateToWriterHanRatio < policy.minCandidateToWriterHanRatio &&
    paragraphCountRatio < policy.minParagraphCountRatio &&
    (summaryPhraseHits.length > 0 || missingAnchors.length > 0);

  if (collapsed && !issues.some(i => i.code === 'repair_partial_output')) {
    issues.push({
      code: 'repair_content_collapsed',
      severity: 'blocking',
      description: `Repair 相对 Writer 明显坍缩（汉字比例 ${(candidateToWriterHanRatio * 100).toFixed(0)}%，段落比例 ${(paragraphCountRatio * 100).toFixed(0)}%）${
        summaryPhraseHits.length
          ? `，并出现占位/摘要表达：${summaryPhraseHits.slice(0, 3).join('、')}`
          : ''
      }。`,
      suggestedFix: '禁止摘要化或省略未修改部分；必须输出完整章节终稿。',
    });
  }

  // Summary phrases only reinforce; if already collapsed/partial they are covered.
  // Isolated summary phrase with full retention → warning only.
  if (
    summaryPhraseHits.length > 0 &&
    !issues.some(
      i =>
        i.code === 'repair_content_collapsed' ||
        i.code === 'repair_partial_output',
    )
  ) {
    issues.push({
      code: 'repair_summary_output',
      severity: 'warning',
      description: `Repair 正文出现摘要/占位表达（${summaryPhraseHits.slice(0, 3).join('、')}）；单独出现不阻断，需结合完整性指标判断。`,
      suggestedFix: '删除摘要/占位句，直接输出完整章节正文。',
    });
  }

  if (!minimalInterventionPassed) {
    issues.push({
      code: 'repair_non_minimal_rewrite',
      severity: 'blocking',
      description: `Repair 对大量未标记段落做了改写（未涉及段落保留率 ${(unaffectedRetentionRatio * 100).toFixed(0)}%），不满足最小干预，不能自动替代 Writer。`,
      suggestedFix: '只修改 Checker/Control 标出的范围及必要接缝；未标记段落尽量保持 Writer 原文。',
    });
  }

  const blocking = issues.some(
    issue => issue.severity === 'error' || issue.severity === 'blocking',
  );

  return {
    passed: !blocking,
    minimalInterventionPassed,
    metrics,
    issues,
  };
}
