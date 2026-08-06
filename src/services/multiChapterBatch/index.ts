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
