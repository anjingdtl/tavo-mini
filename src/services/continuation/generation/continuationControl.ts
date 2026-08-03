import {
  countHanCharacters,
  resolveContinuationLengthContract,
  type ContinuationLengthContract,
} from './continuationLengthContract';
import type {
  ContinuationControlReport,
  ContinuationControlSuggestion,
  ContinuationPlan,
  ContinuationV4Metrics,
} from './types';

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

function reportAction(metrics: ContinuationV4Metrics): ContinuationControlReport['action'] {
  if (metrics.missingToMinimum > 0) return 'expand';
  if (metrics.excessOverMaximum > 0) return 'compress';
  return 'keep';
}

function fallbackSuggestion(
  metrics: ContinuationV4Metrics,
): ContinuationControlSuggestion[] {
  if (metrics.missingToMinimum > 0) {
    return [
      {
        suggestionId: 'ctrl_local_expand',
        type: 'expand_scene',
        location: `paragraph_${metrics.paragraphs.length}_after`,
        expectedDeltaHan: metrics.missingToMinimum,
        instruction: `在自然段边界补充行动阻力、人物即时反应和因果推进，至少补足 ${metrics.missingToMinimum} 个汉字。`,
        preserveBeatIds: metrics.beatCoverage
          .filter(beat => beat.paragraphIds.length > 0)
          .map(beat => beat.beatId),
      },
    ];
  }
  if (metrics.excessOverMaximum > 0) {
    return [
      {
        suggestionId: 'ctrl_local_compress',
        type: 'compress_repetition',
        location: 'duplicate_windows_first',
        expectedDeltaHan: -metrics.excessOverMaximum,
        instruction: `优先压缩重复段落、重复心理和不推进剧情的对话，减少 ${metrics.excessOverMaximum} 个汉字以内。`,
        preserveBeatIds: metrics.beatCoverage.map(beat => beat.beatId),
      },
    ];
  }
  return [];
}

export function buildContinuationControlFallback(
  metrics: ContinuationV4Metrics,
): ContinuationControlReport {
  return {
    schemaVersion: 1,
    action: reportAction(metrics),
    currentHan: metrics.actualHanCharacters,
    targetHan: metrics.targetHanCharacters,
    allowedMinHan: metrics.minHanCharacters,
    allowedMaxHan: metrics.maxHanCharacters,
    suggestions: fallbackSuggestion(metrics),
    preserve: ['人物关系', '章末钩子'],
  };
}

function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return fenced?.[1]?.trim() ?? trimmed;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean)
    : [];
}

export interface ContinuationControlParseResult {
  report: ContinuationControlReport | null;
  metricEchoMismatch: boolean;
  errorCode: string | null;
}

/**
 * Parse only the Control report. Local metrics remain authoritative for every
 * numeric field, including a model's `currentHan` echo.
 */
export function parseContinuationControlReport(input: {
  raw: string;
  metrics: ContinuationV4Metrics;
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
  const action = parsed.action;
  if (action !== 'keep' && action !== 'expand' && action !== 'compress') {
    return {
      report: null,
      metricEchoMismatch: false,
      errorCode: 'control_invalid_action',
    };
  }
  const modelCurrent = asFiniteNumber(parsed.currentHan);
  const metricEchoMismatch =
    modelCurrent != null && modelCurrent !== input.metrics.actualHanCharacters;
  const suggestions = Array.isArray(parsed.suggestions)
    ? parsed.suggestions
        .filter((item: any) => item && typeof item === 'object')
        .map((item: any, index: number) => ({
          suggestionId:
            typeof item.suggestionId === 'string' && item.suggestionId.trim()
              ? item.suggestionId.trim()
              : `ctrl_${index + 1}`,
          type: typeof item.type === 'string' ? item.type : 'targeted_edit',
          location:
            typeof item.location === 'string' ? item.location : 'paragraph_boundary',
          expectedDeltaHan:
            asFiniteNumber(item.expectedDeltaHan) ??
            (input.metrics.missingToMinimum > 0
              ? input.metrics.missingToMinimum
              : -input.metrics.excessOverMaximum),
          instruction:
            typeof item.instruction === 'string' ? item.instruction : '',
          preserveBeatIds: asStringArray(item.preserveBeatIds),
        }))
        .filter((item: ContinuationControlSuggestion) => Boolean(item.instruction))
    : [];
  return {
    report: {
      schemaVersion: 1,
      action,
      currentHan: input.metrics.actualHanCharacters,
      targetHan: input.metrics.targetHanCharacters,
      allowedMinHan: input.metrics.minHanCharacters,
      allowedMaxHan: input.metrics.maxHanCharacters,
      suggestions,
      preserve: asStringArray(parsed.preserve),
      ...(metricEchoMismatch ? { metricEchoMismatch: true } : {}),
    },
    metricEchoMismatch,
    errorCode: null,
  };
}

export function resolveContinuationControlReport(input: {
  metrics: ContinuationV4Metrics;
  raw?: string;
}): ContinuationControlParseResult & { report: ContinuationControlReport } {
  if (!input.raw) {
    return {
      report: buildContinuationControlFallback(input.metrics),
      metricEchoMismatch: false,
      errorCode: 'control_llm_unavailable',
    };
  }
  const parsed = parseContinuationControlReport({
    raw: input.raw,
    metrics: input.metrics,
  });
  if (parsed.report) return parsed as ContinuationControlParseResult & { report: ContinuationControlReport };
  return {
    report: buildContinuationControlFallback(input.metrics),
    metricEchoMismatch: parsed.metricEchoMismatch,
    errorCode: parsed.errorCode,
  };
}
