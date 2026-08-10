import { extractAuditJsonPayload } from '../pipelineAuditValidator';
import {
  briefRequiredSourceIds,
  type FinalWritingBriefImmutableEnvelopeV33,
  type BriefTargetKindV31,
  type BriefCompilerInputV1,
  type FinalWritingBriefImmutableEnvelopeV31,
  type FinalWritingBriefImmutableEnvelopeV32,
  type FinalWritingBriefV31,
  type FinalWritingBriefV32,
  type FinalWritingBriefV33,
  type FinalWritingBriefV1,
} from './briefCompilerTypes';
import type { StructuredOutputCompatibility } from './reasoningPolicy';

export interface BriefValidationResult {
  valid: boolean;
  brief?:
    | FinalWritingBriefV1
    | FinalWritingBriefV31
    | FinalWritingBriefV32
    | FinalWritingBriefV33;
  warnings: string[];
  error?: string;
}

const MAX_MUST_FIX = 24;
const MAX_TEXT = 3200;

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(item => typeof item === 'string' && item.trim())
    .map(item => String(item).trim().slice(0, MAX_TEXT));
}

function hasLeak(value: unknown): boolean {
  const text = JSON.stringify(value);
  return /<think|protectedAnchorIds|revision\s*contract|prompt\s*注入|\b(?:system|assistant|user)\b/i.test(
    text,
  );
}

/** Local fail-closed validator. An invalid API result is not a valid Brief. */
export function validateFinalWritingBrief(params: {
  raw: string;
  input: BriefCompilerInputV1;
}): BriefValidationResult {
  const warnings: string[] = [];
  const extracted = extractAuditJsonPayload(params.raw.trim());
  if (!extracted.jsonText) {
    return { valid: false, warnings, error: 'Brief 输出不是完整 JSON' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted.jsonText);
  } catch {
    return { valid: false, warnings, error: 'Brief JSON 解析失败' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { valid: false, warnings, error: 'Brief 根节点不是对象' };
  }
  if (hasLeak(parsed)) {
    return {
      valid: false,
      warnings,
      error: 'Brief 含机器协议或 Thinking 泄漏',
    };
  }
  const raw = parsed as Record<string, unknown>;
  if (Number(raw.schemaVersion) !== 1) {
    return { valid: false, warnings, error: 'Brief schemaVersion 必须为 1' };
  }
  if (raw.sourceHash !== params.input.sourceHash) {
    return { valid: false, warnings, error: 'Brief sourceHash 不匹配' };
  }
  const requiredIds = briefRequiredSourceIds(params.input);
  const knownIds = new Set([
    ...requiredIds,
    ...(params.input.review?.executableCorrections || []).map(
      item => item.sourceId,
    ),
    ...(params.input.review?.unlocatedRequired || []).map(
      item => item.sourceId,
    ),
    ...(params.input.factCheck?.corrections || []).map(item => item.sourceId),
  ]);
  const covered = strings(raw.coveredRequiredIds);
  if (covered.some(id => !knownIds.has(id))) {
    return {
      valid: false,
      warnings,
      error: 'Brief coveredRequiredIds 含未知 sourceId',
    };
  }
  const fixesRaw = Array.isArray(raw.mustFix) ? raw.mustFix : [];
  if (fixesRaw.length > MAX_MUST_FIX) {
    return { valid: false, warnings, error: 'Brief mustFix 超过上限' };
  }
  const fixIds = new Set<string>();
  const mustFix: FinalWritingBriefV1['mustFix'] = [];
  for (const item of fixesRaw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { valid: false, warnings, error: 'Brief mustFix 项结构无效' };
    }
    const row = item as Record<string, unknown>;
    const sourceIds = strings(row.sourceIds);
    if (!sourceIds.length || sourceIds.some(id => !knownIds.has(id))) {
      return { valid: false, warnings, error: 'Brief 引用了未知 sourceId' };
    }
    if (typeof row.instruction !== 'string' || !row.instruction.trim()) {
      return {
        valid: false,
        warnings,
        error: 'Brief mustFix 缺少 instruction',
      };
    }
    const currentLocation =
      typeof row.location === 'string' && row.location.trim()
        ? row.location.trim()
        : '本章相关位置';
    const conflicting = sourceIds.some(id => {
      const previous = mustFix.find(fix => fix.sourceIds.includes(id));
      return Boolean(
        previous &&
          (previous.instruction !== row.instruction ||
            previous.location !== currentLocation),
      );
    });
    if (conflicting) {
      return {
        valid: false,
        warnings,
        error: 'Brief 同一 sourceId 被相互矛盾的指令覆盖',
      };
    }
    if (sourceIds.some(id => fixIds.has(id))) {
      warnings.push('Brief 存在重复 sourceId，已视为覆盖一次');
    }
    sourceIds.forEach(id => fixIds.add(id));
    mustFix.push({
      sourceIds,
      location: currentLocation,
      instruction: row.instruction.trim().slice(0, MAX_TEXT),
      preserve: strings(row.preserve),
    });
  }
  for (const id of requiredIds) {
    if (!covered.includes(id) && !fixIds.has(id)) {
      return {
        valid: false,
        warnings,
        error: `Brief 未覆盖 required/hard: ${id}`,
      };
    }
  }
  const mustNotAdvance = strings(raw.mustNotAdvance);
  const expectedMustNotAdvance =
    params.input.review?.outlineExecution.mustNotAdvance || [];
  if (expectedMustNotAdvance.some(item => !mustNotAdvance.includes(item))) {
    return { valid: false, warnings, error: 'Brief 丢失 mustNotAdvance' };
  }
  const endingState =
    typeof raw.endingState === 'string' ? raw.endingState.trim() : '';
  const endingGoal =
    params.input.review?.outlineExecution.endingGoal?.trim() || '';
  if (endingGoal && !endingState) {
    return {
      valid: false,
      warnings,
      error: 'Brief 丢失 endingGoal 对应的 endingState',
    };
  }
  const hardConstraints = params.input.factCheck?.hardConstraints || [];
  const mustPreserve = strings(raw.mustPreserve);
  if (hardConstraints.some(item => !mustPreserve.includes(item))) {
    return { valid: false, warnings, error: 'Brief 丢失 hardConstraints' };
  }
  return {
    valid: true,
    warnings,
    brief: {
      schemaVersion: 1,
      sourceHash: params.input.sourceHash,
      coveredRequiredIds: requiredIds,
      mustFix,
      mustPreserve,
      mustNotAdvance,
      openingContinuity: strings(raw.openingContinuity),
      endingState,
      advisoryNotes: strings(raw.advisoryNotes),
    },
  };
}

function strictStringArray(
  raw: Record<string, unknown>,
  key: string,
): string[] | null {
  if (!Array.isArray(raw[key])) return null;
  const values = strings(raw[key]);
  return values.length === (raw[key] as unknown[]).length ? values : null;
}

function normalizeBriefSourceId(
  value: unknown,
  knownIds: Set<string>,
): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  if (knownIds.has(raw)) return raw;
  const lower = raw.toLocaleLowerCase();
  const caseMatches = [...knownIds].filter(
    id => id.toLocaleLowerCase() === lower,
  );
  if (caseMatches.length === 1) return caseMatches[0];
  const stripped = lower.replace(/^(review|factcheck|fact-check)[\s:_-]*/i, '');
  const prefixMatches = [...knownIds].filter(
    id =>
      id
        .toLocaleLowerCase()
        .replace(/^(review|factcheck|fact-check)[\s:_-]*/i, '') === stripped,
  );
  return prefixMatches.length === 1 ? prefixMatches[0] : null;
}

function normalizeBriefSourceIds(
  value: unknown,
  knownIds: Set<string>,
  warnings: string[],
): string[] | null {
  if (!Array.isArray(value)) return null;
  const normalized: string[] = [];
  for (const item of value) {
    const canonical = normalizeBriefSourceId(item, knownIds);
    if (!canonical) return null;
    const raw = String(item).trim();
    if (raw !== canonical) {
      warnings.push(`Brief sourceId ${raw} 已安全归一化为 ${canonical}`);
    }
    normalized.push(canonical);
  }
  return normalized;
}

function normalizeTarget(value: unknown): {
  kind: BriefTargetKindV31;
  hint?: string;
} | null {
  const allowed = new Set<BriefTargetKindV31>([
    'opening',
    'scene',
    'middle',
    'ending',
    'global',
  ]);
  if (typeof value === 'string') {
    const text = value.trim();
    if (allowed.has(text as BriefTargetKindV31)) {
      return { kind: text as BriefTargetKindV31 };
    }
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const kind = typeof row.kind === 'string' ? row.kind.trim() : '';
  if (!allowed.has(kind as BriefTargetKindV31)) return null;
  const hint = typeof row.hint === 'string' ? row.hint.trim() : '';
  return hint
    ? { kind: kind as BriefTargetKindV31, hint: hint.slice(0, MAX_TEXT) }
    : { kind: kind as BriefTargetKindV31 };
}

/**
 * V3.1 Brief validator. The immutable envelope is local authority: model
 * omission or rewriting of those fields produces a warning and is overridden
 * deterministically before the result can reach Final.
 */
export function validateFinalWritingBriefV31(params: {
  raw: string;
  envelope: FinalWritingBriefImmutableEnvelopeV31;
  /**
   * Provider-scoped tolerance for compact structured output.  It may only
   * fill semantically empty/non-authoritative fields; required source IDs,
   * hard facts, hard constraints and mustFix instructions remain fail-closed.
   */
  compatibility?: StructuredOutputCompatibility;
}): BriefValidationResult {
  const warnings: string[] = [];
  const compactStructuredOutput =
    params.compatibility === 'compact-structured-output';
  const extracted = extractAuditJsonPayload(params.raw.trim());
  if (!extracted.jsonText) {
    return { valid: false, warnings, error: 'Brief V3.1 输出不是完整 JSON' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted.jsonText);
  } catch {
    return { valid: false, warnings, error: 'Brief V3.1 JSON 解析失败' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { valid: false, warnings, error: 'Brief V3.1 根节点不是对象' };
  }
  if (hasLeak(parsed)) {
    return {
      valid: false,
      warnings,
      error: 'Brief V3.1 含机器协议或 Thinking 泄漏',
    };
  }
  const raw = parsed as Record<string, unknown>;
  const defaultArray = (key: string): string[] | null => {
    if (Array.isArray(raw[key])) {
      return strictStringArray(raw, key);
    }
    if (compactStructuredOutput && raw[key] === undefined) {
      warnings.push(`兼容结构化 JSON 缺失 ${key}，已采用安全空数组`);
      return [];
    }
    return null;
  };
  if (Number(raw.schemaVersion) !== 2) {
    return {
      valid: false,
      warnings,
      error: 'Brief V3.1 schemaVersion 必须为 2',
    };
  }

  const immutableKeys = [
    'sourceHash',
    'requiredSourceIds',
    'protectedFacts',
    'hardConstraints',
    'mustNotAdvance',
    'outlineObligations',
    'endingBoundary',
  ] as const;
  for (const key of immutableKeys) {
    const expected = params.envelope[key];
    const actual = raw[key];
    if (
      actual === undefined ||
      JSON.stringify(actual) !== JSON.stringify(expected)
    ) {
      warnings.push(`Brief ${key} 已由本地不可变信封覆盖`);
    }
  }

  const knownIds = new Set(params.envelope.requiredSourceIds);
  let covered: string[] | null;
  if (compactStructuredOutput && raw.coveredRequiredIds === undefined) {
    warnings.push('兼容结构化 JSON 缺失 coveredRequiredIds，已采用安全空数组');
    covered = [];
  } else {
    covered = normalizeBriefSourceIds(
      raw.coveredRequiredIds,
      knownIds,
      warnings,
    );
    if (
      compactStructuredOutput &&
      covered === null &&
      params.envelope.requiredSourceIds.length === 0 &&
      Array.isArray(raw.coveredRequiredIds)
    ) {
      warnings.push(
        '兼容结构化 JSON 含未知可选 coveredRequiredIds，已丢弃；当前无 required/hard 来源',
      );
      covered = [];
    }
  }
  const openingContinuity = defaultArray('openingContinuity');
  const mustPreserve = defaultArray('mustPreserve');
  const styleAdvisories = defaultArray('styleAdvisories');
  const endingState =
    typeof raw.endingState === 'string'
      ? raw.endingState.trim()
      : compactStructuredOutput &&
        raw.endingState === undefined &&
        params.envelope.endingBoundary
      ? (warnings.push(
          '兼容结构化 JSON 缺失 endingState，已继承本地 endingBoundary',
        ),
        params.envelope.endingBoundary)
      : '';
  if (!covered || !openingContinuity || !mustPreserve || !styleAdvisories) {
    return { valid: false, warnings, error: 'Brief V3.1 缺少完整语义字段' };
  }
  if (params.envelope.endingBoundary && !endingState) {
    return { valid: false, warnings, error: 'Brief V3.1 缺少 endingState' };
  }

  if (covered === null || covered.some(id => !knownIds.has(id))) {
    return {
      valid: false,
      warnings,
      error: 'Brief V3.1 coveredRequiredIds 含未知 sourceId',
    };
  }
  if (covered.some(id => !params.envelope.requiredSourceIds.includes(id))) {
    return {
      valid: false,
      warnings,
      error: 'Brief V3.1 coveredRequiredIds 含非 required sourceId',
    };
  }
  const fixesRaw =
    compactStructuredOutput && raw.mustFix === undefined
      ? (warnings.push(
          '兼容结构化 JSON 缺失 mustFix，已采用安全空数组；required/hard 仍需由本地覆盖校验',
        ),
        [])
      : Array.isArray(raw.mustFix)
      ? raw.mustFix
      : null;
  if (!fixesRaw || fixesRaw.length > MAX_MUST_FIX) {
    return {
      valid: false,
      warnings,
      error: 'Brief V3.1 mustFix 结构无效或超过上限',
    };
  }
  const fixIds = new Set<string>();
  const mustFix: FinalWritingBriefV31['mustFix'] = [];
  for (const item of fixesRaw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { valid: false, warnings, error: 'Brief V3.1 mustFix 项结构无效' };
    }
    const row = item as Record<string, unknown>;
    const sourceIds = normalizeBriefSourceIds(
      row.sourceIds,
      knownIds,
      warnings,
    );
    const target = normalizeTarget(row.target);
    if (!sourceIds?.length || sourceIds.some(id => !knownIds.has(id))) {
      if (
        compactStructuredOutput &&
        params.envelope.requiredSourceIds.length === 0
      ) {
        warnings.push(
          '兼容结构化 JSON 含无法归属的可选 mustFix，已丢弃；当前无 required/hard 来源',
        );
        continue;
      }
      return {
        valid: false,
        warnings,
        error: 'Brief V3.1 mustFix 引用了未知 sourceId',
      };
    }
    if (
      !target ||
      typeof row.instruction !== 'string' ||
      !row.instruction.trim()
    ) {
      if (
        compactStructuredOutput &&
        params.envelope.requiredSourceIds.length === 0
      ) {
        warnings.push(
          '兼容结构化 JSON 含不完整的可选 mustFix，已丢弃；当前无 required/hard 来源',
        );
        continue;
      }
      return {
        valid: false,
        warnings,
        error: 'Brief V3.1 mustFix 缺少 target/instruction',
      };
    }
    const preserve = strictStringArray(row, 'preserve');
    if (!preserve) {
      if (
        compactStructuredOutput &&
        params.envelope.requiredSourceIds.length === 0
      ) {
        warnings.push(
          '兼容结构化 JSON 的可选 mustFix preserve 无效，已丢弃；当前无 required/hard 来源',
        );
        continue;
      }
      return {
        valid: false,
        warnings,
        error: 'Brief V3.1 mustFix 缺少 preserve 数组',
      };
    }
    sourceIds.forEach(id => fixIds.add(id));
    mustFix.push({
      sourceIds,
      target,
      instruction: row.instruction.trim().slice(0, MAX_TEXT),
      preserve,
    });
  }
  const locallyCoveredRequiredIds = [...fixIds]
    .filter(id => params.envelope.requiredSourceIds.includes(id))
    .sort();
  if (covered.some(id => !locallyCoveredRequiredIds.includes(id))) {
    warnings.push(
      'Brief coveredRequiredIds 仅作为诊断；最终覆盖集合已由 mustFix.sourceIds 本地计算',
    );
  }
  for (const id of params.envelope.requiredSourceIds) {
    if (!fixIds.has(id)) {
      return {
        valid: false,
        warnings,
        error: `Brief V3.1 未覆盖 required/hard: ${id}`,
      };
    }
  }
  return {
    valid: true,
    warnings,
    brief: {
      ...params.envelope,
      coveredRequiredIds: locallyCoveredRequiredIds,
      openingContinuity,
      mustFix,
      mustPreserve,
      endingState,
      styleAdvisories,
    },
  };
}

/** V3.2 semantic Brief validator.  The envelope is always local authority. */
export function validateFinalWritingBriefV32(params: {
  raw: string;
  envelope: FinalWritingBriefImmutableEnvelopeV32;
}): BriefValidationResult {
  const warnings: string[] = [];
  const extracted = extractAuditJsonPayload(String(params.raw || '').trim());
  if (!extracted.jsonText) {
    return { valid: false, warnings, error: 'Brief V3.2 输出不是完整 JSON' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted.jsonText);
  } catch {
    return { valid: false, warnings, error: 'Brief V3.2 JSON 解析失败' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { valid: false, warnings, error: 'Brief V3.2 根节点不是对象' };
  }
  if (hasLeak(parsed)) {
    return { valid: false, warnings, error: 'Brief V3.2 含机器协议或 Thinking 泄漏' };
  }
  const raw = parsed as Record<string, unknown>;
  const rawVerdict = raw.verdict;
  if (rawVerdict !== 'apply_changes' && rawVerdict !== 'no_changes') {
    return { valid: false, warnings, error: 'Brief V3.2 verdict 无效' };
  }
  for (const key of [
    'schemaVersion',
    'briefPolicyVersion',
    'sourceHash',
    'requiredSourceIds',
    'protectedFacts',
    'hardConstraints',
    'mustNotAdvance',
    'outlineObligations',
    'endingBoundary',
  ]) {
    if (raw[key] !== undefined) {
      warnings.push('Brief V3.2 ' + key + ' 已由本地不可变信封覆盖');
    }
  }
  const knownIds = new Set(params.envelope.requiredSourceIds);
  const instructionsRaw = Array.isArray(raw.instructions) ? raw.instructions : [];
  if (instructionsRaw.length > MAX_MUST_FIX) {
    return { valid: false, warnings, error: 'Brief V3.2 instructions 超过上限' };
  }
  const instructions: FinalWritingBriefV32['instructions'] = [];
  const mustFix: FinalWritingBriefV32['mustFix'] = [];
  const covered = new Set<string>();
  const seen = new Map<string, string>();
  for (let index = 0; index < instructionsRaw.length; index += 1) {
    const item = instructionsRaw[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return {
        valid: false,
        warnings,
        error: 'Brief V3.2 instructions[' + String(index) + '] 结构无效',
      };
    }
    const row = item as Record<string, unknown>;
    const sourceIds = normalizeBriefSourceIds(row.sourceIds, knownIds, warnings);
    const priorityRaw =
      typeof row.priority === 'string' ? row.priority.trim().toLowerCase() : '';
    const priority =
      priorityRaw === 'hard' || priorityRaw === 'required'
        ? priorityRaw
        : priorityRaw === 'advisory' || priorityRaw === 'warning'
        ? 'advisory'
        : null;
    const target = normalizeTarget(row.target);
    const instruction =
      typeof row.instruction === 'string' ? row.instruction.trim() : '';
    if (
      !sourceIds ||
      !sourceIds.length ||
      !priority ||
      !target ||
      !instruction
    ) {
      return {
        valid: false,
        warnings,
        error: 'Brief V3.2 instruction 缺少 sourceIds/priority/target/instruction',
      };
    }
    const preserve = strings(row.preserve);
    for (const sourceId of sourceIds) {
      covered.add(sourceId);
      const previous = seen.get(sourceId);
      if (previous && previous !== instruction && priority !== 'advisory') {
        return {
          valid: false,
          warnings,
          error: 'Brief V3.2 同一 sourceId 存在相互冲突的 hard/required 指令',
        };
      }
      seen.set(sourceId, instruction);
    }
    instructions.push({
      sourceIds,
      priority,
      target: target.kind,
      instruction: instruction.slice(0, MAX_TEXT),
      preserve,
    });
    mustFix.push({
      sourceIds,
      target,
      instruction: instruction.slice(0, MAX_TEXT),
      preserve,
    });
  }
  for (const requiredId of params.envelope.requiredSourceIds) {
    if (!covered.has(requiredId)) {
      return {
        valid: false,
        warnings,
        error: 'Brief V3.2 未覆盖 required/hard: ' + requiredId,
      };
    }
  }
  if (
    rawVerdict === 'no_changes' &&
    params.envelope.requiredSourceIds.length > 0
  ) {
    return {
      valid: false,
      warnings,
      error: 'Brief V3.2 no_changes 不能带有 required/hard sourceId',
    };
  }
  const openingContinuity = strings(raw.openingContinuity);
  const styleAdvisories = strings(raw.styleAdvisories);
  if (
    rawVerdict === 'no_changes' &&
    !openingContinuity.length &&
    !styleAdvisories.length
  ) {
    return {
      valid: false,
      warnings,
      error: 'Brief V3.2 no_changes 缺少开篇衔接或保持策略',
    };
  }
  const brief: FinalWritingBriefV32 = {
    schemaVersion: 3,
    briefPolicyVersion: 3,
    sourceHash: params.envelope.sourceHash,
    requiredSourceIds: params.envelope.requiredSourceIds,
    protectedFacts: params.envelope.protectedFacts,
    hardConstraints: params.envelope.hardConstraints,
    mustNotAdvance: params.envelope.mustNotAdvance,
    outlineObligations: params.envelope.outlineObligations,
    endingBoundary: params.envelope.endingBoundary,
    verdict: rawVerdict,
    coveredRequiredIds: [...covered].filter(id =>
      params.envelope.requiredSourceIds.includes(id),
    ),
    openingContinuity,
    instructions,
    mustFix,
    mustPreserve: params.envelope.protectedFacts,
    endingState: params.envelope.endingBoundary,
    styleAdvisories,
  };
  return {
    valid: true,
    warnings,
    brief,
  };
}

/** Current compact Brief validator. The envelope and source IDs are local. */
export function validateFinalWritingBriefV33(params: {
  raw: string;
  envelope: FinalWritingBriefImmutableEnvelopeV33;
}): BriefValidationResult {
  const warnings: string[] = [];
  const extracted = extractAuditJsonPayload(String(params.raw || '').trim());
  if (!extracted.jsonText) {
    return { valid: false, warnings, error: '当前 Brief 输出不是完整 JSON' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted.jsonText);
  } catch {
    return { valid: false, warnings, error: '当前 Brief JSON 解析失败' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { valid: false, warnings, error: '当前 Brief 根节点不是对象' };
  }
  if (hasLeak(parsed)) {
    return { valid: false, warnings, error: '当前 Brief 含机器协议或 Thinking 泄漏' };
  }
  const raw = parsed as Record<string, unknown>;
  const strategy =
    typeof raw.strategy === 'string' && raw.strategy.trim()
      ? raw.strategy.trim().slice(0, MAX_TEXT)
      : '按已验证意见执行必要修订并保持连续性';
  if (raw.strategy === undefined) {
    warnings.push('当前 Brief 缺少 strategy，已采用安全默认策略');
  }
  const knownIds = new Set(params.envelope.allowedSourceIds);
  const actionsRaw = Array.isArray(raw.actions)
    ? raw.actions
    : Array.isArray(raw.instructions)
    ? raw.instructions
    : [];
  if (actionsRaw.length > MAX_MUST_FIX) {
    return { valid: false, warnings, error: '当前 Brief actions 超过上限' };
  }
  const actions: FinalWritingBriefV33['actions'] = [];
  const mustFix: FinalWritingBriefV33['mustFix'] = [];
  const covered = new Set<string>();
  const seen = new Map<string, string>();
  for (let index = 0; index < actionsRaw.length; index += 1) {
    const item = actionsRaw[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { valid: false, warnings, error: `当前 Brief actions[${index}] 结构无效` };
    }
    const row = item as Record<string, unknown>;
    const covers = normalizeBriefSourceIds(
      row.covers ?? row.sourceIds,
      knownIds,
      warnings,
    );
    const instruction =
      typeof row.instruction === 'string' ? row.instruction.trim() : '';
    if (!covers || !covers.length || !instruction) {
      return {
        valid: false,
        warnings,
        error: '当前 Brief action 缺少 covers/instruction',
      };
    }
    const target = normalizeTarget(row.target || 'global') || {
      kind: 'global' as const,
    };
    const preserve = strings(row.preserve);
    for (const id of covers) {
      const previous = seen.get(id);
      if (previous && previous !== instruction) {
        return {
          valid: false,
          warnings,
          error: '当前 Brief 同一短 ID 存在相互矛盾的 action',
        };
      }
      seen.set(id, instruction);
      covered.add(id);
    }
    const clippedInstruction = instruction.slice(0, MAX_TEXT);
    actions.push({
      covers,
      instruction: clippedInstruction,
      target: target.kind,
      preserve,
    });
    mustFix.push({
      sourceIds: covers,
      target,
      instruction: clippedInstruction,
      preserve,
    });
  }
  for (const id of params.envelope.requiredSourceIds) {
    if (!covered.has(id)) {
      return {
        valid: false,
        warnings,
        error: `当前 Brief 未覆盖 required/hard: ${id}`,
      };
    }
  }
  const preserve = strings(raw.preserve);
  const ending =
    typeof raw.ending === 'string' && raw.ending.trim()
      ? raw.ending.trim().slice(0, MAX_TEXT)
      : params.envelope.endingBoundary;
  if (raw.ending === undefined && params.envelope.endingBoundary) {
    warnings.push('当前 Brief 缺少 ending，已采用本地结尾边界');
  }
  const mustPreserve = [
    ...new Set([...params.envelope.protectedFacts, ...preserve]),
  ];
  const brief: FinalWritingBriefV33 = {
    ...params.envelope,
    strategy,
    actions,
    preserve,
    ending,
    mustFix,
    mustPreserve,
    mustNotAdvance: params.envelope.mustNotAdvance,
    openingContinuity: [],
    endingState: ending,
    styleAdvisories: [],
  };
  return { valid: true, warnings, brief };
}
