/**
 * Phase 2 Canon public surface.
 *
 * Phase 3 and UI should import from here (or specific service files):
 *   - CanonQueryService  — only read path for generation
 *   - canonAnalysisService — start/process/activate analysis
 *   - canonReviewService — human governance
 *   - canonInvalidationService — source/boundary invalidation
 *
 * Do NOT import canonRepository from UI or Phase 3 for ad-hoc SQL.
 */
export * from './types';
export { CanonQueryService } from './canonQueryService';
export {
  ANALYSIS_MODE_PRESETS,
  ANALYSIS_MATERIAL_LABELS,
  extractWithLlm,
  startAnalysis,
  processAnalysisRun,
  activateSnapshot,
  pauseAnalysis,
  cancelAnalysis,
  resumeAnalysis,
  pauseInterruptedRuns,
  getAnalysisOverview,
  getAnalysisWorkItems,
  probeModelCapability,
  getCachedProbe,
  materializeBatchResult,
} from './canonAnalysisService';
export type {
  StartAnalysisInput,
  AnalysisProgressUpdate,
  ProcessAnalysisOptions,
} from './canonAnalysisService';
export {
  setReviewStatus,
  unlockRecord,
  reviseWorldRule,
  createUserWorldRule,
  batchConfirmHighConfidence,
  listCanonRows,
} from './canonReviewService';
export type { GovernedTable } from './canonReviewService';
export {
  invalidateProjectCanon,
  isCanonReadyForGeneration,
} from './canonInvalidationService';
export {
  queueHistoricalDigests,
  processHistoricalDigest,
  getHistoricalDigestCoverage,
  listHistoricalDigestReferences,
  findHistoricalChapterCandidates,
  markHistoricalDigestsOutdated,
} from './historicalDigestService';
export {
  buildUniqueCharacterNameIndex,
  normalizeAlias,
  longestMatchAliases,
  isAmbiguousShortAlias,
} from './canonEntityResolver';
export {
  parseExtractionResultJson,
  validateExtractionResult,
  stripModelJson,
  EXTRACTION_RESULT_SCHEMA_VERSION,
} from './canonJsonValidators';
export {
  validateEvidenceRange,
  listEvidenceForOwner,
  readEvidenceView,
} from './canonEvidenceService';
