/**
 * Phase 3 AI continuation types (Spec §7–§15).
 * Independent of freeform PipelineStageName.
 */
import type { ContinuationChapterPosition } from '../../../types/novel';
import type {
  CanonCapabilities,
  CanonContextBundle,
  HistoricalDigest,
} from '../canon/types';
import type { ContinuationSourceSnapshot } from '../types';
import type { ContinuationStageBudgets } from './continuationContextBudget';
import type { StyleRenderLevel } from '../styleProfile/styleProfileRenderer';
import type { OriginalStyleProfileV2 } from '../styleProfile/styleProfileV2Schema';

export type ContinuationStageName =
  | 'context'
  | 'planner'
  | 'writer'
  | 'checker'
  | 'repair'
  | 'awaiting_user';

export type ContinuationRunState =
  | 'queued'
  | 'running'
  | 'awaiting_user'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'outdated';

export type StrictnessProfile = 'loose' | 'balanced' | 'strict' | 'custom';
export type CheckLevel = 'off' | 'balanced' | 'strict';
export type PolicyLevel = 'allow' | 'require_confirmation' | 'forbid';
export type PlannerConfirmationPolicy = 'never' | 'risk_only' | 'always';

export type CheckCategory =
  | 'world'
  | 'character'
  | 'relationship'
  | 'plot'
  | 'experience'
  | 'knowledge'
  | 'timeline'
  | 'style';

export type CheckSeverity = 'info' | 'warning' | 'error' | 'blocking';

export type CheckResolutionStatus =
  | 'open'
  | 'auto_repaired'
  | 'accepted_by_user'
  | 'dismissed_by_user'
  | 'obsolete';

export type ProposalType =
  | 'character_state'
  | 'relationship_change'
  | 'plot_advance'
  | 'character_experience'
  | 'knowledge_change'
  | 'new_world_fact'
  | 'new_character'
  | 'new_location'
  | 'new_organization'
  | 'foreshadowing'
  | 'other';

export type ProposalStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'superseded'
  | 'invalidated';

export type OutboxOperation =
  | 'extract_state'
  | 'apply_event'
  | 'rebuild_story_memory';

export type OutboxState =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'cancelled';

export type TypedEntityRef =
  | { refType: 'canon_character'; id: number }
  | { refType: 'continuation_entity'; id: string }
  | { refType: 'plotline'; id: number }
  | { refType: 'world'; id: 'world' };

export interface ContinuationGenerationSettings {
  projectId: number;
  strictnessProfile: StrictnessProfile;
  worldRuleLevel: CheckLevel;
  characterLevel: CheckLevel;
  relationshipLevel: CheckLevel;
  plotLevel: CheckLevel;
  experienceLevel: CheckLevel;
  knowledgeLevel: CheckLevel;
  styleLevel: CheckLevel;
  allowNewCharacters: boolean;
  allowNewLocations: boolean;
  allowNewOrganizations: boolean;
  majorRelationshipChangePolicy: PolicyLevel;
  majorPowerChangePolicy: PolicyLevel;
  characterDeathPolicy: PolicyLevel;
  resurrectionPolicy: PolicyLevel;
  plannerLlmConfigId: number | null;
  writerLlmConfigId: number | null;
  checkerLlmConfigId: number | null;
  repairLlmConfigId: number | null;
  stateExtractionLlmConfigId: number | null;
  plannerConfirmationPolicy: PlannerConfirmationPolicy;
  checkerEnabled: boolean;
  maxRepairRounds: number;
  targetChapterChars: number;
  customRulesJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContinuationGenerationSettingsSnapshot {
  schemaVersion: 1;
  /** Versioned generation protocol. Missing means legacy Planner semantics. */
  workflowVersion?: 2;
  values: ContinuationGenerationSettings;
  resolvedModelConfigIds: {
    planner: number;
    writer: number;
    checker: number | null;
    repair: number | null;
    stateExtraction: number;
  };
  /**
   * Non-secret routing fields frozen at run creation. API keys remain in
   * Android Keystore and are never serialized into a run snapshot.
   */
  frozenModelConfigs?: {
    planner: FrozenContinuationModelConfig | null;
    writer: FrozenContinuationModelConfig | null;
    checker: FrozenContinuationModelConfig | null;
    repair: FrozenContinuationModelConfig | null;
    stateExtraction: FrozenContinuationModelConfig | null;
  };
}

export interface FrozenContinuationModelConfig {
  configId: number;
  name: string;
  providerType: 'openai_compatible';
  url: string;
  modelName: string;
  contextWindow: number;
  maxOutputTokens: number;
}

/**
 * Legacy thin metrics shape (pre-V2). Still used by deterministic checker
 * heuristics and older run snapshots. Prefer `ContinuationContextSnapshot.style`
 * (frozen V2 profile) for prompt injection.
 */
export interface ContinuationStyleProfile {
  projectId: number;
  sourceId: number;
  canonSnapshotId: string;
  canonRevision: number;
  narrativePerson: string;
  tense: string;
  averageSentenceLength: number;
  averageParagraphLength: number;
  dialogueRatio: number;
  descriptionRatio: number;
  pacingNotes: string;
  lexicalNotes: string;
  sampleEvidenceIds: number[];
  reviewStatus: 'pending' | 'confirmed' | 'ignored';
}

/**
 * Frozen original-style injection payload for a generation run (Spec §9).
 * Context Builder fills this from the injectable repository path only —
 * never via bare SQL, and never by triggering Style Analysis LLM.
 */
export interface ContinuationFrozenStyle {
  profileId: string;
  profileHash: string;
  profileSchemaVersion: number;
  analyzerVersion: string;
  rendererVersion: string;
  sourceFingerprint: string;
  boundaryCharOffsetExclusive: number;
  frozenProfile: OriginalStyleProfileV2 | Record<string, unknown>;
  userOverrides: Record<string, unknown>;
  /** Selected multi-level render tier for Writer; null when omitted. */
  renderLevel?: StyleRenderLevel | null;
  /** Token budget allocated to style for this snapshot. */
  styleTokens?: number;
  /** Why style was omitted or degraded (trace-friendly). */
  omitReason?: string | null;
}

export interface EffectiveContinuationState {
  schemaVersion: 1;
  targetPosition: ContinuationChapterPosition;
  characterStates: Array<{
    ref: TypedEntityRef;
    summary: string;
    fields: Record<string, string | null>;
    source: 'canon' | 'state_event' | 'story_memory';
  }>;
  relationships: Array<{
    source: TypedEntityRef;
    target: TypedEntityRef;
    summary: string;
    sourceLayer: 'canon' | 'state_event';
  }>;
  plotThreads: Array<{
    id: string | number;
    title: string;
    status: string;
    summary: string;
    sourceLayer: 'canon' | 'state_event';
  }>;
  knowledge: Array<{
    ref: TypedEntityRef;
    factKey: string;
    factSummary: string;
    knowledgeState: string;
  }>;
  experiences: Array<{
    ref: TypedEntityRef;
    title: string;
    summary: string;
  }>;
  freshness: {
    canonReady: boolean;
    storyMemoryStatus: string;
    pendingStateExtractionCount: number;
    pendingMajorProposalCount: number;
    dirtyFromPosition: ContinuationChapterPosition | null;
  };
  appliedEventIds: string[];
  omittedReasons: string[];
}

export interface ContinuationContextBundles {
  lockedRules: string[];
  canon: CanonContextBundle;
  /** Weak historical overview only; never Canon evidence or a hard rule. */
  historicalDigests?: HistoricalDigest[];
  effectiveState: EffectiveContinuationState;
  seam: { summary: string; excerpt: string };
  recentChapters: Array<{
    chapterId: number;
    position: ContinuationChapterPosition;
    revisionHash: string;
    excerpt: string;
  }>;
  storyMemory: {
    summary: string;
    estimatedTokens: number;
    /** Eligibility is persisted for diagnostics without exposing unusable state. */
    eligibilityReason?: string;
    throughPosition?: ContinuationChapterPosition | -1;
  };
  episodic: Array<{ chapterId: number; summary: string }>;
  /**
   * Compact injectable metrics summary for checker heuristics / legacy readers.
   * Full frozen V2 profile lives on `ContinuationContextSnapshot.style`.
   */
  style: ContinuationStyleProfile | null;
  /** Schema 2 snapshots persist this; optional for safely reading Schema 1 runs. */
  supplements?: ContinuationSupplementBundle;
  userInstruction: string;
}

export interface ContinuationSupplementBundle {
  characterText: string;
  worldbookText: string;
  noteText: string;
  presetText: string;
  selected: Array<{
    resourceKind: 'character' | 'worldbook' | 'note' | 'preset';
    resourceId: number;
    title: string;
    estimatedTokens: number;
  }>;
  excluded: Array<{
    resourceKind: 'character' | 'worldbook' | 'note' | 'preset';
    resourceId: number;
    title: string;
    reason: string;
  }>;
}

export interface ContinuationContextSnapshot {
  schemaVersion: 1 | 2;
  /** New standard workflow marker; absent on historical snapshots. */
  workflowVersion?: 2;
  projectId: number;
  targetChapterId: number;
  targetPosition: ContinuationChapterPosition;
  source: ContinuationSourceSnapshot;
  canon: {
    snapshotId: string;
    revision: number;
    boundaryGlobalCharOffset: number;
    capabilities: CanonCapabilities;
    coverageWarning?: string;
  };
  storyMemory: {
    stateFingerprint: string;
    throughPosition: ContinuationChapterPosition | -1;
    status: string;
  };
  inputRevisionHash: string;
  /** Frozen request budget; optional for runs created before adaptive planning. */
  contextBudget?: {
    modelContextLimit: number;
    inputBudget: number;
    reservedOutputTokens: number;
    writerMaxOutputTokens: number;
    /** First Writer call; max output stays reserved for a possible retry. */
    writerInitialOutputTokens?: number;
    /** Style share of the planned input layout (WP3). */
    styleTokens?: number;
  };
  /**
   * Per-stage capacity frozen at run creation (Spec §7.1). Resume reuses these
   * rather than re-reading live model windows.
   */
  stageBudgets?: ContinuationStageBudgets;
  /**
   * Frozen injectable original-style profile (Spec §9). New continuation runs
   * always require it; null is only possible in legacy persisted snapshots.
   */
  style?: ContinuationFrozenStyle | null;
  /** Frozen正文接缝. Optional so Schema 1 runs remain readable. */
  primaryAnchor?: import('./continuationAnchor').ContinuationAnchor;
  settingsSnapshot: ContinuationGenerationSettingsSnapshot;
  bundles: ContinuationContextBundles;
  createdAt: string;
}

export interface ContinuationContextTrace {
  sourceId: number;
  canonSnapshotId: string;
  canonRevision: number;
  targetPosition: ContinuationChapterPosition;
  entityRefs: TypedEntityRef[];
  storyMemoryFingerprint: string;
  freshness: {
    canonReady: boolean;
    storyMemoryStatus: string;
    pendingStateExtractionCount: number;
    pendingMajorProposalCount: number;
  };
  categories: Array<{
    name: string;
    candidates: number;
    selected: number;
    /** Candidates supplied by the dedicated primary-anchor block, not duplicated here. */
    coveredByPrimaryAnchor?: number;
    tokens: number;
    omittedReasonCounts: Record<string, number>;
  }>;
  totalInputTokens: number;
  reservedOutputTokens: number;
  /** Optional for Schema 1 run snapshots created before adaptive planning. */
  inputBudget?: number;
  modelContextLimit?: number;
  omittedCapabilities: string[];
  /** Added in Context Snapshot schema 2; absent on legacy traces. */
  primaryAnchorKind?: 'source_seam' | 'continuation_chapter';
  primaryAnchorChapterId?: number | null;
  primaryAnchorPosition?: ContinuationChapterPosition | null;
  /** Standard workflow budget trace. Optional for legacy snapshots. */
  effectiveWindow?: number;
  contextUtilizationRatio?: number;
  maxOutputRatio?: number;
  declaredOutput?: number;
  chapterDemand?: number;
  pressure?: number;
  planShare?: number;
  hardContextTokens?: number;
  desiredOutput?: number;
  requestedMaxTokens?: number;
  effectiveInputBudget?: number;
  minimumOutput?: number;
  budgetRestrictedReason?: string | null;
}

export interface StoryBeat {
  order: number;
  summary: string;
  conflict?: string;
}

export interface CharacterAction {
  characterId: number;
  action: string;
  motivation?: string;
}

export interface PlotAdvance {
  plotThreadId: number | string;
  advance: string;
}

export interface ForeshadowingAction {
  action: 'plant' | 'advance' | 'resolve';
  summary: string;
}

export interface ProposedStateChange {
  type: ProposalType;
  summary: string;
  risk: 'normal' | 'major';
  subjectRef?: TypedEntityRef;
}

export interface ContinuationRisk {
  code: string;
  severity: CheckSeverity;
  description: string;
}

export interface ContinuationPlan {
  schemaVersion: 1;
  chapterGoal: string;
  centralConflict: string;
  beats: StoryBeat[];
  participatingCharacterIds: number[];
  characterActions: CharacterAction[];
  plotAdvances: PlotAdvance[];
  foreshadowingActions: ForeshadowingAction[];
  proposedStateChanges: ProposedStateChange[];
  risks: ContinuationRisk[];
}

export interface ContinuationGenerationRun {
  id: string;
  /** Derived from the frozen context snapshot; absent on legacy rows. */
  workflowVersion?: 2;
  projectId: number;
  chapterId: number;
  targetPosition: ContinuationChapterPosition;
  sourceId: number | null;
  sourceSnapshotJson: string;
  canonSnapshotId: string | null;
  canonRevision: number;
  storyMemoryFingerprint: string;
  storyMemoryThroughPosition: number;
  inputRevisionHash: string;
  userInstruction: string;
  settingsSnapshotJson: string;
  contextSnapshotJson: string | null;
  contextTraceJson: string | null;
  tokenUsageJson: string;
  state: ContinuationRunState;
  stage: ContinuationStageName;
  completionReason: 'adopted' | 'abandoned' | null;
  adoptedRevisionHash: string | null;
  finalizedRevisionHash: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ContinuationArtifact {
  id: string;
  runId: string;
  stage: 'writer' | 'repair' | 'user_edit';
  repairRound: number;
  parentArtifactId: string | null;
  content: string;
  contentHash: string;
  createdAt: string;
}

export interface ContinuationCheckResult {
  id: number;
  runId: string;
  chapterId: number;
  artifactId: string;
  artifactHash: string;
  category: CheckCategory;
  subtype: string;
  severity: CheckSeverity;
  confidence: number;
  generatedStart: number | null;
  generatedEnd: number | null;
  generatedExcerpt: string;
  description: string;
  entityRefType: string | null;
  entityRefId: string | null;
  evidenceIds: number[];
  suggestedFix: string | null;
  resolutionStatus: CheckResolutionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ContinuationStateProposal {
  id: string;
  projectId: number;
  chapterId: number;
  sourceRunId: string | null;
  extractionContentHash: string;
  chapterRevisionHash: string;
  proposalType: ProposalType;
  subjectRefType: string | null;
  subjectRefId: string | null;
  payloadJson: string;
  proposalFingerprint: string;
  evidenceStart: number;
  evidenceEnd: number;
  status: ProposalStatus;
  decisionNote: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContinuationStateEvent {
  id: string;
  proposalId: string;
  projectId: number;
  chapterId: number;
  chapterPosition: ContinuationChapterPosition;
  chapterRevisionHash: string;
  eventType: string;
  entityRefs: TypedEntityRef[];
  payloadJson: string;
  validFromPosition: ContinuationChapterPosition;
  validToPosition: ContinuationChapterPosition | null;
  createdAt: string;
  invalidatedAt: string | null;
  invalidationReason: string | null;
}

export interface ContinuationOutboxItem {
  id: string;
  projectId: number;
  chapterId: number | null;
  operation: OutboxOperation;
  payloadJson: string;
  dedupeKey: string;
  state: OutboxState;
  attemptCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export class ContinuationCapabilityBlockedError extends Error {
  readonly code = 'continuation_capability_blocked';
  constructor(message: string) {
    super(message);
    this.name = 'ContinuationCapabilityBlockedError';
  }
}

export class ContinuationOutdatedError extends Error {
  readonly code = 'continuation_run_outdated';
  constructor(message = '续写 run 已过期，请重新发起。') {
    super(message);
    this.name = 'ContinuationOutdatedError';
  }
}

export class ContinuationConflictError extends Error {
  readonly code = 'continuation_conflict';
  constructor(message: string) {
    super(message);
    this.name = 'ContinuationConflictError';
  }
}
