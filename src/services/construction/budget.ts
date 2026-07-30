import type { ConstructionTarget } from './targets';
import {
  DEFAULT_DETAIL_LEVEL,
  getDetailConstraints,
  normalizeDetailLevel,
  requiredConstructionOutput,
  WORLDBOOK_COLLECTION_OVERHEAD_TOKENS,
  type ConstructionDetailLevel,
} from './quality';

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

/** 默认（丰满）档角色最低输出预留。 */
export const CHARACTER_MIN_OUTPUT = getDetailConstraints(
  DEFAULT_DETAIL_LEVEL,
).character.minOutputTokens;
/** 默认（丰满）档单条世界书的最低输出预留。 */
export const WORLDBOOK_MIN_OUTPUT_PER_ENTRY = getDetailConstraints(
  DEFAULT_DETAIL_LEVEL,
).worldbook.minOutputTokensPerEntry;
export { WORLDBOOK_COLLECTION_OVERHEAD_TOKENS };
/** 世界书条目数量范围（SPEC §7.2）。 */
export const WORLDBOOK_ENTRY_MIN = 2;
export const WORLDBOOK_ENTRY_MAX = 12;
export const DEFAULT_ENTRY_COUNT = getDetailConstraints(
  DEFAULT_DETAIL_LEVEL,
).worldbook.defaultEntryCount;

export interface BudgetInput {
  /** C：当前在线模型的 context_window。 */
  contextWindow: number;
  /** M：当前在线模型的 max_output_tokens。 */
  maxOutputTokens: number;
  /** p：输出预留滑块比例（1–15）。 */
  reservePercent: number;
  /** 目标类型。 */
  target: ConstructionTarget;
  /** 内容丰满度。 */
  detailLevel?: ConstructionDetailLevel;
  /** 世界书条目数量（仅 target='worldbook' 时使用，最少 2）。 */
  entryCount?: number;
}

export interface BudgetResult {
  contextWindow: number;
  maxOutputTokens: number;
  detailLevel: ConstructionDetailLevel;
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
  detailLevel?: ConstructionDetailLevel,
): number {
  return requiredConstructionOutput(
    target,
    target === 'worldbook' ? clampEntryCount(entryCount) : undefined,
    detailLevel,
  );
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
  const detailLevel = normalizeDetailLevel(input.detailLevel);
  const entryCount =
    target === 'worldbook' ? clampEntryCount(input.entryCount) : undefined;
  const requiredMin = requiredMinOutput(target, entryCount, detailLevel);
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
    detailLevel,
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

// ---------- 世界书分批计划（SPEC §6.3 扩展：超预算自动多轮） ----------

/**
 * 当世界书条目数 × 深度档所需 Token 超过单次 outputReserve 时，自动切分为多批。
 * 每批独立发起一次 LLM 调用，最后合并条目；UI 显示「第 X/Y 批」进度。
 *
 * 设计要点：
 * - 阈值缓冲：单批目标 ≤ outputReserve × threshold（默认 0.8），给截断留余量；
 * - 单批上限 maxBatchSize：避免单批过大重新触发超时；
 * - 均匀分配：10 条按每批 4 → [4, 3, 3] 而非 [4, 4, 2]；
 * - 不可行时返回 feasible=false，让 UI 阻断而不是发一个必败的请求。
 */
export interface WorldbookBatchPlan {
  /** 是否需要分批（batchCount > 1）。feasible=false 时为 false。 */
  batched: boolean;
  /** 批次数（≥1；feasible=false 时为 0）。 */
  batchCount: number;
  /** 每批的条目数，例如 [4, 3, 3]；总和等于 entryCount。feasible=false 时为空。 */
  batchSizes: number[];
  /** 每批分配的 max_tokens（统一值，保证所有批都能装下）。 */
  perBatchMaxTokens: number;
  /** 在当前 outputReserve 下能否完成分批。 */
  feasible: boolean;
  /** 说明（用于 UI 展示或错误提示）。 */
  reason: string;
}

export interface WorldbookBatchInput {
  /** 世界书条目数量（会先被 clampEntryCount 归一化到 2–12）。 */
  entryCount: number;
  /** 内容丰满度。 */
  detailLevel?: ConstructionDetailLevel;
  /** 实际可用于输出的 Token（预算模块的 outputReserve）。 */
  outputReserve: number;
  /** 单批目标 / outputReserve 的阈值，超过则必须分批。默认 0.8。 */
  batchThreshold?: number;
  /** 单批最少条目数（防止切太碎）。默认 2。 */
  minBatchSize?: number;
  /** 单批最多条目数（避免单批过大重新触发超时）。默认 6。 */
  maxBatchSize?: number;
}

/** 单批（batchSize 条）目标输出 Token，含 15% 余量（与 worldbookSystemPrompt 对齐）。 */
function worldbookBatchTargetOutput(
  batchSize: number,
  detailLevel: ConstructionDetailLevel,
): number {
  return Math.ceil(
    requiredConstructionOutput('worldbook', batchSize, detailLevel) * 1.15,
  );
}

/** 把 total 按 maxPerBatch 切分成尽量均匀的批次。例如 (10, 4) → [4, 3, 3]。 */
function distributeBatchSizes(total: number, maxPerBatch: number): number[] {
  if (total <= maxPerBatch) return [total];
  const batches: number[] = [];
  let remaining = total;
  while (remaining > 0) {
    const size = Math.min(maxPerBatch, remaining);
    batches.push(size);
    remaining -= size;
  }
  // 若最后一批明显小于首批，从较大的批每次挪 1 条到末尾，缩小批间差距。
  // 用 >= 让多个相同最大值时取最后一个，结果更接近降序（如 [4,4,2] → [4,3,3]）。
  while (batches.length >= 2 && batches[batches.length - 1] < batches[0] - 1) {
    let maxIdx = 0;
    for (let i = 1; i < batches.length; i += 1) {
      if (batches[i] >= batches[maxIdx]) maxIdx = i;
    }
    batches[maxIdx] -= 1;
    batches[batches.length - 1] += 1;
  }
  return batches;
}

/**
 * 根据当前 outputReserve 自动计算世界书是否需要分批、如何分批。
 * 纯函数，不触碰 LLM 或网络，方便单元测试。
 */
export function planWorldbookBatches(
  input: WorldbookBatchInput,
): WorldbookBatchPlan {
  const entryCount = clampEntryCount(input.entryCount);
  const detailLevel = normalizeDetailLevel(input.detailLevel);
  const outputReserve = Math.max(0, Math.floor(input.outputReserve || 0));
  const threshold =
    typeof input.batchThreshold === 'number' && input.batchThreshold > 0
      ? Math.min(1, input.batchThreshold)
      : 0.8;
  const minBatchSize = Math.max(1, Math.floor(input.minBatchSize ?? 2));
  const maxBatchSize = Math.max(
    minBatchSize,
    Math.floor(input.maxBatchSize ?? 6),
  );

  const requiredMin = requiredConstructionOutput(
    'worldbook',
    entryCount,
    detailLevel,
  );

  if (outputReserve <= 0) {
    return {
      batched: false,
      batchCount: 0,
      batchSizes: [],
      perBatchMaxTokens: 0,
      feasible: false,
      reason: '当前输出预留为 0，请先在 LLM 设置中填写上下文容量与最大输出。',
    };
  }
  // 不分批条件：outputReserve ≥ 验收下限（requiredConstructionOutput，不含 15% 余量）。
  // 此时虽可能贴线（prompt 的 15% 余量是软建议），但模型在 max_tokens = outputReserve
  // 内仍有较大概率完成；分批只用于「完全装不下」的场景，避免对刚够的请求过度切分。
  if (outputReserve >= requiredMin) {
    return {
      batched: false,
      batchCount: 1,
      batchSizes: [entryCount],
      perBatchMaxTokens: outputReserve,
      feasible: true,
      reason: '单次调用即可容纳。',
    };
  }

  // 需要分批：找最大的 batchSize 使得单批目标 ≤ outputReserve × threshold。
  const perBatchTokenCeiling = Math.floor(outputReserve * threshold);
  let batchSize = Math.min(maxBatchSize, entryCount);
  while (
    batchSize > minBatchSize &&
    worldbookBatchTargetOutput(batchSize, detailLevel) > perBatchTokenCeiling
  ) {
    batchSize -= 1;
  }

  const minBatchTarget = worldbookBatchTargetOutput(minBatchSize, detailLevel);
  if (minBatchTarget > perBatchTokenCeiling) {
    return {
      batched: false,
      batchCount: 0,
      batchSizes: [],
      perBatchMaxTokens: 0,
      feasible: false,
      reason: `输出预留（${outputReserve.toLocaleString('en-US')} Token）不足以容纳单批最少 ${minBatchSize} 条世界书（每批约 ${minBatchTarget.toLocaleString('en-US')} Token）。请提高输出预留、减少条目数，或使用上下文更大的在线模型。`,
    };
  }

  const batchSizes = distributeBatchSizes(entryCount, batchSize);
  // 每批统一用最大批的目标作为 max_tokens，保证所有批都能装下。
  const perBatchMaxTokens = worldbookBatchTargetOutput(
    Math.max(...batchSizes),
    detailLevel,
  );

  return {
    batched: batchSizes.length > 1,
    batchCount: batchSizes.length,
    batchSizes,
    perBatchMaxTokens,
    feasible: true,
    reason: `已自动拆分为 ${batchSizes.length} 批（${batchSizes.join(' + ')} 条），每批约 ${perBatchMaxTokens.toLocaleString('en-US')} Token。`,
  };
}
