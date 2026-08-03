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
  insertArtifact,
  getLatestArtifact,
  getLatestEligibleArtifact,
  getArtifactById,
  getArtifactForRun,
  getEligibleArtifactForRun,
  getStageResult,
  listStageResults,
  reserveContinuationStage,
  updateStageResult,
  finalizeContinuationV4Repair,
  newContinuationStageResultId,
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
export {
  buildContinuationContext,
  buildContinuationV4Context,
} from './continuationContextBuilder';
export type {
  BuildContinuationContextInput,
  BuildContinuationV4ContextInput,
} from './continuationContextBuilder';
export {
  assertContinuationStageBudget,
  preflightContinuationStageBudget,
  resolveContinuationStageBudget,
  planContinuationV4ContextBudget,
  resolveContinuationV4BudgetPreview,
} from './continuationV4Budget';
export type {
  ContinuationStageBudgetPreflight,
  ContinuationV4BudgetPreview,
  ContinuationV4BudgetPreviewInput,
  ContinuationV4Stage,
  ContinuationV4StageBudget,
  FrozenContinuationStageModel,
  ResolveContinuationStageBudgetInput,
} from './continuationV4Budget';
export {
  buildContinuationV4StageViews,
  hashContinuationV4StageView,
  EXTERNAL_SUPPLEMENT_WRAPPER,
} from './continuationV4ContextViews';
export {
  buildContinuationControlMetrics,
  buildContinuationControlFallback,
  parseContinuationControlReport,
  resolveContinuationControlReport,
} from './continuationControl';
export type { ContinuationControlParseResult } from './continuationControl';
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
  compileContinuationV4WriterMessages,
  compileContinuationV4CheckerMessages,
  compileContinuationV4ControlMessages,
  compileContinuationV4RepairMessages,
  continuationV4ProtocolSkeletonTokens,
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
