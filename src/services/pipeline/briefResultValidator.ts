import { extractAuditJsonPayload } from '../pipelineAuditValidator';
import {
  briefRequiredSourceIds,
  type BriefCompilerInputV1,
  type FinalWritingBriefV1,
} from './briefCompilerTypes';

export interface BriefValidationResult {
  valid: boolean;
  brief?: FinalWritingBriefV1;
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
    return { valid: false, warnings, error: 'Brief 含机器协议或 Thinking 泄漏' };
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
    ...(params.input.review?.executableCorrections || []).map(item => item.sourceId),
    ...(params.input.review?.unlocatedRequired || []).map(item => item.sourceId),
    ...(params.input.factCheck?.corrections || []).map(item => item.sourceId),
  ]);
  const covered = strings(raw.coveredRequiredIds);
  if (covered.some(id => !knownIds.has(id))) {
    return { valid: false, warnings, error: 'Brief coveredRequiredIds 含未知 sourceId' };
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
      return { valid: false, warnings, error: 'Brief mustFix 缺少 instruction' };
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
      return { valid: false, warnings, error: 'Brief 同一 sourceId 被相互矛盾的指令覆盖' };
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
      return { valid: false, warnings, error: `Brief 未覆盖 required/hard: ${id}` };
    }
  }
  const mustNotAdvance = strings(raw.mustNotAdvance);
  const expectedMustNotAdvance = params.input.review?.outlineExecution.mustNotAdvance || [];
  if (expectedMustNotAdvance.some(item => !mustNotAdvance.includes(item))) {
    return { valid: false, warnings, error: 'Brief 丢失 mustNotAdvance' };
  }
  const endingState = typeof raw.endingState === 'string' ? raw.endingState.trim() : '';
  const endingGoal = params.input.review?.outlineExecution.endingGoal?.trim() || '';
  if (endingGoal && !endingState) {
    return { valid: false, warnings, error: 'Brief 丢失 endingGoal 对应的 endingState' };
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
