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
  listChecksForRun,
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
  markChecksAutoRepaired,
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
  compileV3WriterMessages,
  compileV3CheckerMessages,
  compileIntegratedReviserMessages,
} from './continuationPromptCompiler';
export {
  runDeterministicChecks,
  parseCheckerLlmJson,
  bindIssuesToArtifact,
  filterBySettings,
  uncheckedCategories,
} from './continuationChecker';
export {
  tryDeterministicRepair,
  tryDeterministicRepairWithReport,
  shouldRunRepair,
} from './continuationRepairService';
export {
  applyRepairPatches,
  applyParsedRepairPatches,
  parseRepairPatches,
  validateRepairPatches,
  validateRepairPatchCoverage,
  isRepairCandidateUsable,
} from './continuationRepairPatch';
export type { DeterministicRepairResult } from './continuationRepairService';
export type {
  RepairPatch,
  RepairPatchCoverage,
  RepairCandidateMode,
  RepairCoverageIssue,
} from './continuationRepairPatch';
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
  repairContinuationArtifactOnce,
  confirmPlanAndContinue,
  cancelContinuationRun,
  adoptArtifactAsDraft,
  abandonRun,
  finalizeContinuationChapter,
  resumeInterruptedRun,
  isContinuationRunId,
  outdatedRunsOnSourceOrCanonChange,
  parseWriterResult,
} from './continuationGenerationRunner';
export type { StartContinuationRunInput, StageLlmCaller } from './continuationGenerationRunner';
export { summarizeTrace, parseTraceJson } from './continuationContextTrace';
export {
  extractAndSaveStyleProfile,
  getStyleProfile,
} from './continuationStyleService';
