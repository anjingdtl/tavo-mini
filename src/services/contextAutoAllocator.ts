/**
 * 上下文自动化配置：纯计算 + 应用函数。
 *
 * 设计文档：docs/superpowers/specs/2026-07-18-context-auto-config-design.md
 *
 * 顶层分配：maxContextTokens 的 80% 作输入预算、20% 作输出预算。
 * 输入侧按 45/20/25/10 拆给滑动窗口/资料/全局故事状态/章节事件；
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
  storyStateBudgetTokens: number;
  episodicMemoryBudgetTokens: number;
  memoryPatchMaxTokens: number;
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
export const RATIO_SLIDING_WINDOW = 0.45;
export const RATIO_RESOURCE_BUDGET = 0.2;
export const RATIO_STORY_STATE_BUDGET = 0.25;
export const RATIO_EPISODIC_MEMORY_BUDGET = 0.1;
export const RATIO_SUMMARY_BUDGET =
  RATIO_STORY_STATE_BUDGET + RATIO_EPISODIC_MEMORY_BUDGET;

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
export const MIN_STORY_STATE_BUDGET = 2000;
export const MAX_STORY_STATE_BUDGET = 32000;
export const MIN_EPISODIC_MEMORY_BUDGET = 1000;
export const MAX_EPISODIC_MEMORY_BUDGET = 16000;
export const MIN_MEMORY_PATCH_TOKENS = 800;
export const MAX_MEMORY_PATCH_TOKENS = 4000;
export const MIN_CHARACTER_TOKENS = 1000;
export const MIN_NOTE_TOKENS = 500;
export const MIN_WORLDBOOK_ENTRY_TOKENS = 500;
export const MIN_WORLDBOOK_COLLECTION_TOKENS = 2000;
export const MIN_PIPELINE_TOKENS = 256;

const floor = (value: number, min: number): number =>
  Math.max(min, Math.round(value));
const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(value)));

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

  // 输入侧：极小预算只按比例分配，禁止固定 floor 反向撑爆总预算。
  let resourceBudget: number;
  let storyStateBudgetTokens: number;
  let episodicMemoryBudgetTokens: number;
  let slidingWindowSize: number;
  if (inputBudget < 5000) {
    resourceBudget = Math.max(1, Math.round(inputBudget * RATIO_RESOURCE_BUDGET));
    storyStateBudgetTokens = Math.max(
      1,
      Math.round(inputBudget * RATIO_STORY_STATE_BUDGET),
    );
    episodicMemoryBudgetTokens = Math.max(
      1,
      Math.round(inputBudget * RATIO_EPISODIC_MEMORY_BUDGET),
    );
    slidingWindowSize = Math.max(
      1,
      inputBudget - resourceBudget - storyStateBudgetTokens - episodicMemoryBudgetTokens,
    );
  } else {
    resourceBudget = floor(
      inputBudget * RATIO_RESOURCE_BUDGET,
      MIN_RESOURCE_BUDGET,
    );
    storyStateBudgetTokens = clamp(
      inputBudget * RATIO_STORY_STATE_BUDGET,
      MIN_STORY_STATE_BUDGET,
      MAX_STORY_STATE_BUDGET,
    );
    episodicMemoryBudgetTokens = clamp(
      inputBudget * RATIO_EPISODIC_MEMORY_BUDGET,
      MIN_EPISODIC_MEMORY_BUDGET,
      MAX_EPISODIC_MEMORY_BUDGET,
    );
    slidingWindowSize =
      inputBudget -
      resourceBudget -
      storyStateBudgetTokens -
      episodicMemoryBudgetTokens;
    let deficit = Math.max(0, MIN_SLIDING_WINDOW - slidingWindowSize);
    const episodicReduction = Math.min(
      deficit,
      Math.max(0, episodicMemoryBudgetTokens - 500),
    );
    episodicMemoryBudgetTokens -= episodicReduction;
    deficit -= episodicReduction;
    const storyReduction = Math.min(
      deficit,
      Math.max(0, storyStateBudgetTokens - 1000),
    );
    storyStateBudgetTokens -= storyReduction;
    deficit -= storyReduction;
    const resourceReduction = Math.min(deficit, resourceBudget);
    resourceBudget -= resourceReduction;
    slidingWindowSize =
      inputBudget -
      resourceBudget -
      storyStateBudgetTokens -
      episodicMemoryBudgetTokens;
  }
  const summaryBudgetTokens =
    storyStateBudgetTokens + episodicMemoryBudgetTokens;
  const memoryPatchMaxTokens = clamp(
    storyStateBudgetTokens * 0.1,
    MIN_MEMORY_PATCH_TOKENS,
    MAX_MEMORY_PATCH_TOKENS,
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
    storyStateBudgetTokens,
    episodicMemoryBudgetTokens,
    memoryPatchMaxTokens,
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

// ============================================================================
// 应用函数：以下为有副作用部分，与纯函数分开维护
// ============================================================================

import { openDatabase } from '../data/connection/openDatabase';
import { executeTransaction, type SqlStatement } from './database/transaction';
import { all } from '../data/connection/query';
import {
  buildAppliedRecord,
  setContextAutoLastApplied,
  type ContextAutoAppliedRecord,
} from '../data/repositories/contextAutoRepository';

/**
 * 查询所有项目的资源数量（用于动态分配单项上限）。
 * 跨项目，无 WHERE 限制。
 */
export async function countAllResources(): Promise<ResourceCounts> {
  // 触发数据库初始化（与 connection/query.ts 内部行为一致）
  await openDatabase();
  const countOf = async (table: string): Promise<number> => {
    const rows = await all<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${table}`,
    );
    return Number(rows[0]?.c ?? 0);
  };
  const [characters, notes, worldbookEntries, worldbookCollections] =
    await Promise.all([
      countOf('characters'),
      countOf('notes'),
      countOf('worldbook_entries'),
      countOf('worldbook_collections'),
    ]);
  return { characters, notes, worldbookEntries, worldbookCollections };
}

/**
 * 查询非本地 LLM 配置数（context_window/max_output_tokens 会被覆写）。
 * 本地 llama_cpp 配置不覆写。
 */
export async function countNonLocalLlmConfigs(): Promise<number> {
  const rows = await all<{ c: number }>(
    `SELECT COUNT(*) AS c FROM llm_config WHERE provider_type IS NOT 'llama_cpp' OR provider_type IS NULL`,
  );
  return Number(rows[0]?.c ?? 0);
}

/**
 * 查询 preset 总数。
 */
export async function countAllPresets(): Promise<number> {
  const rows = await all<{ c: number }>(`SELECT COUNT(*) AS c FROM presets`);
  return Number(rows[0]?.c ?? 0);
}

/**
 * 应用上下文自动化分配方案。
 *
 * 单一 executeTransaction 原子写入所有目标字段。任一步失败 → 整体回滚。
 *
 * 1. 读资源数量 + 非本地 LLM 配置数 + preset 数
 * 2. 计算 AllocationResult
 * 3. 构建 SqlStatement[] 一次性执行
 * 4. 写 last_applied 记录（单独调用，主事务已成功后写）
 *
 * @returns 应用记录（含 allocation 与 affectedCounts）
 */
export async function applyContextAutoAllocation(
  maxContextTokens: number,
): Promise<ContextAutoAppliedRecord> {
  // 阶段 1：读 + 算
  const [resourceCounts, llmCount, presetCount] = await Promise.all([
    countAllResources(),
    countNonLocalLlmConfigs(),
    countAllPresets(),
  ]);

  const allocation = allocateContextBudget(maxContextTokens, resourceCounts);

  // 构建语句列表。settings 表用 INSERT OR REPLACE，其他表用 UPDATE。
  // 注意：INSERT OR REPLACE 只覆写单个 key，不会影响其他 settings 字段，
  // 因此 ContextConfig 的 strategy/recentChapterCount 等保留不动，
  // PipelineConfig 的 pipelineMode 与 *PresetId 保留不动。
  const statements: SqlStatement[] = [
    // ContextConfig 字段
    {
      sql: 'INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)',
      params: ['sliding_window_size', String(allocation.slidingWindowSize)],
    },
    {
      sql: 'INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)',
      params: ['resource_budget', String(allocation.resourceBudget)],
    },
    {
      sql: 'INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)',
      params: [
        'summary_budget_tokens',
        String(allocation.summaryBudgetTokens),
      ],
    },
    {
      sql: 'INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)',
      params: ['story_state_budget_tokens', String(allocation.storyStateBudgetTokens)],
    },
    {
      sql: 'INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)',
      params: ['episodic_memory_budget_tokens', String(allocation.episodicMemoryBudgetTokens)],
    },
    {
      sql: 'INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)',
      params: ['memory_patch_max_tokens', String(allocation.memoryPatchMaxTokens)],
    },
    // PipelineConfig 字段
    {
      sql: 'INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)',
      params: [
        'pipeline_draft_max_tokens',
        String(allocation.draftMaxTokens),
      ],
    },
    {
      sql: 'INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)',
      params: [
        'pipeline_review_max_tokens',
        String(allocation.reviewMaxTokens),
      ],
    },
    {
      sql: 'INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)',
      params: [
        'pipeline_factcheck_max_tokens',
        String(allocation.factCheckMaxTokens),
      ],
    },
    {
      sql: 'INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)',
      params: [
        'pipeline_proof_max_tokens',
        String(allocation.proofMaxTokens),
      ],
    },
    // llm_config：仅非本地配置
    {
      sql: `UPDATE llm_config SET context_window = ?, max_output_tokens = ?
            WHERE provider_type IS NOT 'llama_cpp' OR provider_type IS NULL`,
      params: [allocation.llmContextWindow, allocation.llmMaxOutputTokens],
    },
    // presets：全部
    {
      sql: 'UPDATE presets SET max_tokens = ?',
      params: [allocation.presetMaxTokens],
    },
  ];

  // 资源表：仅 count > 0 时加入
  if (resourceCounts.characters > 0) {
    statements.push({
      sql: 'UPDATE characters SET max_tokens = ?',
      params: [allocation.characterMaxTokens],
    });
  }
  if (resourceCounts.notes > 0) {
    statements.push({
      sql: 'UPDATE notes SET max_tokens = ?',
      params: [allocation.noteMaxTokens],
    });
  }
  if (resourceCounts.worldbookEntries > 0) {
    statements.push({
      sql: 'UPDATE worldbook_entries SET max_tokens = ?',
      params: [allocation.worldbookEntryMaxTokens],
    });
  }
  if (resourceCounts.worldbookCollections > 0) {
    statements.push({
      sql: 'UPDATE worldbook_collections SET max_tokens = ?',
      params: [allocation.worldbookCollectionMaxTokens],
    });
  }

  // 阶段 2：执行单一事务
  const db = await openDatabase();
  await executeTransaction(db, statements);

  // 阶段 3：写 last_applied 记录（与主事务分开，避免读现有值与执行时机冲突）
  const record = buildAppliedRecord(maxContextTokens, allocation, {
    llmConfigs: llmCount,
    presets: presetCount,
    characters: resourceCounts.characters,
    notes: resourceCounts.notes,
    worldbookEntries: resourceCounts.worldbookEntries,
    worldbookCollections: resourceCounts.worldbookCollections,
  });
  await setContextAutoLastApplied(record);

  return record;
}
