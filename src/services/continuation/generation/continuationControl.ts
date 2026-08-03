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

/**
 * Minimum substantial progress that a Repair candidate must demonstrate in the
 * Control direction before it can be accepted. This is a Control compliance
 * check, NOT the final hard length gate: a candidate that reaches this progress
 * but still falls short of `allowedMinHan` passes Control compliance and the
 * final length gap remains a soft warning in the Local Final Gate.
 *
 * Defined here (single source of truth) so the Repair prompt, the compliance
 * check and the result UI never diverge on what "progress" means.
 */
export const CONTROL_PROGRESS_RATIO = 0.35;
export const CONTROL_PROGRESS_FLOOR_HAN = 80;

export function requiredControlProgressHan(requiredDeltaHan: number): number {
  const delta = Math.abs(requiredDeltaHan);
  if (!Number.isFinite(delta) || delta === 0) return 0;
  return Math.min(
    delta,
    Math.max(
      CONTROL_PROGRESS_FLOOR_HAN,
      Math.ceil(delta * CONTROL_PROGRESS_RATIO),
    ),
  );
}

const LOCAL_EXPAND_SUGGESTION_ID = 'ctrl_local_expand';
const LOCAL_COMPRESS_SUGGESTION_ID = 'ctrl_local_compress';

function dedupeSuggestionsById(
  suggestions: ContinuationControlSuggestion[],
): ContinuationControlSuggestion[] {
  const seen = new Set<string>();
  const out: ContinuationControlSuggestion[] = [];
  for (const suggestion of suggestions) {
    const id = suggestion.suggestionId.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(suggestion);
  }
  return out;
}

/**
 * A model suggestion is only accepted when it is non-empty, internally unique,
 * carries a finite expected delta, points in the local action's direction, and
 * does not collide with the local forced suggestion id. Suggestions that fail
 * any of these are dropped rather than re-purposed.
 */
function filterModelSuggestions(input: {
  suggestions: ContinuationControlSuggestion[];
  localAction: ContinuationControlAction;
  seenIds: Set<string>;
}): { accepted: ContinuationControlSuggestion[]; droppedCount: number } {
  const accepted: ContinuationControlSuggestion[] = [];
  let droppedCount = 0;
  for (const suggestion of input.suggestions) {
    const id = suggestion.suggestionId.trim();
    if (!id || input.seenIds.has(id)) {
      droppedCount += 1;
      continue;
    }
    if (!suggestion.instruction.trim()) {
      droppedCount += 1;
      continue;
    }
    const delta = suggestion.expectedDeltaHan;
    if (!Number.isFinite(delta)) {
      droppedCount += 1;
      continue;
    }
    if (input.localAction === 'expand' && !(delta > 0)) {
      droppedCount += 1;
      continue;
    }
    if (input.localAction === 'compress' && !(delta < 0)) {
      droppedCount += 1;
      continue;
    }
    // keep is also accepted only when the model echoes keep-consistent advice;
    // a non-zero delta under keep has no enforceable direction and is dropped.
    if (input.localAction === 'keep' && delta !== 0) {
      droppedCount += 1;
      continue;
    }
    input.seenIds.add(id);
    accepted.push(suggestion);
  }
  return { accepted, droppedCount };
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
  /** True when the model's action echo disagrees with the authoritative local
   * action. The local action always wins; this flag is diagnostic only. */
  actionEchoMismatch?: boolean;
  /** True when the local forced suggestion was injected because the model did
   * not supply a direction-consistent one. */
  localSuggestionInjected?: boolean;
  /** Count of model suggestions dropped by the validity/direction filter. */
  droppedSuggestionCount?: number;
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
