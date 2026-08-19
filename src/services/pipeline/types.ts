/**
 * Pipeline architecture convergence — shared types for the durable state machine.
 *
 * Phase 1: pure decision types only. Runner / Schema still use legacy models;
 * these types define the target invariants and feed determineNextPipelineAction.
 */

import type { PipelineMode, PipelineStageName, PipelineTaskStatus } from '../../types/pipeline';

/** Stage lifecycle on the durable checkpoint row (target schema). */
export type StageStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'interrupted';

/**
 * Logical stages including finalize (not an LLM stage, but a durable step).
 * finalize is optional in checkpoint tables; it may also be derived from finalText.
 */
export type PipelineCheckpointStage = PipelineStageName | 'finalize';

export type PipelineErrorCode =
  | 'MODEL_UNAVAILABLE'
  | 'CONTEXT_WINDOW_EXCEEDED'
  | 'OUTLINE_TOO_LARGE'
  | 'SNAPSHOT_INVALID'
  | 'SNAPSHOT_PERSIST_FAILED'
  | 'STAGE_PERSIST_FAILED'
  | 'EXECUTION_CONFIG_CHANGED'
  | 'TASK_ALREADY_RUNNING'
  | 'TASK_NOT_RECOVERABLE'
  | 'TASK_TERMINAL'
  | 'STAGE_FAILED'
  | 'MISSING_EXECUTION_SNAPSHOT'
  | 'MISSING_DRAFT_CONTEXT'
  | 'UNKNOWN_STATE'
  | 'RESOURCE_AWARENESS_OVER_BUDGET'
  | 'RESOURCE_AWARENESS_READ_FAILED'
  | 'RESOURCE_AWARENESS_COMPILE_FAILED'
  | 'PRESET_SOURCE_READ_FAILED'
  | 'RESOURCE_SOURCE_CHANGED_DURING_BUILD';

export interface PipelineError {
  code: PipelineErrorCode;
  message: string;
  stage?: PipelineCheckpointStage;
  userAction?:
    | 'retry'
    | 'restart_task'
    | 'open_llm_settings'
    | 'open_outline'
    | 'wait'
    | 'none';
  diagnostics?: Record<string, unknown>;
}

/** Durable view of one stage for the pure decision function. */
export interface PersistedStageCheckpoint {
  stage: PipelineCheckpointStage;
  status: StageStatus;
  /** Present when status is succeeded (or failed with partial text). */
  outputText?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  attemptCount?: number;
}

/**
 * Minimal durable task view required by determineNextPipelineAction.
 * Not the full DB row — only fields the state machine may read.
 */
export interface PersistedPipelineTaskView {
  id: string;
  status: PipelineTaskStatus | string;
  /** Frozen mode; required once execution snapshot exists. */
  pipelineMode: PipelineMode | null;
  /** True when an execution snapshot (V2/V3) is persisted and valid. */
  hasExecutionSnapshot: boolean;
  /** Frozen protocol versions used by the state machine. */
  outlineWorkflowVersion?: number | null;
  contextBudgetVersion?: number | null;
  /**
   * Frozen pipeline topology version (Schema 55+). 1 = legacy_standard;
   * 2 = compact_standard. Read from the frozen task row, never the live
   * default; corrupt frozen values must be rejected before this decision.
   */
  pipelineTopologyVersion?: number | null;
  /**
   * One-Shot (极速) execution profile frozen in the execution snapshot.
   * undefined / 'standard' keeps the full audit pipeline.
   */
  executionProfile?: 'standard' | 'one_shot';
  /** True when draftContext (frozen retrieval) is persisted. */
  hasDraftContext: boolean;
  /**
   * True when full-mode auditContext has been persisted.
   * Ignored for non-full modes.
   */
  hasAuditContext: boolean;
  /** Final body already written (complete or degraded retain). */
  finalText: string | null;
  /**
   * When true, terminal failure already recorded; still may need to attach
   * finalText via finalize_from_draft (degraded) if missing.
   */
  terminalFailed?: boolean;
}

export type PipelineAction =
  | { type: 'persist_initial_snapshot' }
  | { type: 'run_draft' }
  | { type: 'build_audit_context' }
  | { type: 'run_review' }
  | { type: 'run_fact_check' }
  | { type: 'run_review_and_fact_check' }
  | { type: 'run_brief' }
  | { type: 'run_proof' }
  | {
      type: 'finalize_from_draft';
      /** Audit/proof failed; keep draft as retained body under failed status. */
      degraded?: boolean;
    }
  | { type: 'finalize_from_proof' }
  | { type: 'complete' }
  | { type: 'blocked'; reason: PipelineError };

/** Stages that involve an LLM call (for CAS claim mapping). */
export const LLM_STAGES: PipelineStageName[] = [
  'draft',
  'review',
  'factCheck',
  'brief',
  'proof',
];

/** Hard terminals only. `failed` may still need finalize_from_draft. */
export function isTerminalTaskStatus(status: string): boolean {
  return status === 'completed' || status === 'cancelled';
}
