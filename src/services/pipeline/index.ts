/**
 * Pipeline durable state machine (architecture convergence).
 * Single decision + reconcile entry for first-run and resume.
 */

export type {
  StageStatus,
  PipelineCheckpointStage,
  PipelineErrorCode,
  PipelineError,
  PersistedStageCheckpoint,
  PersistedPipelineTaskView,
  PipelineAction,
} from './types';

export { LLM_STAGES, isTerminalTaskStatus } from './types';

export { determineNextPipelineAction } from './determineNextPipelineAction';

export {
  projectStageResultsToCheckpoints,
  getCheckpoint,
} from './projectStageCheckpoints';

export {
  buildPersistedTaskView,
  resolveStageCheckpoints,
  checkpointsFromRows,
} from './taskView';

export {
  allocateStageContextBudget,
  deriveDefaultSafetyMargin,
} from './budgetAllocator';
export type {
  AllocateStageContextBudgetInput,
  AllocateStageContextBudgetResult,
} from './budgetAllocator';

export {
  compileDraftStageRequest,
  compileDraftFromFrozenRequest,
  compilePipelineStageRequest,
  compileReviewStageRequest,
  compileFactCheckStageRequest,
  compileProofStageRequest,
  compileFinalReviserStageRequest,
  requireReadyStageRequest,
} from './compileStageRequest';
export type {
  StageCompileResult,
  ReadyStageRequest,
  ContextAllocationTrace,
  ContextBudgetDiagnostics,
} from './compileStageRequest';

export {
  pipelineError,
  mapOutlineErrorToPipelineError,
  formatPipelineErrorForUser,
  isOutlineBudgetError,
} from './errors';

export { executeClaimedStage } from './executeClaimedStage';
export type {
  ExecuteClaimedStageOptions,
  ExecuteClaimedStageResult,
} from './executeClaimedStage';

export { reconcilePipelineTask, isReconcileActive } from './reconcile';
