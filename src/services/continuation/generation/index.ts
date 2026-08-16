/**
 * Phase 3 generation public surface.
 */
export * from './types';
export {
  ensureGenerationSettings,
  updateGenerationSettings,
  getRunById,
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
  buildContinuationContext,
  buildContinuationV4Context,
  buildContinuationV5Context,
} from './continuationContextBuilder';
export type {
  BuildContinuationContextInput,
  BuildContinuationV4ContextInput,
  BuildContinuationV5ContextInput,
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
export type { ContinuationV4LocalGateInput } from './generationRepository';
export {
  startContinuationV4Run,
  resumeContinuationV4Run,
  markContinuationV4StagesCancelled,
  runContinuationV4LocalFinalGate,
  validateContinuationV4RepairCompliance,
  parseContinuationV4WriterEnvelope,
  parseContinuationV4RepairEnvelope,
} from './continuationV4Runner';
export {
  startContinuationV5Run,
  resumeContinuationV5Run,
  markContinuationV5StagesCancelled,
  parseContinuationV5DraftEnvelope,
  parseContinuationV5ArchitectureEnvelope,
  parseContinuationV5RevisionEnvelope,
  parseContinuationV5AuditEnvelope,
  parseContinuationV5FinalEnvelope,
  hashArchitectureEnvelope,
  hashAuditEnvelope,
} from './continuationV5Runner';
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
