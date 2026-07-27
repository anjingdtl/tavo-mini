/**
 * Phase 3 generation public surface.
 */
export * from './types';
export {
  ensureGenerationSettings,
  updateGenerationSettings,
  getRunById,
  listRunsForProject,
  listRunningRuns,
  getLatestArtifact,
  getArtifactById,
  getPlan,
  listChecksForArtifact,
  listProposals,
  getProposalById,
  listValidEventsBefore,
  enqueueOutbox,
  getOutboxByDedupe,
  markRunsInterruptedOnColdStart,
  contentRevisionHash,
  resolveCheck,
  newContinuationRunId,
} from './generationRepository';
export { buildContinuationContext } from './continuationContextBuilder';
export type { BuildContinuationContextInput } from './continuationContextBuilder';
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
