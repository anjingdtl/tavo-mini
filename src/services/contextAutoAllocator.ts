/**
 * 上下文自动化配置：纯计算 + 应用函数。
 *
 * 设计文档：docs/superpowers/specs/2026-07-18-context-auto-config-design.md
 *
 * 顶层分配：maxContextTokens 的 80% 作输入预算、20% 作输出预算。
 * 输入侧再按 65/20/15 拆给滑动窗口/资料/摘要；
 * 输出侧按 50/15/15/20 拆给草稿/审阅/事实/校对。
 * 资源级单项上限按实际数量动态分摊（R1 算法）。
 */

export interface ResourceCounts {
  characters: number;
  notes: number;
  worldbookEntries: number;
  worldbookCollections: number;
}

export interface AllocationResult {
  // 输入侧（写入 ContextConfig）
  slidingWindowSize: number;
  resourceBudget: number;
  summaryBudgetTokens: number;
  // 输出侧（写入 PipelineConfig）
  draftMaxTokens: number;
  reviewMaxTokens: number;
  factCheckMaxTokens: number;
  proofMaxTokens: number;
  // 同步写入 llm_config / presets
  llmContextWindow: number;
  llmMaxOutputTokens: number;
  presetMaxTokens: number;
  // 资源级单项
  characterMaxTokens: number;
  noteMaxTokens: number;
  worldbookEntryMaxTokens: number;
  worldbookCollectionMaxTokens: number;
  // 元信息
  inputBudget: number;
  outputBudget: number;
  resourceCounts: ResourceCounts;
}

// 写死比例
export const RATIO_INPUT = 0.8;
export const RATIO_OUTPUT = 0.2;

// 输入侧内部比例（占 inputBudget）
export const RATIO_SLIDING_WINDOW = 0.65;
export const RATIO_RESOURCE_BUDGET = 0.2;
export const RATIO_SUMMARY_BUDGET = 0.15;

// 输出侧内部比例（占 outputBudget）
export const RATIO_DRAFT = 0.5;
export const RATIO_REVIEW = 0.15;
export const RATIO_FACT_CHECK = 0.15;
export const RATIO_PROOF = 0.2;

// 资料预算内部子比例（contextBuilder.ts 现有约定）
export const RATIO_RESOURCE_CHARACTER = 0.35;
export const RATIO_RESOURCE_NOTE = 0.2;
export const RATIO_RESOURCE_WORLDBOOK = 0.45;

// 数值下限（兜底）
export const MIN_CONTEXT_TOKENS = 1;
export const WARNING_CONTEXT_TOKENS = 8000;
export const MIN_SLIDING_WINDOW = 1000;
export const MIN_SUMMARY_BUDGET = 2000;
export const MIN_RESOURCE_BUDGET = 500;
export const MIN_CHARACTER_TOKENS = 1000;
export const MIN_NOTE_TOKENS = 500;
export const MIN_WORLDBOOK_ENTRY_TOKENS = 500;
export const MIN_WORLDBOOK_COLLECTION_TOKENS = 2000;
export const MIN_PIPELINE_TOKENS = 256;

const floor = (value: number, min: number): number =>
  Math.max(min, Math.round(value));

/**
 * 根据用户输入的 maxContextTokens 和当前资源数量，
 * 计算出所有要覆写的字段值。纯函数，无副作用。
 *
 * @throws Error 当 maxContextTokens <= 0 或非有限数
 */
export function allocateContextBudget(
  maxContextTokens: number,
  resourceCounts: ResourceCounts,
): AllocationResult {
  if (!Number.isFinite(maxContextTokens) || maxContextTokens <= 0) {
    throw new Error(
      `maxContextTokens 必须为正数，收到：${maxContextTokens}`,
    );
  }

  const inputBudget = Math.round(maxContextTokens * RATIO_INPUT);
  const outputBudget = Math.round(maxContextTokens * RATIO_OUTPUT);

  // 输入侧
  const slidingWindowSize = floor(
    inputBudget * RATIO_SLIDING_WINDOW,
    MIN_SLIDING_WINDOW,
  );
  const resourceBudget = floor(
    inputBudget * RATIO_RESOURCE_BUDGET,
    MIN_RESOURCE_BUDGET,
  );
  const summaryBudgetTokens = floor(
    inputBudget * RATIO_SUMMARY_BUDGET,
    MIN_SUMMARY_BUDGET,
  );

  // 输出侧
  const draftMaxTokens = floor(outputBudget * RATIO_DRAFT, MIN_PIPELINE_TOKENS);
  const reviewMaxTokens = floor(
    outputBudget * RATIO_REVIEW,
    MIN_PIPELINE_TOKENS,
  );
  const factCheckMaxTokens = floor(
    outputBudget * RATIO_FACT_CHECK,
    MIN_PIPELINE_TOKENS,
  );
  const proofMaxTokens = floor(
    outputBudget * RATIO_PROOF,
    MIN_PIPELINE_TOKENS,
  );

  // 资料预算内部子分配（角色 35% / 笔记 20% / 世界书 45%）
  const characterTotal = resourceBudget * RATIO_RESOURCE_CHARACTER;
  const noteTotal = resourceBudget * RATIO_RESOURCE_NOTE;
  const worldbookTotal = resourceBudget * RATIO_RESOURCE_WORLDBOOK;

  // 单项 = 子总额 / MAX(数量, 1)，避免除零；count=0 时单项仍计算但不写入（由应用函数处理）
  const safeCount = (n: number): number => Math.max(n, 1);
  const characterMaxTokens = floor(
    characterTotal / safeCount(resourceCounts.characters),
    MIN_CHARACTER_TOKENS,
  );
  const noteMaxTokens = floor(
    noteTotal / safeCount(resourceCounts.notes),
    MIN_NOTE_TOKENS,
  );
  const worldbookEntryMaxTokens = floor(
    worldbookTotal / safeCount(resourceCounts.worldbookEntries),
    MIN_WORLDBOOK_ENTRY_TOKENS,
  );
  const worldbookCollectionMaxTokens = floor(
    worldbookTotal / safeCount(resourceCounts.worldbookCollections),
    MIN_WORLDBOOK_COLLECTION_TOKENS,
  );

  return {
    slidingWindowSize,
    resourceBudget,
    summaryBudgetTokens,
    draftMaxTokens,
    reviewMaxTokens,
    factCheckMaxTokens,
    proofMaxTokens,
    llmContextWindow: Math.round(maxContextTokens),
    llmMaxOutputTokens: outputBudget,
    presetMaxTokens: draftMaxTokens,
    characterMaxTokens,
    noteMaxTokens,
    worldbookEntryMaxTokens,
    worldbookCollectionMaxTokens,
    inputBudget,
    outputBudget,
    resourceCounts,
  };
}
