import {
  countHanCharacters,
  resolveContinuationLengthContract,
  type ContinuationLengthContract,
} from './continuationLengthContract';
import type {
  ContinuationControlAction,
  ContinuationControlFinding,
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

function localStructuralFindings(
  metrics: ContinuationV4Metrics,
): ContinuationControlFinding[] {
  const findings: ContinuationControlFinding[] = [];

  metrics.duplicateWindows.forEach((window, index) => {
    findings.push({
      findingId: `ctrl_local_duplicate_${index + 1}`,
      subtype: 'duplicate_window',
      severity: 'warning',
      location: `utf16:${window.start}-${window.end}`,
      generatedStart: window.start,
      generatedEnd: window.end,
      description: `检测到同一自然段或高度相似段落重复出现 ${window.count} 次，可能造成叙事退化。`,
      suggestedFix: '合并或改写重复段落，保留一次有效表达，并补充新的动作、反应或因果推进。',
    });
  });

  metrics.beatCoverage.forEach(beat => {
    if (beat.paragraphIds.length > 0) return;
    findings.push({
      findingId: `ctrl_local_beat_gap_${beat.beatId}`,
      subtype: 'beat_gap',
      severity: 'warning',
      location: beat.beatId,
      generatedStart: null,
      generatedEnd: null,
      description: `计划节拍 ${beat.beatId} 未能在正文段落中找到可识别的覆盖内容。`,
      suggestedFix: `在不破坏现有事件链的前提下补足 ${beat.beatId} 的动作、冲突或结果，并让它自然推动章末。`,
    });
  });

  const distribution = metrics.paragraphLengthDistribution;
  if (metrics.paragraphs.length >= 3 && distribution.median > 0) {
    const longest = metrics.paragraphs.find(
      paragraph => paragraph.hanCharacters === distribution.max,
    );
    const shortest = metrics.paragraphs.find(
      paragraph => paragraph.hanCharacters === distribution.min,
    );
    const upperImbalance =
      distribution.max >= distribution.median * 2 &&
      distribution.max - distribution.median >= 160;
    const lowerImbalance =
      distribution.min <= distribution.median * 0.4 &&
      distribution.median - distribution.min >= 120;
    if (upperImbalance || lowerImbalance) {
      const focus = upperImbalance ? longest : shortest;
      findings.push({
        findingId: 'ctrl_local_paragraph_imbalance',
        subtype: 'paragraph_imbalance',
        severity: 'warning',
        location: focus?.id ?? 'paragraph_structure',
        generatedStart: focus?.start ?? null,
        generatedEnd: focus?.end ?? null,
        description: `段落长度分布不均：最短 ${distribution.min}、中位数 ${distribution.median}、最长 ${distribution.max} 个汉字，局部节奏可能失衡。`,
        suggestedFix: '将过长段落拆成有动作推进的自然段，或扩充过短段落的即时反应与因果衔接，避免只做机械分段。',
      });
    }
  }

  return findings;
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
    findings: localStructuralFindings(metrics),
    preserve: ['人物关系', '章末钩子'],
  };
}

/**
 * The minimum substantial progress a Repair candidate must make in Control's
 * direction. This is a HARD compliance requirement, not the final-length soft
 * gate: a candidate that falls short of this progress (and also does not reach
 * the legal band) is rejected by `validateContinuationV4RepairCompliance` with
 * `repair_control_insufficient_progress` (blocking). A candidate that meets
 * this floor but still falls short of allowedMin/allowedMax passes Control
 * compliance; the remaining pure length gap stays a `chapter_length_*` warning
 * in the Local Final Gate and does not reject.
 *
 * Defined here (single source of truth) so the Repair prompt, the compliance
 * check and the result UI never diverge on what "minimum progress" means.
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

function dedupeFindingsById(
  findings: ContinuationControlFinding[],
): ContinuationControlFinding[] {
  const seen = new Set<string>();
  const out: ContinuationControlFinding[] = [];
  for (const finding of findings) {
    const id = finding.findingId.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(finding);
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

function parseModelFindings(value: unknown): ContinuationControlFinding[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is Record<string, unknown> =>
        Boolean(item && typeof item === 'object'),
    )
    .map((item, index) => {
      const description =
        typeof item.description === 'string' ? item.description.trim() : '';
      const suggestedFix =
        typeof item.suggestedFix === 'string' ? item.suggestedFix.trim() : '';
      const subtype =
        typeof item.subtype === 'string' ? item.subtype.trim() : '';
      const location =
        typeof item.location === 'string' ? item.location.trim() : '';
      if (!description || !suggestedFix || !subtype || !location) return null;
      const rawId =
        typeof item.findingId === 'string' ? item.findingId.trim() : '';
      const start = asFiniteNumber(item.generatedStart);
      const end = asFiniteNumber(item.generatedEnd);
      return {
        findingId: rawId || `ctrl_model_finding_${index + 1}`,
        subtype,
        // Findings are advisory by contract; unknown model severities are
        // downgraded rather than becoming new hard gates.
        severity: item.severity === 'info' ? 'info' : 'warning',
        location,
        generatedStart: start != null && start >= 0 ? start : null,
        generatedEnd: end != null && end >= 0 ? end : null,
        description,
        suggestedFix,
      } satisfies ContinuationControlFinding;
    })
    .filter(
      (finding): finding is ContinuationControlFinding => finding !== null,
    );
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
 * Parse the Control report and reconcile it against the authoritative local
 * metrics. The local `action` and every numeric field always win; the model's
 * `action` is only a diagnostic echo. When the local action is expand/compress,
 * a forced local suggestion (`ctrl_local_expand`/`ctrl_local_compress`) is
 * always present in the final suggestions, even if the model returned an empty
 * array or a direction-inconsistent one.
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
  const modelAction = parsed.action;
  if (
    modelAction !== 'keep' &&
    modelAction !== 'expand' &&
    modelAction !== 'compress'
  ) {
    return {
      report: null,
      metricEchoMismatch: false,
      errorCode: 'control_invalid_action',
    };
  }
  const metrics = input.metrics;
  // Local action is the single source of truth for direction.
  const localAction: ContinuationControlAction = reportAction(metrics);
  const actionEchoMismatch = modelAction !== localAction;
  const modelCurrent = asFiniteNumber(parsed.currentHan);
  const metricEchoMismatch =
    modelCurrent != null && modelCurrent !== metrics.actualHanCharacters;

  const rawModelSuggestions: ContinuationControlSuggestion[] = Array.isArray(
    parsed.suggestions,
  )
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
            (metrics.missingToMinimum > 0
              ? metrics.missingToMinimum
              : -metrics.excessOverMaximum),
          instruction:
            typeof item.instruction === 'string' ? item.instruction : '',
          preserveBeatIds: asStringArray(item.preserveBeatIds),
        }))
    : [];

  // The local forced suggestion is always seeded first so the model cannot
  // remove it by returning an empty array or a contradictory id.
  const localFallback = buildContinuationControlFallback(metrics);
  const localForced = localFallback.suggestions.filter(
    s =>
      s.suggestionId === LOCAL_EXPAND_SUGGESTION_ID ||
      s.suggestionId === LOCAL_COMPRESS_SUGGESTION_ID,
  );
  const seenIds = new Set<string>(localForced.map(s => s.suggestionId));
  // Under action mismatch, the model's suggestions point the wrong way and are
  // dropped wholesale; otherwise they are filtered individually.
  const candidatesForFilter = actionEchoMismatch ? [] : rawModelSuggestions;
  const { accepted: acceptedModel, droppedCount } = filterModelSuggestions({
    suggestions: candidatesForFilter,
    localAction,
    seenIds,
  });

  const suggestions = dedupeSuggestionsById([
    ...localForced,
    ...acceptedModel,
  ]);
  const localSuggestionInjected = localForced.length > 0;

  const findings = dedupeFindingsById([
    ...localFallback.findings,
    ...parseModelFindings(parsed.findings),
  ]);

  // Preserve local defaults plus the model's preserve list (union, deduped).
  const preserveSet = new Set<string>([
    ...localFallback.preserve,
    ...asStringArray(parsed.preserve),
  ]);

  return {
    report: {
      schemaVersion: 1,
      action: localAction,
      currentHan: metrics.actualHanCharacters,
      targetHan: metrics.targetHanCharacters,
      allowedMinHan: metrics.minHanCharacters,
      allowedMaxHan: metrics.maxHanCharacters,
      suggestions,
      findings,
      preserve: Array.from(preserveSet),
      ...(metricEchoMismatch ? { metricEchoMismatch: true } : {}),
      ...(actionEchoMismatch ? { actionEchoMismatch: true } : {}),
    },
    metricEchoMismatch,
    errorCode: null,
    actionEchoMismatch,
    localSuggestionInjected,
    droppedSuggestionCount: droppedCount + (actionEchoMismatch ? rawModelSuggestions.length : 0),
  };
}

export function resolveContinuationControlReport(input: {
  metrics: ContinuationV4Metrics;
  raw?: string;
}): ContinuationControlParseResult & { report: ContinuationControlReport } {
  if (!input.raw) {
    // No LLM at all: the local fallback is already authoritative and carries
    // the local forced suggestion.
    return {
      report: buildContinuationControlFallback(input.metrics),
      metricEchoMismatch: false,
      errorCode: 'control_llm_unavailable',
      actionEchoMismatch: false,
      localSuggestionInjected: buildContinuationControlFallback(input.metrics).suggestions.length > 0,
      droppedSuggestionCount: 0,
    };
  }
  const parsed = parseContinuationControlReport({
    raw: input.raw,
    metrics: input.metrics,
  });
  if (parsed.report) return parsed as ContinuationControlParseResult & { report: ContinuationControlReport };
  // Parse failed: fall back to the local deterministic report but preserve the
  // parse error code for telemetry/UI.
  return {
    report: buildContinuationControlFallback(input.metrics),
    metricEchoMismatch: parsed.metricEchoMismatch,
    errorCode: parsed.errorCode,
    actionEchoMismatch: false,
    localSuggestionInjected: buildContinuationControlFallback(input.metrics).suggestions.length > 0,
    droppedSuggestionCount: 0,
  };
}
