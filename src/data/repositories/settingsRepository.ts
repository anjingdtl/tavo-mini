import type { ContextConfig } from '../../types/novel';
import type { VoiceConfig, TtsEngine, SystemTtsConfig } from '../../types/tts';
import { DEFAULT_CONTEXT_CONFIG } from '../../constants/defaults';
import {
  DEFAULT_SYSTEM_TTS_CONFIG,
  DEFAULT_VOICE_CONFIG,
} from '../../constants/voice';
import { execute } from '../connection/execute';
import { one } from '../connection/query';
import { openDatabase } from '../connection/openDatabase';

export async function getSetting(key: string): Promise<string | null> {
  const row = await one<{ value: string }>(
    'SELECT value FROM settings WHERE key = ?',
    [key],
  );
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await execute(
    await openDatabase(),
    'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
    [key, value],
  );
}

export async function getContextConfig(): Promise<ContextConfig> {
  const legacySummaryBudget = Number(
    (await getSetting('summary_budget_tokens')) ||
      DEFAULT_CONTEXT_CONFIG.summaryBudgetTokens,
  );
  const storyStateRaw = await getSetting('story_state_budget_tokens');
  const episodicRaw = await getSetting('episodic_memory_budget_tokens');
  const memoryPatchRaw = await getSetting('memory_patch_max_tokens');
  return {
    strategy:
      ((await getSetting('context_strategy')) as ContextConfig['strategy']) ||
      DEFAULT_CONTEXT_CONFIG.strategy,
    slidingWindowSize: Number(
      (await getSetting('sliding_window_size')) ||
        DEFAULT_CONTEXT_CONFIG.slidingWindowSize,
    ),
    customRangeStart: Number(
      (await getSetting('custom_range_start')) ||
        DEFAULT_CONTEXT_CONFIG.customRangeStart,
    ),
    customRangeEnd: Number(
      (await getSetting('custom_range_end')) ||
        DEFAULT_CONTEXT_CONFIG.customRangeEnd,
    ),
    resourceBudget: Number(
      (await getSetting('resource_budget')) ||
        DEFAULT_CONTEXT_CONFIG.resourceBudget,
    ),
    includeResources: (await getSetting('include_resources')) !== 'false',
    summaryBudgetTokens: legacySummaryBudget,
    storyStateBudgetTokens:
      storyStateRaw == null
        ? Math.round(legacySummaryBudget * 0.6)
        : Number(storyStateRaw),
    episodicMemoryBudgetTokens:
      episodicRaw == null
        ? legacySummaryBudget - Math.round(legacySummaryBudget * 0.6)
        : Number(episodicRaw),
    memoryPatchMaxTokens:
      memoryPatchRaw == null
        ? DEFAULT_CONTEXT_CONFIG.memoryPatchMaxTokens
        : Number(memoryPatchRaw),
    memoryTopK: Number(
      (await getSetting('memory_top_k')) || DEFAULT_CONTEXT_CONFIG.memoryTopK,
    ),
    recentChapterCount: Number(
      (await getSetting('recent_chapter_count')) ||
        DEFAULT_CONTEXT_CONFIG.recentChapterCount,
    ),
    worldbookRecursive: (await getSetting('worldbook_recursive')) !== 'false',
    worldbookScanDepth: Number(
      (await getSetting('worldbook_scan_depth')) ||
        DEFAULT_CONTEXT_CONFIG.worldbookScanDepth,
    ),
  };
}

export async function setContextConfig(config: ContextConfig): Promise<void> {
  await setSetting('context_strategy', config.strategy);
  await setSetting('sliding_window_size', String(config.slidingWindowSize));
  await setSetting('custom_range_start', String(config.customRangeStart));
  await setSetting('custom_range_end', String(config.customRangeEnd));
  await setSetting('resource_budget', String(config.resourceBudget));
  await setSetting('include_resources', String(config.includeResources));
  await setSetting(
    'summary_budget_tokens',
    String(
      (config.storyStateBudgetTokens ??
        DEFAULT_CONTEXT_CONFIG.storyStateBudgetTokens ??
        0) +
        (config.episodicMemoryBudgetTokens ??
          DEFAULT_CONTEXT_CONFIG.episodicMemoryBudgetTokens ??
          0),
    ),
  );
  await setSetting(
    'story_state_budget_tokens',
    String(
      config.storyStateBudgetTokens ??
        DEFAULT_CONTEXT_CONFIG.storyStateBudgetTokens,
    ),
  );
  await setSetting(
    'episodic_memory_budget_tokens',
    String(
      config.episodicMemoryBudgetTokens ??
        DEFAULT_CONTEXT_CONFIG.episodicMemoryBudgetTokens,
    ),
  );
  await setSetting(
    'memory_patch_max_tokens',
    String(
      config.memoryPatchMaxTokens ??
        DEFAULT_CONTEXT_CONFIG.memoryPatchMaxTokens,
    ),
  );
  await setSetting(
    'memory_top_k',
    String(config.memoryTopK ?? DEFAULT_CONTEXT_CONFIG.memoryTopK),
  );
  await setSetting(
    'recent_chapter_count',
    String(
      config.recentChapterCount ?? DEFAULT_CONTEXT_CONFIG.recentChapterCount,
    ),
  );
  await setSetting(
    'worldbook_recursive',
    String(
      config.worldbookRecursive ?? DEFAULT_CONTEXT_CONFIG.worldbookRecursive,
    ),
  );
  await setSetting(
    'worldbook_scan_depth',
    String(
      config.worldbookScanDepth ?? DEFAULT_CONTEXT_CONFIG.worldbookScanDepth,
    ),
  );
}

export async function getBackgroundPipelineEnabled(): Promise<boolean> {
  const v = await getSetting('background_pipeline_enabled');
  if (v == null) return true; // 默认开启
  return v !== 'false';
}

export async function setBackgroundPipelineEnabled(
  enabled: boolean,
): Promise<void> {
  await setSetting('background_pipeline_enabled', String(enabled));
}

export async function getAllowInsecureLanHttp(): Promise<boolean> {
  const value = await getSetting('allow_insecure_lan_http');
  return value === 'true';
}

export async function setAllowInsecureLanHttp(enabled: boolean): Promise<void> {
  await setSetting('allow_insecure_lan_http', String(enabled));
}

export async function getVoiceConfig(): Promise<VoiceConfig> {
  const raw = await getSetting('voice_config');
  if (!raw) return DEFAULT_VOICE_CONFIG;
  try {
    const parsed = JSON.parse(raw) as Partial<VoiceConfig>;
    return { ...DEFAULT_VOICE_CONFIG, ...parsed };
  } catch {
    return DEFAULT_VOICE_CONFIG;
  }
}

export async function setVoiceConfig(config: VoiceConfig): Promise<void> {
  await setSetting('voice_config', JSON.stringify(config));
}

export async function getTtsEngine(): Promise<TtsEngine> {
  const value = await getSetting('tts_engine');
  return value === 'cloud' ? 'cloud' : 'system';
}

export async function setTtsEngine(engine: TtsEngine): Promise<void> {
  await setSetting('tts_engine', engine);
}

export async function getSystemTtsConfig(): Promise<SystemTtsConfig> {
  const raw = await getSetting('system_tts_config');
  if (!raw) return DEFAULT_SYSTEM_TTS_CONFIG;
  try {
    const parsed = JSON.parse(raw) as Partial<SystemTtsConfig>;
    return { ...DEFAULT_SYSTEM_TTS_CONFIG, ...parsed };
  } catch {
    return DEFAULT_SYSTEM_TTS_CONFIG;
  }
}

export async function setSystemTtsConfig(
  config: SystemTtsConfig,
): Promise<void> {
  await setSetting('system_tts_config', JSON.stringify(config));
}
