/**
 * Phase 3 generation public surface.
 */
export * from './types';
export {
  ensureGenerationSettings,
  updateGenerationSettings,
  getRunById,
  findLatestAdoptedRunForChapter,
  listRunsForProject,
  listRunningRuns,
  getLatestArtifact,
  getArtifactById,
  getArtifactForRun,
  getPlan,
  listChecksForArtifact,
  listProposals,
  getProposalById,
  countPendingMajorProposals,
  listValidEventsBefore,
  enqueueOutbox,
  getOutboxByDedupe,
  getOutboxById,
  listOutboxForProject,
  retryContinuationOutbox,
  retryFailedContinuationOutbox,
  getOutboxSummary,
  markRunsInterruptedOnColdStart,
  contentRevisionHash,
  resolveCheck,
  newContinuationRunId,
} from './generationRepository';
export { buildContinuationContext } from './continuationContextBuilder';
export type { BuildContinuationContextInput } from './continuationContextBuilder';
export {
  selectContinuationAnchor,
  type ContinuationAnchor,
  type ContinuationAnchorChapter,
  type ContinuationSourceSeam,
} from './continuationAnchor';
export {
  compilePlannerMessages,
  compileWriterMessages,
  compileCheckerMessages,
  compileRepairMessages,
  compileStateExtractionMessages,
} from './continuationPromptCompiler';
export {
  runDeterministicChecks,
  parseCheckerLlmJson,
  bindIssuesToArtifact,
  filterBySettings,
  uncheckedCategories,
} from './continuationChecker';
export { tryDeterministicRepair, shouldRunRepair } from './continuationRepairService';
export {
  getEffectiveContinuationState,
  confirmProposal,
  rejectProposal,
  invalidateContinuationStateFromPosition,
  onChapterContentChanged,
} from './continuationStateService';
export {
  processContinuationOutbox,
  coldStartNormalizeContinuation,
  deterministicExtractFromText,
} from './continuationStateOutboxWorker';
export {
  startContinuationRun,
  confirmPlanAndContinue,
  cancelContinuationRun,
  adoptArtifactAsDraft,
  abandonRun,
  finalizeContinuationChapter,
  resumeInterruptedRun,
  isContinuationRunId,
  outdatedRunsOnSourceOrCanonChange,
} from './continuationGenerationRunner';
export type { StartContinuationRunInput, StageLlmCaller } from './continuationGenerationRunner';
export { summarizeTrace, parseTraceJson } from './continuationContextTrace';
export {
  extractAndSaveStyleProfile,
  getStyleProfile,
} from './continuationStyleService';
