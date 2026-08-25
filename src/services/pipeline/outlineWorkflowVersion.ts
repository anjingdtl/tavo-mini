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
 * Pure eligibility check for freezing V4 on a real outline chapter task.
 *
 * V4 enable conditions:
 *   - project mode === 'outline'
 *   - targetType === 'chapter' (chapter.id > 0; freeform pseudo-chapters use id 0)
 *
 * Project creation time and existing chapter body length never participate.
 */
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
// ---------------------------------------------------------------------------

/** Outline workflow versions that carry the structured, Brief-bearing pipeline. */
export const STRUCTURED_OUTLINE_WORKFLOW_VERSIONS = [4] as const;

/**
 * Context-budget versions that pair with the current outline workflow (4) to
 * produce a Brief stage checkpoint: 5 = V2 single-level elastic; 6 = V3
 * hierarchical; 7 = Phase-2 dual-layer budget. All create the Brief checkpoint.
 */
export const STRUCTURED_CONTEXT_BUDGET_VERSIONS = [5, 6, 7] as const;

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
 * a parsed execution snapshot) into the typed union. Current values 5/6/7 are
 * preserved; historical / unknown values collapse to 1 (legacy, non-resumable).
 */
export function normalizePersistedContextBudgetVersion(
  value: unknown,
): ContextBudgetVersion {
  const n = Number(value);
  if (n === 7) return 7;
  if (n === 6) return 6;
  if (n === 5) return 5;
  return 1;
}

// ---------------------------------------------------------------------------
// Pipeline Topology Version (二 Phase §5).
//
// Unlike `outlineWorkflowVersion` (the outline-protocol detail) and
// `contextBudgetVersion` (the budget allocator detail), `pipelineTopologyVersion`
// FREEZES the whole post-Freeze stage topology the task must honour:
//   1 = legacy_standard  → Draft → Review/Audit/FactCheck → Revision → Proof
//                          → FinalValidate → Persist
//   2 = compact_standard → Draft → QA → Revision? → FinalValidate → Persist
//                          (QA unification lands in Phase 4; Phase 2/3 only
//                           remove Proof from the compact DAG)
//
// Contract (二 Phase §5.2/§5.4/§5.5):
//   - task creation Freeze ONCE; batch creation Freeze ONCE; child chapters
//     inherit the batch topology.
//   - Resume NEVER re-reads the live default: it reads the frozen column and
//     the frozen `stagePolicy.values.pipelineTopologyVersion` string.
//   - Historical rows (pre-Schema 55) default to 1 = legacy_standard so they
//     are NEVER taken over by the compact Standard topology.
//   - A present-but-invalid frozen value is corrupt → fail-closed (resume
//     gate must NOT guess the current default).
// ---------------------------------------------------------------------------
export type PipelineTopologyVersion = 1 | 2;
export const LEGACY_PIPELINE_TOPOLOGY_VERSION: PipelineTopologyVersion = 1;
export const COMPACT_PIPELINE_TOPOLOGY_VERSION: PipelineTopologyVersion = 2;
/**
 * Topology frozen on NEW tasks/batches. Only creation code may read this;
 * resume and reconcile must read the frozen task/batch value.
 */
export const CURRENT_PIPELINE_TOPOLOGY_VERSION: PipelineTopologyVersion =
  COMPACT_PIPELINE_TOPOLOGY_VERSION;

export type PipelineTopologyLabel = 'legacy_standard' | 'compact_standard';

/** Kernel-freeze string label written into `stagePolicy.values`. */
export function pipelineTopologyLabel(
  value: unknown,
): PipelineTopologyLabel {
  return normalizePersistedPipelineTopologyVersion(value) ===
    COMPACT_PIPELINE_TOPOLOGY_VERSION
    ? 'compact_standard'
    : 'legacy_standard';
}

/** True when the frozen topology is the compact Standard (2) DAG. */
export function isCompactPipelineTopology(value: unknown): boolean {
  return (
    normalizePersistedPipelineTopologyVersion(value) ===
    COMPACT_PIPELINE_TOPOLOGY_VERSION
  );
}

/**
 * Normalize a frozen `pipeline_topology_version` value.
 *   - absent / legacy default → 1 (legacy_standard) — historical rows never
 *     drift into the compact topology.
 *   - 2 → compact_standard.
 *   - present but any other value → null = CORRUPT. The resume gate treats
 *     this as fail-closed (`PIPELINE_TOPOLOGY_CORRUPT`) and never guesses.
 */
export function normalizePersistedPipelineTopologyVersion(
  value: unknown,
): PipelineTopologyVersion | null {
  if (value == null || value === '') return LEGACY_PIPELINE_TOPOLOGY_VERSION;
  // Kernel freeze writes the STRING label into `stagePolicy.values`
  // (`pipelineTopologyLabel`), while the durable columns persist the numeric
  // 1|2. Both shapes must normalize to the same version — otherwise a compact
  // task resumed through the shared writer consults the LEGACY DAG and
  // deadlocks on `qa` (Phase 4 §7.2 regression).
  if (value === 'compact_standard') return COMPACT_PIPELINE_TOPOLOGY_VERSION;
  if (value === 'legacy_standard') return LEGACY_PIPELINE_TOPOLOGY_VERSION;
  const n = Number(value);
  if (n === 1) return LEGACY_PIPELINE_TOPOLOGY_VERSION;
  if (n === 2) return COMPACT_PIPELINE_TOPOLOGY_VERSION;
  return null;
}

/**
 * Single-source resume contract gate (二 Phase §5.5/§5.6, H4/H6).
 *
 * Resume must never depend on the LIVE default. It only checks what the task
 * FROZE:
 *   - the frozen topology value must be valid (1/2); a present-but-invalid
 *     value is corrupt → fail-closed `PIPELINE_TOPOLOGY_CORRUPT` (never
 *     guess the current default, never take over the task).
 *   - the frozen context-budget protocol must be resumable (5/6/7).
 *     A legacy `outlineWorkflowVersion` is NOT a block by itself: a legacy
 *     task whose budget protocol is compatible resumes under its FROZEN old
 *     topology (`pipelineTopologyVersion=1` → legacy DAG), never under the
 *     compact Standard topology (H6).
 */
export function checkPipelineResumeContract(input: {
  status?: string | null;
  contextBudgetVersion?: unknown;
  pipelineTopologyVersion?: unknown;
}): {
  ok: boolean;
  errorCode?: 'PIPELINE_TOPOLOGY_CORRUPT' | 'LEGACY_PIPELINE_RESUME_BLOCKED';
  errorMessage?: string;
} {
  const topology = normalizePersistedPipelineTopologyVersion(
    input.pipelineTopologyVersion,
  );
  if (topology == null) {
    return {
      ok: false,
      errorCode: 'PIPELINE_TOPOLOGY_CORRUPT',
      errorMessage:
        '该任务冻结的流水线拓扑版本损坏，无法安全继续；请按新版重新生成。',
    };
  }
  if (!isResumableContextBudgetVersion(input.contextBudgetVersion)) {
    return {
      ok: false,
      errorCode: 'LEGACY_PIPELINE_RESUME_BLOCKED',
      errorMessage:
        '该任务使用旧版生成流程或预算协议，不能继续；请按新版重新生成。',
    };
  }
  void input.status;
  return { ok: true };
}
