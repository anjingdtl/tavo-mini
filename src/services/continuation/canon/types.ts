/**
 * Phase 2 Canon public types (Spec §5, §6, §13, §22).
 *
 * Phase 3 MUST consume Canon only via CanonQueryService — never query tables.
 */
import type { SourceChapterPosition, Utf16Offset } from '../../../types/novel';

export const EXTRACTION_VERSION = 'v1';
export const CANON_SNAPSHOT_OUTDATED = 'canon_snapshot_outdated';

export type AnalysisProfile = 'quick' | 'standard' | 'deep';

/** The only two analysis experiences available for newly created runs. */
export type ContinuationAnalysisMode = 'fast_continuation' | 'full_canon';

export type AnalysisScopeKind = 'full' | 'tail' | 'adaptive';

/**
 * Persisted with the run checkpoint and coverage so partial Canon snapshots
 * never look like a complete source analysis.
 */
export interface AnalysisScope {
  schemaVersion: 1;
  kind: AnalysisScopeKind;
  tailChapterCount: number | null;
}

export interface AnalyzedChapterRange {
  startPosition: SourceChapterPosition;
  endPosition: SourceChapterPosition;
}

export type AnalysisRunState =
  | 'queued'
  | 'running'
  | 'paused'
  | 'awaiting_review'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'outdated';

export type AnalysisStage =
  | 'snapshot'
  | 'chapter_extraction'
  | 'entity_resolution'
  | 'temporal_merge'
  | 'global_synthesis'
  | 'evidence_validation'
  | 'indexing'
  | 'finalizing'
  | 'style_analysis'
  | 'style_validation';

export type CanonReviewStatus =
  | 'pending'
  | 'confirmed'
  | 'locked'
  | 'ignored'
  | 'superseded';

export type CanonOrigin = 'ai' | 'user';

export type CanonSnapshotStatus =
  | 'staging'
  | 'awaiting_review'
  | 'ready'
  | 'outdated'
  | 'failed';

export type CanonConstraintLevel = 'hard' | 'strong' | 'reference';

export type CharacterImportance = 'primary' | 'major' | 'supporting' | 'minor';

export type RelationshipPublicStatus =
  | 'public'
  | 'secret'
  | 'misunderstood'
  | 'one_sided';

export type PlotThreadLevel =
  | 'main'
  | 'volume'
  | 'arc'
  | 'subplot'
  | 'foreshadowing';

export type PlotThreadStatus =
  | 'active'
  | 'paused'
  | 'resolved'
  | 'abandoned'
  | 'unknown';

export type CharacterKnowledgeState =
  | 'unknown'
  | 'suspected'
  | 'known'
  | 'misunderstood';

export type ReviewPolicy = 'strict' | 'balanced' | 'loose';

export type EvidenceOwnerType =
  | 'world_rule'
  | 'character'
  | 'alias'
  | 'character_state'
  | 'relationship'
  | 'plot_thread'
  | 'experience'
  | 'knowledge'
  | 'timeline_event';

export interface CanonCapabilities {
  worldRules: boolean;
  characterProfiles: boolean;
  characterStates: boolean;
  relationships: boolean;
  plotThreads: boolean;
  experiences: boolean;
  knowledgeBoundaries: boolean;
  timelineEvents: boolean;
  evidenceValidated: boolean;
}

export interface CanonCoverage {
  schemaVersion: 1 | 2;
  sourceChapterCount: number;
  analyzedChapterCount: number;
  analyzedThroughPosition: SourceChapterPosition;
  categoryCounts: Record<keyof CanonCapabilities, number>;
  incompleteReasons: string[];
  /** Absent on Schema v1 coverage persisted before scoped analysis. */
  scope?: AnalysisScope;
  /** Absent on Schema v1 coverage persisted before scoped analysis. */
  analyzedRanges?: AnalyzedChapterRange[];
}

export interface CanonGovernanceFields {
  id: number;
  projectId: number;
  sourceId: number;
  snapshotId: string;
  analysisRunId: string;
  validFromPosition: SourceChapterPosition;
  validToPosition: SourceChapterPosition | null;
  firstObservedPosition: SourceChapterPosition;
  lastObservedPosition: SourceChapterPosition;
  confidence: number;
  reviewStatus: CanonReviewStatus;
  origin: CanonOrigin;
  extractionVersion: string;
  revision: number;
  supersedesId: number | null;
  userReviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Phase 3 handoff snapshot (Spec §22). */
export interface CanonSnapshot {
  id: string;
  projectId: number;
  sourceId: number;
  sourceVersion: number;
  sourceSha256: string;
  parserVersion: string;
  normalizationVersion: string;
  boundaryPosition: SourceChapterPosition;
  boundaryCharOffsetExclusive: Utf16Offset;
  boundaryChapterId: number;
  extractionVersion: string;
  profile: AnalysisProfile;
  revision: number;
  capabilities: CanonCapabilities;
  coverage: CanonCoverage;
  status: CanonSnapshotStatus;
  analysisRunId: string | null;
  activatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorldRule extends CanonGovernanceFields {
  category: string;
  title: string;
  description: string;
  constraintLevel: CanonConstraintLevel;
}

export interface CharacterProfile extends CanonGovernanceFields {
  canonicalName: string;
  description: string;
  background: string;
  appearanceJson: string;
  personalityJson: string;
  valuesJson: string;
  behaviorPatternsJson: string;
  speechStyleJson: string;
  abilitiesJson: string;
  weaknessesJson: string;
  goalsJson: string;
  fearsJson: string;
  secretsJson: string;
  firstAppearancePosition: SourceChapterPosition;
  importance: CharacterImportance;
}

export interface CharacterAlias extends CanonGovernanceFields {
  characterId: number;
  alias: string;
  aliasNormalized: string;
  aliasType: string;
  isAmbiguous: boolean;
}

export interface CharacterStateSnapshot extends CanonGovernanceFields {
  characterId: number;
  chapterPosition: SourceChapterPosition;
  location: string | null;
  physicalState: string | null;
  emotionalState: string | null;
  identityState: string | null;
  organizationState: string | null;
  currentGoal: string | null;
  possessionsJson: string;
  abilitiesStateJson: string;
  aliveState: 'alive' | 'dead' | 'unknown';
  summary: string;
}

export interface CharacterRelationship extends CanonGovernanceFields {
  sourceCharacterId: number;
  targetCharacterId: number;
  relationType: string;
  attitude: string;
  publicStatus: RelationshipPublicStatus;
  description: string;
  causesJson: string;
}

export interface PlotThread extends CanonGovernanceFields {
  title: string;
  description: string;
  level: PlotThreadLevel;
  status: PlotThreadStatus;
  importance: number;
  startPosition: SourceChapterPosition;
  lastAdvancedPosition: SourceChapterPosition;
  resolvedPosition: SourceChapterPosition | null;
  establishedFactsJson: string;
  unresolvedQuestionsJson: string;
  expectedDirectionsJson: string;
}

export interface CharacterExperience extends CanonGovernanceFields {
  characterId: number;
  chapterPosition: SourceChapterPosition;
  eventType: string;
  title: string;
  description: string;
  involvedCharacterIdsJson: string;
  impactOnPersonality: string | null;
  impactOnGoal: string | null;
  impactOnRelationship: string | null;
  knowledgeGainedJson: string;
  secretsLearnedJson: string;
  importance: number;
}

export interface CharacterKnowledge extends CanonGovernanceFields {
  characterId: number;
  factKey: string;
  factSummary: string;
  knowledgeState: CharacterKnowledgeState;
  learnedPosition: SourceChapterPosition | null;
  learnedFromCharacterId: number | null;
  misunderstandingSummary: string | null;
}

export interface CanonTimelineEvent extends CanonGovernanceFields {
  eventKey: string;
  title: string;
  summary: string;
  eventType: string;
  chapterPosition: SourceChapterPosition;
  charStart: number | null;
  charEnd: number | null;
  participantCharacterIdsJson: string;
  locationBefore: string | null;
  locationAfter: string | null;
  relativeTimeJson: string;
  causesEventIdsJson: string;
  consequencesEventIdsJson: string;
  importance: number;
}

export interface CanonEvidence {
  id: number;
  projectId: number;
  sourceId: number;
  snapshotId: string;
  chapterId: number;
  chapterPosition: SourceChapterPosition;
  paragraphStart: number | null;
  paragraphEnd: number | null;
  charStart: number;
  charEnd: number;
  quotePreview: string;
  quoteSha256: string;
  analysisRunId: string;
  createdAt: string;
}

export interface CanonEvidenceView extends CanonEvidence {
  quoteFull: string;
}

export interface ResolvedCharacterMention {
  text: string;
  start: number;
  end: number;
  characterId: number | null;
  candidates: Array<{ characterId: number; name: string; confidence: number }>;
  ambiguous: boolean;
}

export interface CanonContextBundle {
  snapshot: CanonSnapshot;
  worldRules: WorldRule[];
  characters: CharacterProfile[];
  characterStates: CharacterStateSnapshot[];
  relationships: CharacterRelationship[];
  experiences: CharacterExperience[];
  knowledge: CharacterKnowledge[];
  plotThreads: PlotThread[];
  timelineEvents: CanonTimelineEvent[];
  evidenceRefs: number[];
  /**
   * Selected facts' evidence ids, grouped by the evidence-link owner.  This is
   * optional for backward-compatible frozen run snapshots created before the
   * continuation fact-checker started rendering inline citations.
   */
  evidenceRefsByOwner?: Partial<
    Record<EvidenceOwnerType, Record<number, number[]>>
  >;
  estimatedTokens: number;
  omittedReasonCounts: Record<string, number>;
}

/**
 * A compact LLM summary of chapters outside a scoped Canon window.
 * It is expressly not Canon and has no evidence IDs; callers must present it
 * as a lead for user-approved source verification rather than a fact.
 */
export interface HistoricalDigest {
  id: string;
  projectId: number;
  sourceId: number;
  sourceVersion: number;
  sourceSha256: string;
  parserVersion: string;
  normalizationVersion: string;
  boundaryChapterId: number;
  boundaryPosition: SourceChapterPosition;
  boundaryCharOffsetExclusive: Utf16Offset;
  startPosition: SourceChapterPosition;
  endPosition: SourceChapterPosition;
  status: 'queued' | 'running' | 'ready' | 'failed' | 'outdated' | 'cancelled';
  summary: string;
  keywords: string[];
  modelConfigId: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface HistoricalChapterCandidate {
  digestId: string;
  chapterId: number;
  chapterPosition: SourceChapterPosition;
  chapterTitle: string;
  matchedTerms: string[];
}

export interface AnalysisRun {
  id: string;
  projectId: number;
  sourceId: number;
  sourceVersion: number;
  sourceSha256: string;
  parserVersion: string;
  normalizationVersion: string;
  boundaryChapterId: number;
  boundaryPosition: SourceChapterPosition;
  boundaryCharOffsetExclusive: Utf16Offset;
  canonSnapshotId: string;
  profile: AnalysisProfile;
  modelConfigId: number | null;
  state: AnalysisRunState;
  stage: AnalysisStage;
  progressCurrent: number;
  progressTotal: number;
  extractionVersion: string;
  checkpointJson: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

/** Schema 34 batch coverage kinds for normal / chunk / tail / rescan work. */
export type AnalysisBatchCoverageKind =
  | 'full'
  | 'chunk'
  | 'retry_tail'
  | 'rescan';

export type AnalysisBatchState =
  | 'queued'
  | 'running'
  | 'partial'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AnalysisBatch {
  runId: string;
  canonSnapshotId: string;
  batchIndex: number;
  startPosition: SourceChapterPosition;
  endPosition: SourceChapterPosition;
  inputHash: string;
  idempotencyKey: string;
  state: AnalysisBatchState;
  attemptCount: number;
  resultJson: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** Parent batch index when this is a dynamic tail / rescan sub-batch. */
  parentBatchIndex: number | null;
  /** Route-exclusive sub-batch material type (null for normal dual-route batches). */
  materialType: AnalysisWorkItemType | null;
  /** Single-chapter segment batches pin the chapter id. */
  chapterId: number | null;
  /** Inclusive UTF-16 start within the chapter body (null = whole chapter range). */
  sourceCharStart: number | null;
  /** Exclusive UTF-16 end within the chapter body. */
  sourceCharEnd: number | null;
  coverageKind: AnalysisBatchCoverageKind;
  hadPartialCoverage: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

/** The five user-facing Canon material families extracted per source batch. */
export const ANALYSIS_MATERIAL_TYPES = [
  'world_rules',
  'characters',
  'relationships',
  'plot_threads',
  'experiences',
] as const;

export type AnalysisMaterialType = (typeof ANALYSIS_MATERIAL_TYPES)[number];

/**
 * Schema 23 request protocol. v3 originally merged the v2 two-call
 * `character_state` / `world_plot` split into a single `full_extraction` call
 * to halve input-token duplication, but that single call demands a 65536-token
 * output budget that stalls large-source analysis (500KB+ TXT) for minutes
 * with no progress feedback. v3.1 reverts to the two-call split: each call
 * outputs fewer categories (5 / 3) at a 32768-token budget, halves the
 * per-call timeout risk, and doubles the progress granularity.
 *
 * Legacy `full_extraction` remains readable so an interrupted v3 run can
 * resume without losing its completed work items.
 */
export const ANALYSIS_REQUEST_GROUPS = [
  'character_state',
  'world_plot',
] as const;

export type AnalysisRequestGroup = (typeof ANALYSIS_REQUEST_GROUPS)[number];

/**
 * Legacy group types (`character_state` / `world_plot` / `full_extraction`).
 * `full_extraction` was the v3 single-call protocol; v3.1 reverts to the
 * two-call split. All three remain in the type union so interrupted runs
 * from any protocol version can resume without a type error on the
 * persisted `materialType` column.
 */
type LegacyAnalysisRequestGroup =
  | 'character_state'
  | 'world_plot'
  | 'full_extraction';

export type AnalysisWorkItemType =
  | AnalysisMaterialType
  | AnalysisRequestGroup
  | LegacyAnalysisRequestGroup;
export type AnalysisWorkItemState =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AnalysisWorkItem {
  runId: string;
  batchIndex: number;
  /** Persisted column name retained for Schema 22 compatibility. */
  materialType: AnalysisWorkItemType;
  state: AnalysisWorkItemState;
  attemptCount: number;
  resultJson: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export class CanonSnapshotOutdatedError extends Error {
  readonly code = CANON_SNAPSHOT_OUTDATED;
  constructor(message = 'Canon 快照已过期或与 active pointer 不一致。') {
    super(message);
    this.name = 'CanonSnapshotOutdatedError';
  }
}

export function emptyCapabilities(profile: AnalysisProfile): CanonCapabilities {
  const full = profile !== 'quick';
  return {
    worldRules: true,
    characterProfiles: true,
    characterStates: full,
    relationships: full,
    plotThreads: true,
    experiences: true,
    knowledgeBoundaries: full,
    timelineEvents: full,
    evidenceValidated: false,
  };
}

export function emptyCoverage(
  through: SourceChapterPosition = 0 as SourceChapterPosition,
): CanonCoverage {
  return {
    schemaVersion: 1,
    sourceChapterCount: 0,
    analyzedChapterCount: 0,
    analyzedThroughPosition: through,
    categoryCounts: {
      worldRules: 0,
      characterProfiles: 0,
      characterStates: 0,
      relationships: 0,
      plotThreads: 0,
      experiences: 0,
      knowledgeBoundaries: 0,
      timelineEvents: 0,
      evidenceValidated: 0,
    },
    incompleteReasons: [],
  };
}
