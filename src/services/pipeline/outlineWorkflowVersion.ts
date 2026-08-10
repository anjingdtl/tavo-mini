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
export type ContextBudgetVersion = 1 | 2 | 3 | 4 | 5;

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
 */
export const CURRENT_OUTLINE_WORKFLOW_VERSION: OutlineWorkflowVersion = 4;
export const CURRENT_CONTEXT_BUDGET_VERSION: ContextBudgetVersion = 5;

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
