import type { ContextConfig } from '../types/novel';

export const DEFAULT_TEMPERATURE = 0.8;
export const DEFAULT_TOP_P = 0.9;
export const DEFAULT_MAX_TOKENS = 4000;
export const DEFAULT_SLIDING_WINDOW_SIZE = 4000;
export const DEFAULT_RESOURCE_BUDGET = 2000;
export const DEFAULT_SUMMARY_BUDGET = 20000;
export const DEFAULT_STORY_STATE_BUDGET = 12000;
export const DEFAULT_EPISODIC_MEMORY_BUDGET = 8000;
export const DEFAULT_MEMORY_PATCH_MAX_TOKENS = 1200;
export const DEFAULT_CONTEXT_STRATEGY = 'sliding';
export const DEFAULT_BACKGROUND_PIPELINE_ENABLED = true;

/**
 * 上下文配置的唯一默认来源。所有"恢复默认"和"未配置时的兜底"
 * 都必须引用本常量，禁止在别处硬编码 context 默认值。
 *
 * 注意：DEFAULT_SUMMARY_BUDGET 已修正为 20000（与历史实际使用一致）。
 */
export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  strategy: 'sliding',
  slidingWindowSize: 4000,
  recentChapterCount: 10,
  summaryBudgetTokens: 20000,
  storyStateBudgetTokens: DEFAULT_STORY_STATE_BUDGET,
  episodicMemoryBudgetTokens: DEFAULT_EPISODIC_MEMORY_BUDGET,
  memoryPatchMaxTokens: DEFAULT_MEMORY_PATCH_MAX_TOKENS,
  memoryTopK: 10,
  resourceBudget: 2000,
  worldbookScanDepth: 4,
  customRangeStart: 0,
  customRangeEnd: -1,
  includeResources: true,
  worldbookRecursive: true,
};

export const PLOTLINE_COLORS = ['#6366f1', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'];

export const THEME_COLORS = {
  accent: '#439EA6',
  secondary: '#B0E0E3',
  light: '#D7F1F4',
};
