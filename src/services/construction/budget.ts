import type { ConstructionTarget } from './targets';

/**
 * 「构建」模块的上下文 / 输出预算计算（SPEC.MD §6.2 / §6.3）。
 *
 * 全部为纯函数，不触碰 LLM、网络或 UI，方便单元测试。
 *
 * 记号：
 * - C = context_window（本次在线模型的最大上下文容量）
 * - M = max_output_tokens（该配置允许的最大输出上限）
 * - p = 输出预留滑块比例（1%–15%，整数）
 * - S = 安全余量
 *
 * 公式：
 *   requestedOutput = round(C × p)
 *   S = max(256, min(1024, round(C × 1%)))
 *   outputReserve   = min(requestedOutput, M, C − S)
 *   sourceBudget    = C − outputReserve − S
 */

export const RESERVE_PERCENT_MIN = 1;
export const RESERVE_PERCENT_MAX = 15;
export const DEFAULT_RESERVE_PERCENT = 5;

/** 角色卡最低输出预留（SPEC §6.3）。 */
export const CHARACTER_MIN_OUTPUT = 512;
/** 单条世界书条目最低输出预留（SPEC §6.3，合集最低 256 × 条目数）。 */
export const WORLDBOOK_MIN_OUTPUT_PER_ENTRY = 256;
/** 世界书条目数量范围（SPEC §7.2）。 */
export const WORLDBOOK_ENTRY_MIN = 2;
export const WORLDBOOK_ENTRY_MAX = 12;
export const DEFAULT_ENTRY_COUNT = 6;

export interface BudgetInput {
  /** C：当前在线模型的 context_window。 */
  contextWindow: number;
  /** M：当前在线模型的 max_output_tokens。 */
  maxOutputTokens: number;
  /** p：输出预留滑块比例（1–15）。 */
  reservePercent: number;
  /** 目标类型。 */
  target: ConstructionTarget;
  /** 世界书条目数量（仅 target='worldbook' 时使用，最少 2）。 */
  entryCount?: number;
}

export interface BudgetResult {
  contextWindow: number;
  maxOutputTokens: number;
  reservePercent: number;
  /** S：安全余量。 */
  safetyMargin: number;
  /** round(C × p)：滑块期望的输出预留。 */
  requestedOutput: number;
  /** 实际可用于输出的 Token（受 M 与 C−S 限制）。 */
  outputReserve: number;
  /** 可用于来源内容的 Token 预算。 */
  sourceBudget: number;
  /** 该目标类型要求的最低输出预留。 */
  requiredMinOutput: number;
  /** 满足最低预留所需的最小滑块比例（1–15）；null 表示任意比例都达不到。 */
  minReservePercent: number | null;
  /** 在 1–15 范围内是否存在能满足最低预留的比例。 */
  feasible: boolean;
  /** 当前滑块比例是否已满足最低预留（可生成）。 */
  generatable: boolean;
  /** outputReserve 因 M 不足而被压低。 */
  cappedByMaxOutput: boolean;
  /** outputReserve 因 C−S 不足而被压低。 */
  cappedByContext: boolean;
  /** 规范化后的条目数量（世界书）。 */
  entryCount?: number;
  /** 面向用户的中文状态说明。 */
  reason: string;
}

/** 把任意输入归一化到合法滑块范围。 */
export function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return DEFAULT_RESERVE_PERCENT;
  const rounded = Math.round(percent);
  if (rounded < RESERVE_PERCENT_MIN) return RESERVE_PERCENT_MIN;
  if (rounded > RESERVE_PERCENT_MAX) return RESERVE_PERCENT_MAX;
  return rounded;
}

/** 把世界书条目数量归一化到 2–12。 */
export function clampEntryCount(count?: number): number {
  if (!Number.isFinite(count) || count == null) return DEFAULT_ENTRY_COUNT;
  const rounded = Math.round(count);
  if (rounded < WORLDBOOK_ENTRY_MIN) return WORLDBOOK_ENTRY_MIN;
  if (rounded > WORLDBOOK_ENTRY_MAX) return WORLDBOOK_ENTRY_MAX;
  return rounded;
}

/** 安全余量 S = max(256, min(1024, round(C × 1%)))。 */
export function computeSafetyMargin(contextWindow: number): number {
  const c = Math.max(0, Math.floor(contextWindow || 0));
  return Math.max(256, Math.min(1024, Math.round((c * 1) / 100)));
}

/** 某目标类型所需的最低输出预留 Token。 */
export function requiredMinOutput(
  target: ConstructionTarget,
  entryCount?: number,
): number {
  if (target === 'character') return CHARACTER_MIN_OUTPUT;
  return WORLDBOOK_MIN_OUTPUT_PER_ENTRY * clampEntryCount(entryCount);
}

function reserveAtPercent(contextWindow: number, percent: number): number {
  return Math.round((contextWindow * percent) / 100);
}

/**
 * 在 1–15 中寻找最小满足「实际输出 ≥ requiredMin」的滑块比例。
 * 返回 null 表示即便拉满也无法满足（M 或 C−S 小于 requiredMin）。
 */
export function findMinReservePercent(
  contextWindow: number,
  maxOutputTokens: number,
  requiredMin: number,
): number | null {
  const C = Math.max(0, Math.floor(contextWindow || 0));
  const M = Math.max(0, Math.floor(maxOutputTokens || 0));
  const S = computeSafetyMargin(C);
  const ceiling = Math.min(M, C - S);
  if (ceiling < requiredMin) return null;
  for (let p = RESERVE_PERCENT_MIN; p <= RESERVE_PERCENT_MAX; p += 1) {
    const requested = reserveAtPercent(C, p);
    if (Math.min(requested, M, C - S) >= requiredMin) return p;
  }
  return null;
}

export function computeConstructionBudget(input: BudgetInput): BudgetResult {
  const C = Math.max(0, Math.floor(input.contextWindow || 0));
  const M = Math.max(0, Math.floor(input.maxOutputTokens || 0));
  const target = input.target;
  const entryCount =
    target === 'worldbook' ? clampEntryCount(input.entryCount) : undefined;
  const requiredMin = requiredMinOutput(target, entryCount);
  const percent = clampPercent(input.reservePercent);
  const S = computeSafetyMargin(C);
  const requestedOutput = reserveAtPercent(C, percent);
  const contextCeiling = C - S;
  const outputReserve = Math.min(requestedOutput, M, contextCeiling);
  const sourceBudget = Math.max(0, C - outputReserve - S);
  const cappedByMaxOutput = M < requestedOutput;
  const cappedByContext = contextCeiling < requestedOutput;
  const minReservePercent = findMinReservePercent(C, M, requiredMin);
  const feasible = minReservePercent !== null;
  const generatable = outputReserve >= requiredMin;

  const ceiling = Math.min(M, contextCeiling);

  let reason: string;
  if (C <= 0) {
    reason = '当前 LLM 未配置上下文容量，请在 LLM 设置中填写。';
  } else if (!feasible) {
    // 两种不可行：输出上限本身不够 / 需要超过 15% 的预留
    if (target === 'worldbook') {
      reason =
        ceiling < requiredMin
          ? `输出上限（${ceiling} Token）不足以生成 ${entryCount} 条世界书条目（至少需要 ${requiredMin} Token）。请减少条目数，或使用输出更大的在线模型。`
          : `需要超过 ${RESERVE_PERCENT_MAX}% 的输出预留才能生成 ${entryCount} 条世界书条目（至少需要 ${requiredMin} Token）。请减少条目数，或使用上下文更大的在线模型。`;
    } else {
      reason =
        ceiling < requiredMin
          ? `输出上限（${ceiling} Token）不足以生成角色卡（至少需要 ${requiredMin} Token）。请使用输出更大的在线模型。`
          : `需要超过 ${RESERVE_PERCENT_MAX}% 的输出预留才能生成角色卡（至少需要 ${requiredMin} Token）。请使用上下文更大的在线模型。`;
    }
  } else if (!generatable) {
    const label =
      target === 'worldbook' ? '世界书合集' : '角色卡';
    reason = `输出预留不足，${label}至少需要 ${requiredMin} Token。请将输出预留提高到 ${minReservePercent}%。`;
  } else {
    reason = '容量校验通过。';
  }

  return {
    contextWindow: C,
    maxOutputTokens: M,
    reservePercent: percent,
    safetyMargin: S,
    requestedOutput,
    outputReserve,
    sourceBudget,
    requiredMinOutput: requiredMin,
    minReservePercent,
    feasible,
    generatable,
    cappedByMaxOutput,
    cappedByContext,
    entryCount,
    reason,
  };
}

/** 格式化为「5% · 1,638 Token」这类展示文本。 */
export function formatReserveLabel(percent: number, tokens: number): string {
  return `${percent}% · ${Math.max(0, Math.round(tokens)).toLocaleString('en-US')} Token`;
}
