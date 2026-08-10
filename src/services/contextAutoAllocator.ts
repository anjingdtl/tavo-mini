/**
 * 上下文自动化配置：纯计算 + 应用函数。
 *
 * 设计文档：docs/superpowers/specs/2026-07-18-context-auto-config-design.md
 *
 * 顶层分配：maxContextTokens 的 80% 作输入预算、20% 作模型输出上限。
 * 输入侧按 45/20/25/10 拆给滑动窗口/资料/全局故事状态/章节事件；
 * 大纲流水线阶段预算不在这里切分，而是在任务首次运行时按模型能力
 * 为五个独立请求分别冻结 20% reservation。
 * 资源级单项上限按实际数量动态分摊（R1 算法）。
 */

import {
  cloneDefaultContextAutomationPolicy,
  DEFAULT_CONTEXT_AUTOMATION_POLICY_V2,
  serializeContextAutomationPolicy,
  type ContextAutomationPolicyV2,
  DEFAULT_OUTLINE_PIPELINE_BUDGET_POLICY_V3,
  type OutlinePipelineBudgetPolicyV3,
  type OutlinePipelineStageV3,
  type OutlineReasoningTierV3,
} from './contextAutomationPolicy';

export {
  buildContinuationPolicyPreview,
  cloneDefaultContextAutomationPolicy,
  cloneDefaultOutlinePipelineBudgetPolicyV3,
  DEFAULT_CONTEXT_AUTOMATION_POLICY_V2,
  DEFAULT_OUTLINE_PIPELINE_BUDGET_POLICY_V3,
  hashContextAutomationPolicy,
  isContextAutomationPolicyV2,
  isOutlinePipelineBudgetPolicyV3,
  serializeContextAutomationPolicy,
} from './contextAutomationPolicy';
export type {
  ContextAutomationPolicyV2,
  ContinuationContextCategory,
  ContinuationPolicyPreview,
  ContinuationV4Stage,
  RatioCurve,
  StageRatioRule,
  OutlinePipelineBudgetPolicyV3,
  OutlinePipelineStageV3,
  OutlineReasoningTierV3,
  StageBudgetPolicyV3,
} from './contextAutomationPolicy';

export interface OutlineStageBudgetAllocationV3 {
  stage: OutlinePipelineStageV3;
  requestedTier: OutlineReasoningTierV3;
  effectiveTier: OutlineReasoningTierV3;
  visibleOutputFloor: number;
  reasoningHeadroom: number;
  requestMaxTokens: number;
  estimatedMandatoryInputTokens: number;
  softInputLimit: number;
  hardInputLimit: number;
  safetyReserveTokens: number;
  optionalInputBudget: number;
  fitsModelOutput: boolean;
  fitsSoftInput: boolean;
  fitsContextWindow: boolean;
  localFallbackRecommended: boolean;
}

export interface OutlinePipelineBudgetAllocationV3 {
  schemaVersion: 3;
  allocatorVersion: 'outline-pipeline-budget-v3';
  contextWindow: number;
  requestedTier: OutlineReasoningTierV3;
  stages: Record<OutlinePipelineStageV3, OutlineStageBudgetAllocationV3>;
}

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
  // 同步写入 llm_config / presets；大纲阶段不再写 PipelineConfig 固定值
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

// Legacy outline ratios are sourced from the versioned policy preset.
export const RATIO_INPUT =
  DEFAULT_CONTEXT_AUTOMATION_POLICY_V2.outlineCompatibility.inputRatio;
export const RATIO_OUTPUT =
  DEFAULT_CONTEXT_AUTOMATION_POLICY_V2.outlineCompatibility.outputRatio;

// 输入侧内部比例（占 inputBudget）
export const RATIO_SLIDING_WINDOW =
  DEFAULT_CONTEXT_AUTOMATION_POLICY_V2.outlineCompatibility.slidingWindowRatio;
export const RATIO_RESOURCE_BUDGET =
  DEFAULT_CONTEXT_AUTOMATION_POLICY_V2.outlineCompatibility.resourceBudgetRatio;
export const RATIO_STORY_STATE_BUDGET =
  DEFAULT_CONTEXT_AUTOMATION_POLICY_V2.outlineCompatibility
    .storyStateBudgetRatio;
export const RATIO_EPISODIC_MEMORY_BUDGET =
  DEFAULT_CONTEXT_AUTOMATION_POLICY_V2.outlineCompatibility
    .episodicMemoryBudgetRatio;
export const RATIO_SUMMARY_BUDGET =
  RATIO_STORY_STATE_BUDGET + RATIO_EPISODIC_MEMORY_BUDGET;

// 资料预算内部子比例（contextBuilder.ts 现有约定）
export const RATIO_RESOURCE_CHARACTER =
  DEFAULT_CONTEXT_AUTOMATION_POLICY_V2.outlineCompatibility
    .resourceCharacterRatio;
export const RATIO_RESOURCE_NOTE =
  DEFAULT_CONTEXT_AUTOMATION_POLICY_V2.outlineCompatibility.resourceNoteRatio;
export const RATIO_RESOURCE_WORLDBOOK =
  DEFAULT_CONTEXT_AUTOMATION_POLICY_V2.outlineCompatibility
    .resourceWorldbookRatio;

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
/**
 * Per-request output reserve in the elastic outline envelope.  DeepSeek's
 * 1M context / 200K output configuration naturally lands here; this is an
 * envelope derived from the model window, not a Brief-specific cap.
 */
export const ELASTIC_STAGE_OUTPUT_RESERVE_RATIO = 0.2;

const floor = (value: number, min: number): number =>
  Math.max(min, Math.round(value));
const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(value)));

/**
 * Resolve the output reservation for one elastic stage request.
 *
 * The configured model output ceiling is preserved when it fits inside the
 * per-request 20% reserve; when a gateway reports a larger ceiling, the
 * reserve remains derived from the current context window.  This keeps every
 * stage on the same elastic envelope and avoids inventing a tiny Brief-only
 * max_tokens value.
 */
export function resolveElasticStageOutputReservation(params: {
  contextWindow: number;
  modelMaxOutputTokens?: number | null;
}): number {
  const contextWindow = Math.max(0, Math.floor(Number(params.contextWindow) || 0));
  const configured = Math.max(
    0,
    Math.floor(Number(params.modelMaxOutputTokens) || 0),
  );
  const reserve = Math.floor(
    contextWindow * ELASTIC_STAGE_OUTPUT_RESERVE_RATIO,
  );
  if (configured > 0 && reserve > 0) {
    return Math.max(MIN_PIPELINE_TOKENS, Math.min(configured, reserve));
  }
  if (configured > 0) return Math.max(MIN_PIPELINE_TOKENS, configured);
  return Math.max(MIN_PIPELINE_TOKENS, reserve);
}

/**
 * 根据用户输入的 maxContextTokens 和当前资源数量，
 * 计算出所有要覆写的字段值。纯函数，无副作用。
 *
 * @throws Error 当 maxContextTokens <= 0 或非有限数
 */
export function allocateContextBudget(
  maxContextTokens: number,
  resourceCounts: ResourceCounts,
  policy: ContextAutomationPolicyV2 = DEFAULT_CONTEXT_AUTOMATION_POLICY_V2,
): AllocationResult {
  if (!Number.isFinite(maxContextTokens) || maxContextTokens <= 0) {
    throw new Error(`maxContextTokens 必须为正数，收到：${maxContextTokens}`);
  }

  const outline = policy.outlineCompatibility;
  const inputBudget = Math.round(maxContextTokens * outline.inputRatio);
  const outputBudget = Math.round(maxContextTokens * outline.outputRatio);

  // 输入侧：极小预算只按比例分配，禁止固定 floor 反向撑爆总预算。
  let resourceBudget: number;
  let storyStateBudgetTokens: number;
  let episodicMemoryBudgetTokens: number;
  let slidingWindowSize: number;
  if (inputBudget < 5000) {
    resourceBudget = Math.max(
      1,
      Math.round(inputBudget * outline.resourceBudgetRatio),
    );
    storyStateBudgetTokens = Math.max(
      1,
      Math.round(inputBudget * outline.storyStateBudgetRatio),
    );
    episodicMemoryBudgetTokens = Math.max(
      1,
      Math.round(inputBudget * outline.episodicMemoryBudgetRatio),
    );
    slidingWindowSize = Math.max(
      1,
      inputBudget -
        resourceBudget -
        storyStateBudgetTokens -
        episodicMemoryBudgetTokens,
    );
  } else {
    resourceBudget = floor(
      inputBudget * outline.resourceBudgetRatio,
      MIN_RESOURCE_BUDGET,
    );
    storyStateBudgetTokens = clamp(
      inputBudget * outline.storyStateBudgetRatio,
      MIN_STORY_STATE_BUDGET,
      MAX_STORY_STATE_BUDGET,
    );
    episodicMemoryBudgetTokens = clamp(
      inputBudget * outline.episodicMemoryBudgetRatio,
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

  // 资料预算内部子分配（角色 35% / 笔记 20% / 世界书 45%）
  const characterTotal = resourceBudget * outline.resourceCharacterRatio;
  const noteTotal = resourceBudget * outline.resourceNoteRatio;
  const worldbookTotal = resourceBudget * outline.resourceWorldbookRatio;

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
    llmContextWindow: Math.round(maxContextTokens),
    llmMaxOutputTokens: outputBudget,
    presetMaxTokens: outputBudget,
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
  getContextAutomationPolicy,
  setContextAutoLastApplied,
  setContextAutomationPolicy,
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
    const rows = await all<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`);
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
 * 查询 LLM 配置数。
 */
export async function countLlmConfigs(): Promise<number> {
  const rows = await all<{ c: number }>('SELECT COUNT(*) AS c FROM llm_config');
  return Number(rows[0]?.c ?? 0);
}

/** @deprecated Kept as an alias for callers compiled against the previous API. */
export const countNonLocalLlmConfigs = countLlmConfigs;

/**
 * 查询 preset 总数。
 */
export async function countAllPresets(): Promise<number> {
  const rows = await all<{ c: number }>(`SELECT COUNT(*) AS c FROM presets`);
  return Number(rows[0]?.c ?? 0);
}

/**
 * Load the persisted policy or create the single versioned default preset for
 * installations that predate ContextAutomationPolicyV2.
 */
export async function ensureContextAutomationPolicy(): Promise<ContextAutomationPolicyV2> {
  const persisted = await getContextAutomationPolicy();
  if (persisted) return persisted;
  const policy = cloneDefaultContextAutomationPolicy();
  await setContextAutomationPolicy(policy);
  return policy;
}

/**
 * 应用上下文自动化分配方案。
 *
 * 单一 executeTransaction 原子写入所有目标字段。任一步失败 → 整体回滚。
 *
 * 1. 读资源数量 + LLM 配置数 + preset 数
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
  const [resourceCounts, llmCount, presetCount, persistedPolicy] =
    await Promise.all([
      countAllResources(),
      countLlmConfigs(),
      countAllPresets(),
      getContextAutomationPolicy(),
    ]);

  const policy = persistedPolicy || cloneDefaultContextAutomationPolicy();
  const allocation = allocateContextBudget(
    maxContextTokens,
    resourceCounts,
    policy,
  );
  const serializedPolicy = serializeContextAutomationPolicy(policy);

  // 构建语句列表。settings 表用 INSERT OR REPLACE，其他表用 UPDATE。
  // 注意：INSERT OR REPLACE 只覆写单个 key，不会影响其他 settings 字段，
  // 因此 ContextConfig 的 strategy/recentChapterCount 等保留不动，
  // PipelineConfig 的 pipelineMode 与 *PresetId 保留不动。
  const statements: SqlStatement[] = [
    {
      sql: 'INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)',
      params: ['context_auto_input', String(Math.round(maxContextTokens))],
    },
    {
      sql: 'INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)',
      params: ['context_auto_policy_v2', serializedPolicy],
    },
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
      params: ['summary_budget_tokens', String(allocation.summaryBudgetTokens)],
    },
    {
      sql: 'INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)',
      params: [
        'story_state_budget_tokens',
        String(allocation.storyStateBudgetTokens),
      ],
    },
    {
      sql: 'INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)',
      params: [
        'episodic_memory_budget_tokens',
        String(allocation.episodicMemoryBudgetTokens),
      ],
    },
    {
      sql: 'INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)',
      params: [
        'memory_patch_max_tokens',
        String(allocation.memoryPatchMaxTokens),
      ],
    },
    // llm_config
    {
      sql: 'UPDATE llm_config SET context_window = ?, max_output_tokens = ?',
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
  const record = buildAppliedRecord(
    maxContextTokens,
    allocation,
    {
      llmConfigs: llmCount,
      presets: presetCount,
      characters: resourceCounts.characters,
      notes: resourceCounts.notes,
      worldbookEntries: resourceCounts.worldbookEntries,
      worldbookCollections: resourceCounts.worldbookCollections,
    },
    policy,
  );
  await setContextAutoLastApplied(record);

  return record;
}

const OUTLINE_PIPELINE_STAGES_V3: OutlinePipelineStageV3[] = [
  'draft',
  'review',
  'factCheck',
  'brief',
  'proof',
];

/** Resolve one independent reservation for every current outline stage. */
export function resolveOutlineElasticStageReservations(params: {
  contextWindow: number;
  modelMaxOutputTokens?: number | null;
}): Record<OutlinePipelineStageV3, number> {
  const reservation = resolveElasticStageOutputReservation({
    contextWindow: params.contextWindow,
    modelMaxOutputTokens: params.modelMaxOutputTokens,
  });
  return Object.fromEntries(
    OUTLINE_PIPELINE_STAGES_V3.map(stage => [stage, reservation]),
  ) as Record<OutlinePipelineStageV3, number>;
}

function resolveOutlineStageTierV3(
  requestedTier: OutlineReasoningTierV3,
  stage: OutlinePipelineStageV3,
): OutlineReasoningTierV3 {
  if (stage === 'brief' || stage === 'factCheck') return 'low';
  return requestedTier;
}

/**
 * Allocate the V3 outline pipeline with visible output and hidden Thinking
 * accounted for separately. Review follows the selected product tier,
 * including max; FactCheck and Brief retain their low Thinking reservation.
 * An output-cap shortage is never permission to disable Thinking; callers
 * should use the local deterministic Brief when `fitsModelOutput` is false.
 */
export function allocateOutlinePipelineBudgetV3(params: {
  contextWindow: number;
  requestedTier: OutlineReasoningTierV3;
  modelMaxOutputTokens?: number;
  requestMaxTokenOverrides?: Partial<
    Record<OutlinePipelineStageV3, number>
  >;
  visibleOutputFloors?: Partial<Record<OutlinePipelineStageV3, number>>;
  estimatedMandatoryInputTokens?: Partial<
    Record<OutlinePipelineStageV3, number>
  >;
  policy?: OutlinePipelineBudgetPolicyV3;
}): OutlinePipelineBudgetAllocationV3 {
  const {
    contextWindow,
    requestedTier,
    modelMaxOutputTokens,
    requestMaxTokenOverrides,
    visibleOutputFloors,
    estimatedMandatoryInputTokens,
  } = params;
  const policy = params.policy ?? DEFAULT_OUTLINE_PIPELINE_BUDGET_POLICY_V3;

  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    throw new Error(`contextWindow 必须为正数，收到：${contextWindow}`);
  }
  if (!['low', 'high', 'max'].includes(requestedTier)) {
    throw new Error(`不支持的 V3 推理档位：${requestedTier}`);
  }

  const stages = {} as Record<
    OutlinePipelineStageV3,
    OutlineStageBudgetAllocationV3
  >;

  for (const stage of OUTLINE_PIPELINE_STAGES_V3) {
    const stagePolicy = policy.stages[stage];
    const visibleOverride = visibleOutputFloors?.[stage];
    const visibleOutputFloor = Math.max(
      MIN_PIPELINE_TOKENS,
      Math.ceil(
        Number.isFinite(visibleOverride) && (visibleOverride ?? 0) > 0
          ? (visibleOverride as number)
          : stagePolicy.visibleOutputFloor,
      ),
    );
    const effectiveTier = resolveOutlineStageTierV3(requestedTier, stage);
    const reasoningHeadroom = Math.max(
      MIN_PIPELINE_TOKENS,
      Math.ceil(stagePolicy.reasoningHeadroom[effectiveTier]),
    );
    const defaultRequestMaxTokens = visibleOutputFloor + reasoningHeadroom;
    const requestOverride = requestMaxTokenOverrides?.[stage];
    const requestMaxTokens =
      Number.isFinite(requestOverride) && (requestOverride ?? 0) > 0
        ? Math.max(MIN_PIPELINE_TOKENS, Math.ceil(requestOverride as number))
        : defaultRequestMaxTokens;
    const estimatedMandatory = Math.max(
      0,
      Math.ceil(estimatedMandatoryInputTokens?.[stage] ?? 0),
    );
    const safetyReserveTokens = Math.max(
      MIN_PIPELINE_TOKENS,
      Math.ceil(contextWindow * stagePolicy.safetyMarginRatio),
    );
    const hardInputLimit = Math.max(
      0,
      contextWindow - requestMaxTokens - safetyReserveTokens,
    );
    const softInputLimit = Math.max(
      0,
      Math.floor(contextWindow * 0.8) - requestMaxTokens - safetyReserveTokens,
    );
    const optionalInputBudget = Math.max(
      0,
      softInputLimit - estimatedMandatory,
    );
    const configuredOutputCap = stagePolicy.maxOutputCap ?? Infinity;
    const availableOutput = Math.min(
      configuredOutputCap,
      Number.isFinite(modelMaxOutputTokens) && (modelMaxOutputTokens ?? 0) > 0
        ? (modelMaxOutputTokens as number)
        : Infinity,
    );
    // `requestMaxTokens` is the provider reservation.  The visible JSON and
    // low/high/max reasoning contract is a separate minimum-fit check; a
    // larger elastic reservation must not be mistaken for a tier upgrade.
    const fitsModelOutput =
      availableOutput >= visibleOutputFloor + reasoningHeadroom;
    const fitsSoftInput = estimatedMandatory <= softInputLimit;
    const fitsContextWindow = estimatedMandatory <= hardInputLimit;

    stages[stage] = {
      stage,
      requestedTier,
      effectiveTier,
      visibleOutputFloor,
      reasoningHeadroom,
      requestMaxTokens,
      estimatedMandatoryInputTokens: estimatedMandatory,
      softInputLimit,
      hardInputLimit,
      safetyReserveTokens,
      optionalInputBudget,
      fitsModelOutput,
      fitsSoftInput,
      fitsContextWindow,
      localFallbackRecommended: stage === 'brief' && !fitsModelOutput,
    };
  }

  return {
    schemaVersion: 3,
    allocatorVersion: 'outline-pipeline-budget-v3',
    contextWindow,
    requestedTier,
    stages,
  };
}

/**
 * Build the five-stage preview with the exact same per-stage resolver used by
 * task snapshot freezing.  The UI may display this result, but it must not
 * reconstruct the 20% rule or the stage policy itself.
 */
export function buildOutlineElasticBudgetPreview(params: {
  contextWindow: number;
  modelMaxOutputTokens?: number | null;
  requestedTier?: OutlineReasoningTierV3;
  policy?: OutlinePipelineBudgetPolicyV3;
}): OutlinePipelineBudgetAllocationV3 {
  const requestedTier = params.requestedTier ?? 'low';
  const requestMaxTokens = resolveOutlineElasticStageReservations(params);
  return allocateOutlinePipelineBudgetV3({
    contextWindow: params.contextWindow,
    requestedTier,
    modelMaxOutputTokens: params.modelMaxOutputTokens ?? undefined,
    requestMaxTokenOverrides: requestMaxTokens,
    policy: params.policy,
  });
}
