/**
 * Outline pipeline workflow version (V5-Lite) decision.
 *
 * `outlineWorkflowVersion` is frozen ONCE into PipelineExecutionSnapshot at
 * first task start; resume always uses the frozen value.
 *
 * Since the default-capabilities upgrade (V2.12, Schema 44), the CURRENT
 * protocol is V2: NEW tasks and NEW batches freeze 2 explicitly at creation
 * (task/batch version columns). The `CURRENT_*_VERSION` constants below are
 * ONLY read when CREATING a new task/batch — resume, checkpoint reconcile
 * and attempt retry must never consult them (§5.6 of the plan).
 *
 * Rollback switch: if a hotfix must pull new tasks back to Legacy, change
 * the two CURRENT constants to 1. Frozen V2 tasks/batches keep their V2
 * resume semantics; the Schema 44 columns are never dropped.
 */
export type OutlineWorkflowVersion = 1 | 2 | 3 | 4;
export type ContextBudgetVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/**
 * Protocol versions written to NEW outline chapter tasks / batches.
 * 3 = the V3.2 structured-semantic contract with the original rich payloads.
 * 4 = the current unified full pipeline: simplified semantic payloads,
 * user-tier Draft/Review/Brief/Final, and low FactCheck. Only new-task /
 * new-batch creation code may read these constants.
 *
 * Context budget 5 is the current independent elastic reservation protocol:
 * each Draft / Review / FactCheck / Brief / Final call resolves its own
 * 20%-of-window reservation at first freeze.
 *
 * Context budget 6 is the V3 hierarchical board/item elastic allocator.
 * New outline tasks/batches freeze it explicitly; historical version 5 keeps
 * the V2 single-level elastic path. Resume gate still rejects cross-version
 * resume.
 */
export const CURRENT_OUTLINE_WORKFLOW_VERSION: OutlineWorkflowVersion = 4;
export const CURRENT_CONTEXT_BUDGET_VERSION: ContextBudgetVersion = 5;
/**
 * Context budget version frozen on NEW tasks when the user has applied V3
 * auto-config. Distinct from `CURRENT_CONTEXT_BUDGET_VERSION` so V3 stays
 * opt-in until end-to-end validation promotes it to the global default.
 */
export const V3_HIERARCHICAL_CONTEXT_BUDGET_VERSION = 6 as const;
/**
 * Phase-2 Global Awareness / Detail dual-layer budget.
 * New outline tasks freeze 7. Historical V6 tasks resume on 6 and are
 * never auto-upgraded.
 */
export const PHASE2_CONTEXT_BUDGET_VERSION = 7 as const;
export const PHASE2_RESOURCE_CONTEXT_VERSION = 2 as const;

/**
 * Resolve the budget contract for a newly started chapter from the same
 * project/chapter boundary used by the editor task creator. Keeping this
 * decision pure prevents the preflight Story Memory gate from silently
 * falling back to the historical V5 coverage rules for a Phase II task.
 */
export function resolveNewChapterContextBudgetVersion(input: {
  projectMode?: string | null;
  chapterId: number;
}): ContextBudgetVersion {
  return input.projectMode === 'outline' &&
    Number.isInteger(input.chapterId) &&
    input.chapterId > 0
    ? PHASE2_CONTEXT_BUDGET_VERSION
    : 1;
}

/**
 * @deprecated Rollback-era default (Legacy 1). Kept only for callers that
 * build version-less historical records; new tasks must use the CURRENT
 * constants instead.
 */
export const DEFAULT_OUTLINE_WORKFLOW_VERSION: OutlineWorkflowVersion = 1;

/**
 * Pure eligibility check for freezing V2 on a real outline chapter task.
 *
 * V2 enable conditions (§4.2):
 *   - project mode === 'outline'
 *   - targetType === 'chapter' (chapter.id > 0; freeform pseudo-chapters use id 0)
 *   - default version === 2
 *
 * Project creation time and existing chapter body length never participate.
 */
export function shouldFreezeOutlineWorkflowV2(params: {
  projectMode: string | null | undefined;
  chapterId: number;
  defaultVersion?: OutlineWorkflowVersion;
}): boolean {
  if (params.projectMode !== 'outline') return false;
  if (!Number.isInteger(params.chapterId) || params.chapterId <= 0) return false;
  return (params.defaultVersion ?? DEFAULT_OUTLINE_WORKFLOW_VERSION) === 2;
}

/** Eligibility check for the current V3 outline protocol. */
export function shouldFreezeOutlineWorkflowV3(params: {
  projectMode: string | null | undefined;
  chapterId: number;
  defaultVersion?: OutlineWorkflowVersion;
}): boolean {
  if (params.projectMode !== 'outline') return false;
  if (!Number.isInteger(params.chapterId) || params.chapterId <= 0) return false;
  return (params.defaultVersion ?? CURRENT_OUTLINE_WORKFLOW_VERSION) === 3;
}

/** Eligibility check for the current unified outline protocol. */
export function shouldFreezeOutlineWorkflowV4(params: {
  projectMode: string | null | undefined;
  chapterId: number;
  defaultVersion?: OutlineWorkflowVersion;
}): boolean {
  if (params.projectMode !== 'outline') return false;
  if (!Number.isInteger(params.chapterId) || params.chapterId <= 0) return false;
  return (params.defaultVersion ?? CURRENT_OUTLINE_WORKFLOW_VERSION) === 4;
}

/** Old unfinished tasks are retained for history but cannot be resumed. */
export function isCurrentOutlineWorkflowVersion(value: unknown): boolean {
  return Number(value) === CURRENT_OUTLINE_WORKFLOW_VERSION;
}

// ---------------------------------------------------------------------------
// Unified context-budget version semantics (Closure Plan §5).
//
// The codebase previously scattered magic arrays (`[3,4].includes(owv) &&
// [3,4,5].includes(cbv)`) across the state machine, reconciler, store and UI.
// With context budget 6 (V3 hierarchical) those arrays silently excluded V3
// tasks, dropping them into the legacy no-Brief branch and blocking resume.
// The helpers below are the SINGLE source of truth; all call sites were
// migrated to them so version 6 routes through the same structured pipeline
// as version 5 (same stages, same reasoning profile, same Brief checkpoint),
// differing ONLY in the contextBuilder budget path (>= 6 → hierarchical).
// ---------------------------------------------------------------------------

/** Outline workflow versions that carry the structured, Brief-bearing pipeline. */
export const STRUCTURED_OUTLINE_WORKFLOW_VERSIONS = [3, 4] as const;

/**
 * Context-budget versions that pair with a structured outline workflow to
 * produce a Brief stage checkpoint. 3/4 = historical V3.x; 5 = V2 elastic;
 * 6 = V3 hierarchical. All create the Brief checkpoint.
 */
export const STRUCTURED_CONTEXT_BUDGET_VERSIONS = [3, 4, 5, 6, 7] as const;

export function isStructuredOutlineWorkflowVersion(value: unknown): boolean {
  return (
    (STRUCTURED_OUTLINE_WORKFLOW_VERSIONS as readonly number[]).indexOf(
      Number(value),
    ) >= 0
  );
}

export function isStructuredContextBudgetVersion(value: unknown): boolean {
  return (
    (STRUCTURED_CONTEXT_BUDGET_VERSIONS as readonly number[]).indexOf(
      Number(value),
    ) >= 0
  );
}

/**
 * Context-budget versions of the CURRENT unified outline pipeline
 * (outlineWorkflowVersion 4). 5 = V2 single-level elastic; 6 = V3 hierarchical
 * board/item elastic. Both share the same stage / reasoning-profile / Brief
 * semantics — only the contextBuilder allocator branch differs (>= 6). UI and
 * resume gates use this to recognize a "current" task instead of comparing
 * against the literal `CURRENT_CONTEXT_BUDGET_VERSION` constant.
 */
export function isCurrentOutlinePipelineContextBudgetVersion(
  value: unknown,
): boolean {
  const n = Number(value);
  return n === 5 || n === 6 || n === 7;
}

export function isPhase2ContextBudgetVersion(value: unknown): boolean {
  return Number(value) >= 7;
}

/**
 * Does this (workflow, budget) pair freeze the structured pipeline that
 * creates a Brief stage checkpoint? Replaces the scattered
 * `[3,4].includes(owv) && [3,4,5].includes(cbv)` magic arrays (Closure Plan
 * §5.2). Task Store, State Machine, Runner, Batch, Reconcile and Checkpoint
 * creation all consult this single predicate.
 */
export function shouldIncludeBriefCheckpoint(params: {
  outlineWorkflowVersion?: number | null;
  contextBudgetVersion?: number | null;
}): boolean {
  return (
    isStructuredOutlineWorkflowVersion(params.outlineWorkflowVersion) &&
    isStructuredContextBudgetVersion(params.contextBudgetVersion)
  );
}

/**
 * Context-budget versions allowed to RESUME on their own version. 5 (V2) and
 * 6 (V3) resume; legacy 1–4 are blocked. Neither is silently upgraded to the
 * other. Consolidates the per-store `isTask/BatchContextBudgetVersionResumable`
 * cores so the rule lives in one place.
 */
export function isResumableContextBudgetVersion(value: unknown): boolean {
  return isCurrentOutlinePipelineContextBudgetVersion(value);
}

/**
 * Normalize a persisted context-budget version (read from a task/batch row or
 * a parsed execution snapshot) into the typed union, PRESERVING 5 and 6
 * instead of collapsing them to the legacy fallback of 1. Unknown / legacy
 * values collapse to 1.
 */
export function normalizePersistedContextBudgetVersion(
  value: unknown,
): ContextBudgetVersion {
  const n = Number(value);
  if (n === 7) return 7;
  if (n === 6) return 6;
  if (n === 5) return 5;
  if (n === 4) return 4;
  if (n === 3) return 3;
  if (n === 2) return 2;
  return 1;
}
