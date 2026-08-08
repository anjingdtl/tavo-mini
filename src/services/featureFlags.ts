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
  /**
   * Outline pipeline V5-Lite workflow v2 (anchored audits + revision
   * contract + final reviser). Default OFF; when ON, newly frozen outline
   * chapter tasks freeze `outlineWorkflowVersion=2`. Frozen tasks keep their
   * version regardless of this flag.
   */
  outlineWorkflowV2: 'outline_workflow_v2_enabled',
  // RB-16 fix (V2.11.34): `repairOversizedNotes` is destructive (it
  // deletes the original note and replaces it with chunks). It must
  // never run on a normal cold start. The default is OFF; the Settings
  // experimental toggles surface a "数据维护 → 优化超大笔记" button
  // that flips this flag, creates a safety backup, then performs the
  // repair inside a single transaction.
  startupNoteRepair: 'startup_note_repair_enabled',
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

/** Outline pipeline V5-Lite workflow v2 (anchored audits + contract). */
export async function isOutlineWorkflowV2Enabled(): Promise<boolean> {
  const v = await getSetting(FEATURE_FLAG_KEYS.outlineWorkflowV2);
  return v === 'true';
}

export async function setOutlineWorkflowV2Enabled(enabled: boolean): Promise<void> {
  await setSetting(FEATURE_FLAG_KEYS.outlineWorkflowV2, String(enabled));
}

/**
 * RB-16 fix (V2.11.34): explicit maintenance switch for the destructive
 * oversized-note repair. Default OFF; the Settings → 实验功能 surface
 * flips it before invoking `runNoteMaintenance()`. The startup main path
 * never reads this flag — the gate lives in initializeDatabase.ts as
 * defense-in-depth.
 */
export async function isStartupNoteRepairEnabled(): Promise<boolean> {
  const v = await getSetting(FEATURE_FLAG_KEYS.startupNoteRepair);
  return v === 'true';
}

export async function setStartupNoteRepairEnabled(enabled: boolean): Promise<void> {
  await setSetting(FEATURE_FLAG_KEYS.startupNoteRepair, String(enabled));
}
