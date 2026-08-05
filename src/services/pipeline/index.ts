/**
 * Pipeline durable state machine (architecture convergence).
 *
 * Phase 1 exports pure decision + projection helpers only.
 * Runner still uses legacy paths until phase 3 wires reconcilePipelineTask.
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
  compilePipelineStageRequest,
  compileReviewStageRequest,
  compileFactCheckStageRequest,
  compileProofStageRequest,
} from './compileStageRequest';
export type {
  CompiledStageRequest,
  ContextAllocationTrace,
} from './compileStageRequest';

export {
  pipelineError,
  mapOutlineErrorToPipelineError,
  formatPipelineErrorForUser,
  isOutlineBudgetError,
} from './errors';

export { reconcilePipelineTask, isReconcileActive } from './reconcile';
