/**
 * Multi-chapter batch public API.
 */
export {
  reconcileMultiChapterBatch,
  buildBatchChapterInstruction,
  type BatchProgressInfo,
  type ReconcileMultiChapterBatchOptions,
} from './reconcileMultiChapterBatch';
export {
  determineNextBatchAction,
  type MultiChapterBatchAction,
  type DetermineBatchActionInput,
} from './determineNextBatchAction';
export {
  createBatchChapterPlan,
  collectPlannerMaterials,
  validateBatchChapterPlan,
  parseBatchChapterPlan,
  computePlannerHash,
  resolvePlannerWireMaxTokens,
  normalizeEditedPlan,
  BatchPlannerError,
  type CreateBatchChapterPlanResult,
} from './planner';
export type { BatchPlannerMaterials } from './plannerCompiler';
export {
  compileBatchPlannerRequest,
  buildPlannerMessages,
} from './plannerCompiler';
export {
  adoptPipelineTaskResult,
  computeAdoptionFingerprint,
  type AdoptPipelineTaskResultInput,
  type AdoptPipelineTaskResultOutput,
} from './batchAdoption';
export { MultiChapterBatchError } from './errors';
// Continuation-mode batch surface (Schema 53).
export {
  isContinuationBatch,
  encodeContinuationBatchAnchor,
  decodeContinuationBatchAnchor,
  encodeContinuationBatchExecutionPolicy,
  decodeContinuationBatchExecutionPolicy,
  defaultContinuationBatchExecutionPolicy,
} from './batchMode';
export {
  buildContinuationBatchChapterInstruction,
} from './continuationBatchInstruction';
export {
  collectContinuationBatchPlannerMaterials,
  createContinuationBatchChapterPlan,
  captureContinuationBatchAnchor,
  ContinuationBatchPlannerError,
} from './continuationBatchPlanner';
export {
  compileContinuationBatchPlannerRequest,
  buildContinuationPlannerMessages,
} from './continuationBatchPlannerCompiler';
export type { ContinuationBatchPlannerMaterials } from './continuationBatchPlannerCompiler';
export {
  checkNextChapterReady,
  checkContinuationTailDrift,
} from './continuationBatchStateGate';
export {
  setBatchUsageFromContinuationRuns,
  computeContinuationBatchUsage,
} from './continuationBatchUsage';
export {
  executeContinuationBatchStep,
  observeContinuationRun,
  computeContinuationAdoptionFingerprint,
  cancelContinuationBatch,
  rearmContinuationItemForUserResume,
  type ContinuationBatchStepOptions,
  type BatchExecutionObservation,
} from './continuationBatchAdapter';
