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
