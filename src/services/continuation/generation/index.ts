/**
 * Phase 3 generation public surface.
 */
export * from './types';
export {
  ensureGenerationSettings,
  updateGenerationSettings,
  getRunById,
  getRunContextSnapshotJson,
  findLatestAdoptedRunForChapter,
  findLatestPendingReviewRunForChapter,
  listPendingReviewRunsForProject,
  listRunsForProject,
  listRunningRuns,
  insertArtifact,
  getLatestArtifact,
  getLatestArtifactForStage,
  getLatestEligibleArtifact,
  getArtifactById,
  getArtifactForRun,
  getEligibleArtifactForRun,
  getStageResult,
  listStageResults,
  ensureContinuationV4StageResults,
  ensureContinuationV5StageResults,
  reserveContinuationStage,
  updateStageResult,
  finalizeContinuationV4Repair,
  finalizeContinuationV4LocalGate,
  finalizeContinuationV5Final,
  finalizeContinuationV5ValidatorOnly,
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
  requiredControlProgressHan,
  reportLengthAction,
  isStyleIssueRepairReady,
  getRepairReadyStyleFindings,
  STYLE_REPAIR_CONFIDENCE_MIN,
  CONTROL_PROGRESS_RATIO,
  CONTROL_PROGRESS_FLOOR_HAN,
} from './continuationControl';
export type { ContinuationControlParseResult } from './continuationControl';
export {
  evaluateRepairCompleteness,
  splitNaturalParagraphs,
  DEFAULT_REPAIR_COMPLETENESS_POLICY,
  REPAIR_SUMMARY_PHRASES,
} from './repairCompletenessPolicy';
export type {
  RepairCompletenessMetrics,
  RepairCompletenessPolicy,
  RepairCompletenessResult,
} from './repairCompletenessPolicy';
export {
  selectContinuationAnchor,
  type ContinuationAnchor,
  type ContinuationAnchorChapter,
  type ContinuationSourceSeam,
} from './continuationAnchor';
export {
  buildRepairUnifiedTasks,
  injectRepairAnchors,
  stripRepairAnchors,
  renderStyleFinding,
  resolveStyleFindingExcerpt,
  REPAIR_ANCHOR_MARKER_PATTERN,
} from './continuationV4PromptCompiler';
export {
  runDeterministicChecks,
  parseCheckerLlmJson,
  parseCheckerLlmEnvelope,
  bindIssuesToArtifact,
  filterBySettings,
  uncheckedCategories,
  isRepairableCheckerIssue,
  isLengthExpansionIssue,
} from './continuationChecker';
export type { CheckerLlmEnvelope } from './continuationChecker';
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
export { commitAcceptedProposal } from './commitStateProposal';
export {
  getEffectiveContinuationState,
  confirmProposal,
  confirmAllProposals,
  rejectProposal,
  invalidateContinuationStateFromPosition,
  onChapterContentChanged,
} from './continuationStateService';
export {
  processContinuationOutbox,
  coldStartNormalizeContinuation,
  deterministicExtractFromText,
} from './continuationStateOutboxWorker';
// Adoption / finalization / cancel domain operations moved to the unified
// Writing persist layer (Kernel Final Closure). The barrel re-exports them
// from the production module; the legacy runner is no longer a barrel
// dependency.
export {
  repairContinuationArtifactOnce,
  confirmPlanAndContinue,
  cancelContinuationRun,
  adoptArtifactAsDraft,
  abandonRun,
  finalizeContinuationChapter,
  isContinuationRunId,
  outdatedRunsOnSourceOrCanonChange,
} from '../../writing/persist/continuationAdoption';
export type {
  StartContinuationRunInput,
  StageLlmCaller,
} from '../../writing/scenario/continuationWritingTypes';
export type { ContinuationV4LocalGateInput } from './generationRepository';
export {
  validateFinalArtifact,
} from './finalArtifactValidator';
export type {
  FinalArtifactValidationResult,
  FinalArtifactValidationCode,
} from './finalArtifactValidator';
export {
  CONTINUATION_V5_LENGTH_POLICY,
  CONTINUATION_V5_SOFT_GATES,
  buildFallbackArchitecture,
  buildFallbackAuditContract,
  diagnoseLengthTelemetry,
  resolveV5LengthTargets,
} from './continuationV5Contracts';
export {
  resolveContinuationV5StageBudget,
  preflightContinuationV5StageBudget,
  resolveContinuationV5BudgetPreview,
} from './continuationV5Budget';
export {
  compileContinuationV5DraftWriterMessages,
  compileContinuationV5ArchitectMessages,
  compileContinuationV5RevisionWriterMessages,
  compileContinuationV5AuditorMessages,
  compileContinuationV5FinalReviserWithinBudget,
} from './continuationV5PromptCompiler';
export { summarizeTrace, parseTraceJson } from './continuationContextTrace';
export {
  appendContinuationGenerationTraceEvent,
  createContinuationGenerationTrace,
  createContinuationBatchTraceId,
  ensureContinuationGenerationTrace,
} from './continuationGenerationTrace';
export type {
  AppendContinuationGenerationTraceEventInput,
  CreateContinuationGenerationTraceInput,
  EnsureContinuationGenerationTraceOptions,
} from './continuationGenerationTrace';
export {
  extractAndSaveStyleProfile,
  getStyleProfile,
} from './continuationStyleService';
