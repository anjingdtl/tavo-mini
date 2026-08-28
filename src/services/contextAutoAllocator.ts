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
  type ContextAutomationPolicyV2,
  DEFAULT_OUTLINE_PIPELINE_BUDGET_POLICY_V3,
  type OutlinePipelineBudgetPolicyV3,
  type OutlinePipelineStageV3,
  type OutlineReasoningTierV3,
  cloneDefaultContextAutomationPolicyV3,
  hashContextAutomationPolicyV3,
  isContextAutomationPolicyV3,
  serializeContextAutomationPolicyV3,
  type ContextAutomationPolicyV3,
} from './contextAutomationPolicy';
import {
  requireModelContextWindow,
  resolveEffectiveMaxOutputTokens,
} from './llm/providerCapabilities';

export {
  buildContinuationPolicyPreview,
  cloneDefaultContextAutomationPolicy,
  cloneDefaultContextAutomationPolicyV3,
  cloneDefaultOutlinePipelineBudgetPolicyV3,
  DEFAULT_CONTEXT_AUTOMATION_POLICY_V2,
  DEFAULT_CONTEXT_AUTOMATION_POLICY_V3,
  DEFAULT_OUTLINE_PIPELINE_BUDGET_POLICY_V3,
  hashContextAutomationPolicy,
  hashContextAutomationPolicyV3,
  isContextAutomationPolicyV2,
  isContextAutomationPolicyV3,
  isOutlinePipelineBudgetPolicyV3,
  serializeContextAutomationPolicy,
  serializeContextAutomationPolicyV3,
} from './contextAutomationPolicy';
export type {
  ContextAutomationPolicyV2,
  ContextAutomationPolicyV3,
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
  providerType?: string | null;
  modelName?: string | null;
  url?: string | null;
  providerAdapterId?: string | null;
}): number {
  const contextWindow = requireModelContextWindow(params.contextWindow);
  const effectiveConfigured = resolveEffectiveMaxOutputTokens({
    providerType: params.providerType,
    modelName: params.modelName,
    url: params.url,
    contextWindow,
    configuredMaxOutputTokens: params.modelMaxOutputTokens,
    providerAdapterId: params.providerAdapterId,
  });
  const reserve = Math.floor(
    contextWindow * ELASTIC_STAGE_OUTPUT_RESERVE_RATIO,
  );
  return Math.max(
    MIN_PIPELINE_TOKENS,
    Math.min(effectiveConfigured, Math.max(MIN_PIPELINE_TOKENS, reserve)),
  );
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

/**
 * Preview-only 80/20 envelope for a *budget simulation* window.
 *
 * This is NOT a model capability and MUST NEVER be written to
 * `llm_config.context_window` / `max_output_tokens`. Real capability is
 * whatever the user saved on the LLM Settings page.
 */
export function deriveLLMCapabilityFromAutoWindow(maxContextTokens: number): {
  contextWindow: number;
  maxOutputTokens: number;
} {
  const allocation = allocateContextBudget(maxContextTokens, {
    characters: 0,
    notes: 0,
    worldbookEntries: 0,
    worldbookCollections: 0,
  });
  return {
    contextWindow: allocation.llmContextWindow,
    maxOutputTokens: allocation.llmMaxOutputTokens,
  };
}

export const DEFAULT_CONTEXT_AUTO_SIMULATION_WINDOW = 1_000_000;

/**
 * Resolve the display value from the selected model capability. The settings
 * key is only a legacy display mirror, so it must never win over a saved
 * model's current `context_window`.
 */
export function resolveContextAutoSimulationDefault(params: {
  savedInput: number | null;
  preferredConfigId?: number | null;
  configs: Array<{ id: number; context_window?: number; is_active?: number }>;
  referenceContextWindow?: number | null;
  fallback?: number;
}): number {
  const preferredId = Number(params.preferredConfigId);
  if (Number.isSafeInteger(preferredId) && preferredId > 0) {
    const preferred = params.configs.find(
      item => Number(item.id) === preferredId,
    );
    const preferredWindow = Number(preferred?.context_window);
    if (Number.isFinite(preferredWindow) && preferredWindow > 0) {
      return Math.round(preferredWindow);
    }
  }
  // An unsaved draft must not display or mutate the active saved model while
  // the user is still editing the draft. The reference value belongs to that
  // draft and therefore wins before the active-model fallback.
  if (
    params.preferredConfigId !== undefined &&
    params.preferredConfigId !== null &&
    (!Number.isSafeInteger(preferredId) || preferredId <= 0)
  ) {
    const reference = Number(params.referenceContextWindow);
    if (Number.isFinite(reference) && reference > 0) {
      return Math.round(reference);
    }
  }
  const active = params.configs.find(item => Number(item.is_active) === 1);
  const activeWindow = Number(active?.context_window);
  if (Number.isFinite(activeWindow) && activeWindow > 0) {
    return Math.round(activeWindow);
  }
  const reference = Number(params.referenceContextWindow);
  if (Number.isFinite(reference) && reference > 0) {
      return Math.round(reference);
  }
  // Compatibility fallback for installations whose saved model has not yet
  // declared a capability. It is never used when a model window is present.
  const saved = Number(params.savedInput);
  if (Number.isFinite(saved) && saved > 0) {
    return Math.round(saved);
  }
  return params.fallback ?? DEFAULT_CONTEXT_AUTO_SIMULATION_WINDOW;
}

// ============================================================================
// 应用函数：以下为有副作用部分，与纯函数分开维护
// ============================================================================

import { openDatabase } from '../data/connection/openDatabase';
import { execute } from '../data/connection/execute';
import { executeTransaction, type SqlStatement } from './database/transaction';
import { all } from '../data/connection/query';
import { DEFAULT_CONTEXT_CONFIG } from '../constants/defaults';
import { setContextConfig } from '../data/repositories/settingsRepository';
import {
  getContextAutomationPolicy,
  getContextAutomationPolicyV3,
  setContextAutoMode,
  setContextAutomationPolicy,
  setContextAutomationPolicyV3,
  type ContextAutoMode,
} from '../data/repositories/contextAutoRepository';

/**
 * V3 project-scoped resource count (Plan §1.4 / §23 GO Gate #1/#2).
 *
 * V3 candidate collection already reads via `getCharactersByProject` etc., so
 * the cross-project pollution bug is closed at the source. This helper exists
 * for the Auto Config preview's diagnostics ("this project has N resources"),
 * not for the runtime allocator path.
 */
export async function countResourcesForProject(
  projectId: number,
): Promise<ResourceCounts> {
  await openDatabase();
  const safeId = Math.max(0, Math.floor(Number(projectId) || 0));
  const countOf = async (table: string): Promise<number> => {
    const rows = await all<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${table} WHERE project_id = ?`,
      [safeId],
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

// ============================================================================
// Context Budget V3 auto-config (Plan §10 / §11 / §23 GO Gate #3)
//
// V3 auto-config persists Policy + mode marker instead of writing per-resource
// max_tokens or fixed split ratios. Resource max_tokens UPDATEs are explicitly
// forbidden — those rows keep their legacy/manual values, and the V3 candidate
// collector ignores them at runtime. This closes the "one auto-apply freezes
// the entire DB" problem (Plan §1.5).
// ============================================================================

/**
 * Result of a V3 auto-config apply. Carries everything the Auto Config UI and
 * task-creation paths need to confirm the mode switch without re-reading the
 * resource tables.
 */
export interface ContextAutoAppliedRecordV3 {
  schemaVersion: 3;
  maxContextTokens: number;
  appliedAt: number;
  mode: ContextAutoMode;
  policy: ContextAutomationPolicyV3;
  policyHash: string;
  syncedContextWindow: {
    configId: number;
    contextWindow: number;
    maxOutputTokens: number;
  };
  affectedCounts: {
    llmConfigs: number;
    presets: number;
  };
}

/**
 * Apply V3 auto-config. Writes the V3 mode marker + policy + the chosen model
 * capability and its display mirror:
 *   - the V3 policy/mode marker for settings compatibility
 *   - context_auto_policy_v3 = {policy}
 *   - context_auto_input = maxContextTokens
 *
 * V3 keeps the policy and resource budgets separate from model capability, but
 * the chosen model window itself is authoritative and is synchronized here.
 * Only the selected saved model row is updated; `max_output_tokens` is copied
 * as-is, so zero remains the persisted AUTO sentinel.
 */
type ContextAutoTargetConfig = {
  id: number;
  is_active: number;
  contextWindow: number;
  maxOutputTokens: number;
};

async function resolveContextAutoTargetConfig(
  preferredConfigId?: number | null,
): Promise<ContextAutoTargetConfig | null> {
  const rows = await all<{
    id: number;
    is_active: number;
    context_window: number;
    max_output_tokens: number;
  }>(
    'SELECT id, is_active, context_window, max_output_tokens FROM llm_config ORDER BY is_active DESC, id ASC',
  );
  if (preferredConfigId !== undefined && preferredConfigId !== null) {
    const preferred = Number(preferredConfigId);
    if (!Number.isSafeInteger(preferred) || preferred <= 0) {
      throw new Error('LLM 配置尚未保存，无法同步模型真实能力。');
    }
    const row = rows.find(item => Number(item.id) === preferred);
    if (!row) {
      throw new Error('指定的 LLM 配置不存在，已拒绝同步模型真实能力。');
    }
    return {
      id: preferred,
      is_active: Number(row.is_active) === 1 ? 1 : 0,
      contextWindow: Math.max(0, Math.floor(Number(row.context_window) || 0)),
      maxOutputTokens: Math.max(
        0,
        Math.floor(Number(row.max_output_tokens) || 0),
      ),
    };
  }
  const row = rows.find(item => Number(item.is_active) === 1);
  if (!row) return null;
  return {
    id: Number(row.id),
    is_active: 1,
    contextWindow: Math.max(0, Math.floor(Number(row.context_window) || 0)),
    maxOutputTokens: Math.max(
      0,
      Math.floor(Number(row.max_output_tokens) || 0),
    ),
  };
}

async function setContextAutoInputMirror(contextWindow: number): Promise<void> {
  const database = await openDatabase();
  if (Number.isFinite(contextWindow) && contextWindow > 0) {
    await execute(
      database,
      'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
      ['context_auto_input', String(Math.floor(contextWindow))],
    );
    return;
  }
  await execute(database, 'DELETE FROM settings WHERE key = ?', [
    'context_auto_input',
  ]);
}

export async function restoreContextAutoDefaults(): Promise<void> {
  const defaultPolicy = cloneDefaultContextAutomationPolicy();
  const defaultPolicyV3 = cloneDefaultContextAutomationPolicyV3();
  await setContextAutomationPolicy(defaultPolicy);
  await setContextAutomationPolicyV3(defaultPolicyV3);
  await setContextAutoMode('v3');
  const active = await resolveContextAutoTargetConfig();
  if (active) await setContextAutoInputMirror(active.contextWindow);
  await setContextConfig({
    ...DEFAULT_CONTEXT_CONFIG,
  });
  // Restore policy defaults only; the saved model capability remains the
  // authority and is mirrored into the legacy display key above.
}

export async function applyContextAutoAllocationV3(
  maxContextTokens: number,
  options: {
    policy?: ContextAutomationPolicyV3;
    /** Saved model selected in LLM Settings; omitted means active model. */
    llmConfigId?: number | null;
  } = {},
): Promise<ContextAutoAppliedRecordV3> {
  if (!Number.isFinite(maxContextTokens) || maxContextTokens <= 0) {
    throw new Error(
      `applyContextAutoAllocationV3: maxContextTokens 必须为正数，收到：${maxContextTokens}`,
    );
  }
  const persistedPolicy = await getContextAutomationPolicyV3();
  const policy =
    options.policy ||
    (persistedPolicy && isContextAutomationPolicyV3(persistedPolicy)
      ? persistedPolicy
      : cloneDefaultContextAutomationPolicyV3());
  const policyHash = hashContextAutomationPolicyV3(policy);
  const serializedPolicyV3 = serializeContextAutomationPolicyV3(policy);
  const normalizedContextWindow = Math.round(maxContextTokens);
  const target = await resolveContextAutoTargetConfig(options.llmConfigId);
  if (!target) {
    throw new Error('当前没有已启用的 LLM 配置，无法同步模型真实能力。');
  }
  const appliedAt = Date.now();
  const syncedContextWindow = {
    configId: target.id,
    contextWindow: normalizedContextWindow,
    maxOutputTokens: target.maxOutputTokens,
  };
  const lastApplied = {
    schemaVersion: 3 as const,
    maxContextTokens: normalizedContextWindow,
    appliedAt,
    policySchemaVersion: 3,
    policyVersion: 'context-automation-v3',
    policyHash,
    syncedContextWindow,
    affectedCounts: {
      llmConfigs: 1,
      presets: 0,
      characters: 0,
      notes: 0,
      worldbookEntries: 0,
      worldbookCollections: 0,
    },
  };
  const statements: SqlStatement[] = [
    {
      sql: 'UPDATE llm_config SET context_window = ? WHERE id = ?',
      params: [normalizedContextWindow, target.id],
    },
    ...(target.is_active === 1
      ? [
          {
            sql: 'INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)',
            params: ['context_auto_input', String(normalizedContextWindow)],
          },
        ]
      : []),
    {
      sql: 'INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)',
      params: ['context_auto_mode', 'v3'],
    },
    {
      sql: 'INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)',
      params: ['context_auto_policy_v3', serializedPolicyV3],
    },
    {
      sql: 'INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)',
      params: ['context_auto_last_applied', JSON.stringify(lastApplied)],
    },
  ];
  const db = await openDatabase();
  await executeTransaction(db, statements);
  const record: ContextAutoAppliedRecordV3 = {
    schemaVersion: 3,
    maxContextTokens: normalizedContextWindow,
    appliedAt,
    mode: 'v3',
    policy,
    policyHash,
    syncedContextWindow,
    affectedCounts: { llmConfigs: 1, presets: 0 },
  };
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
  providerType?: string | null;
  modelName?: string | null;
  url?: string | null;
  providerAdapterId?: string | null;
}): Record<OutlinePipelineStageV3, number> {
  const reservation = resolveElasticStageOutputReservation({
    contextWindow: params.contextWindow,
    modelMaxOutputTokens: params.modelMaxOutputTokens,
    providerType: params.providerType,
    modelName: params.modelName,
    url: params.url,
    providerAdapterId: params.providerAdapterId,
  });
  return Object.fromEntries(
    OUTLINE_PIPELINE_STAGES_V3.map(stage => [stage, reservation]),
  ) as Record<OutlinePipelineStageV3, number>;
}

export type SharedStageMaxOutputTokens = {
  draft: number;
  qa: number;
  review: number;
  audit: number;
  factCheck: number;
  revision: number;
  proof: number;
};

/**
 * Map the frozen outline V3 stage ledger (draft/review/factCheck/brief/proof)
 * onto the ONE Kernel stage names. The elastic 20% reserve is the FLOOR for
 * every stage, never just the fallback: a stale or legacy ledger row (old V3
 * draft/review/factCheck defaults, or a pre-elastic brief row) must never
 * under-reserve a request the provider could legitimately fill — truncating
 * the request is what used to surface as "返回格式无效" on revision/QA JSON.
 * A frozen row larger than the reserve is honored as-is.
 */
export function buildSharedStageMaxOutputTokens(input: {
  contextWindow: number;
  modelMaxOutputTokens?: number | null;
  providerType?: string | null;
  modelName?: string | null;
  url?: string | null;
  providerAdapterId?: string | null;
  outlineStageBudgets?: ReadonlyArray<{
    stage: string;
    requestMaxTokens?: number | null;
  }> | null;
}): SharedStageMaxOutputTokens {
  const elastic = resolveOutlineElasticStageReservations(input);
  const byStage: Record<string, number> = {};
  for (const item of input.outlineStageBudgets || []) {
    const n = Number(item.requestMaxTokens);
    if (Number.isFinite(n) && n > 0) {
      byStage[item.stage] = Math.floor(n);
    }
  }
  const pick = (outlineStage: OutlinePipelineStageV3): number =>
    Math.max(byStage[outlineStage] || 0, elastic[outlineStage]);
  return {
    draft: pick('draft'),
    qa: pick('review'),
    review: pick('review'),
    audit: pick('factCheck'),
    factCheck: pick('factCheck'),
    revision: pick('brief'),
    proof: pick('proof'),
  };
}

/**
 * Compile-time output ceiling for one shared Writer stage.
 * `sharedStageMaxOutputTokens` is derived with the elastic reserve as its
 * FLOOR (see buildSharedStageMaxOutputTokens), so a stage can never request
 * below the elastic envelope; the model ceiling then caps the request.
 */
export function resolveFrozenStageMaxOutputTokens(input: {
  stage: string;
  contextWindow: number;
  modelMaxOutputTokens?: number | null;
  providerType?: string | null;
  modelName?: string | null;
  url?: string | null;
  providerAdapterId?: string | null;
  sharedStageMaxOutputTokens?: Record<string, unknown> | null;
}): number {
  const modelMax = Math.max(
    MIN_PIPELINE_TOKENS,
    resolveEffectiveMaxOutputTokens({
      providerType: input.providerType,
      modelName: input.modelName,
      url: input.url,
      contextWindow: input.contextWindow,
      configuredMaxOutputTokens: input.modelMaxOutputTokens,
      providerAdapterId: input.providerAdapterId,
    }),
  );
  const stageMax = Number(input.sharedStageMaxOutputTokens?.[input.stage]);
  if (Number.isFinite(stageMax) && stageMax > 0) {
    return Math.max(
      MIN_PIPELINE_TOKENS,
      Math.min(modelMax, Math.floor(stageMax)),
    );
  }
  return resolveElasticStageOutputReservation({
    contextWindow: input.contextWindow,
    modelMaxOutputTokens: input.modelMaxOutputTokens,
    providerType: input.providerType,
    modelName: input.modelName,
    url: input.url,
    providerAdapterId: input.providerAdapterId,
  });
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
  providerType?: string | null;
  modelName?: string | null;
  url?: string | null;
  providerAdapterId?: string | null;
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
    providerType,
    modelName,
    url,
    providerAdapterId,
    requestMaxTokenOverrides,
    visibleOutputFloors,
    estimatedMandatoryInputTokens,
  } = params;
  const effectiveModelMaxOutputTokens =
    Number.isFinite(modelMaxOutputTokens) && (modelMaxOutputTokens ?? 0) > 0
      ? resolveEffectiveMaxOutputTokens({
          providerType,
          modelName,
          url,
          configuredMaxOutputTokens: modelMaxOutputTokens,
          providerAdapterId,
        })
      : undefined;
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
        ? effectiveModelMaxOutputTokens!
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
  providerType?: string | null;
  modelName?: string | null;
  url?: string | null;
  providerAdapterId?: string | null;
  requestedTier?: OutlineReasoningTierV3;
  policy?: OutlinePipelineBudgetPolicyV3;
}): OutlinePipelineBudgetAllocationV3 {
  const requestedTier = params.requestedTier ?? 'low';
  const requestMaxTokens = resolveOutlineElasticStageReservations(params);
  return allocateOutlinePipelineBudgetV3({
    contextWindow: params.contextWindow,
    requestedTier,
    modelMaxOutputTokens: params.modelMaxOutputTokens ?? undefined,
    providerType: params.providerType,
    modelName: params.modelName,
    url: params.url,
    providerAdapterId: params.providerAdapterId,
    requestMaxTokenOverrides: requestMaxTokens,
    policy: params.policy,
  });
}
