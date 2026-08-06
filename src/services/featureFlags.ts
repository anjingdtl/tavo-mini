/**
 * Guarded feature flags.
 *
 * Both flags are OFF by default; turning them on is a deliberate release
 * decision (see docs/optimization/tavo-mini-multi-chapter-batch-and-elastic-budget-pool-plan.md
 * §5 Feature Flag 开启规则):
 *   - elastic_budget_v2_enabled:  only after Phase 1+2 single-chapter regression
 *   - multi_chapter_batch_enabled: only after Phase 4~9 state machine + on-device tests
 *
 * When a flag is off, existing pipeline behavior must stay byte-for-byte or
 * business-equivalent (flags never change the default code path).
 */
import {
  getSetting,
  setSetting,
} from '../data/repositories/settingsRepository';

export const FEATURE_FLAG_KEYS = {
  elasticBudgetV2: 'elastic_budget_v2_enabled',
  multiChapterBatch: 'multi_chapter_batch_enabled',
} as const;

/** Elastic 80%/95% budget pool across all pipeline stage compilers. */
export async function isElasticBudgetV2Enabled(): Promise<boolean> {
  const v = await getSetting(FEATURE_FLAG_KEYS.elasticBudgetV2);
  return v === 'true';
}

export async function setElasticBudgetV2Enabled(enabled: boolean): Promise<void> {
  await setSetting(FEATURE_FLAG_KEYS.elasticBudgetV2, String(enabled));
}

/** Multi-chapter batch orchestrator (outline mode only). */
export async function isMultiChapterBatchEnabled(): Promise<boolean> {
  const v = await getSetting(FEATURE_FLAG_KEYS.multiChapterBatch);
  return v === 'true';
}

export async function setMultiChapterBatchEnabled(enabled: boolean): Promise<void> {
  await setSetting(FEATURE_FLAG_KEYS.multiChapterBatch, String(enabled));
}
