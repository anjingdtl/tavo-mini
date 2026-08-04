/**
 * Phase 3 AI continuation types (Spec §7–§15).
 * Independent of freeform PipelineStageName.
 */
import type { ContinuationChapterPosition } from '../../../types/novel';
import type { ContextAutomationPolicyV2 } from '../../contextAutomationPolicy';
import type {
  CanonCapabilities,
  CanonContextBundle,
  HistoricalDigest,
} from '../canon/types';
import type { ContinuationSourceSnapshot } from '../types';
import type { ContinuationStageBudgets } from './continuationContextBudget';
import type { ContinuationV4StageBudget } from './continuationV4Budget';
import type { StyleRenderLevel } from '../styleProfile/styleProfileRenderer';
import type { OriginalStyleProfileV2 } from '../styleProfile/styleProfileV2Schema';

export type ContinuationStageName =
  | 'context'
  | 'planner'
  | 'writer'
  | 'checker'
  | 'auditing'
  | 'repair'
  | 'local_verify'
  | 'awaiting_user';

/** Physical V4 nodes. `auditing` is the persisted run-level stage for the
 * parallel Checker/Control pair; their individual rows use these names. */
export type ContinuationV4StageName =
  | 'writer'
  | 'checker'
  | 'control'
  | 'repair'
  | 'local_verify';

export type ContinuationV4ContextStage = Exclude<
  ContinuationV4StageName,
  'local_verify'
>;

export type ContinuationStageResultStatus =
  | 'queued'
  | 'running'
  | 'success'
  | 'failed'
  | 'interrupted'
  | 'skipped';

export type ContinuationArtifactEligibility = 'eligible' | 'rejected';

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
  controlLlmConfigId: number | null;
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
  workflowVersion?: 2 | 4;
  values: ContinuationGenerationSettings;
  resolvedModelConfigIds: {
    planner: number;
    writer: number;
    checker: number | null;
    repair: number | null;
    stateExtraction: number;
    control?: number | null;
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
    control?: FrozenContinuationModelConfig | null;
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
    contentHash?: string;
    constraintKind?: 'creative' | 'factual' | 'stylistic' | 'instruction';
    stageEligibility?: ContinuationV4ContextStage[];
    selectionReason?: string;
  }>;
  excluded: Array<{
    resourceKind: 'character' | 'worldbook' | 'note' | 'preset';
    resourceId: number;
    title: string;
    reason: string;
  }>;
}

export interface FrozenContinuationBudgetPolicy {
  schemaVersion: ContextAutomationPolicyV2['schemaVersion'];
  allocatorVersion: string;
  policyHash: string;
  policy: ContextAutomationPolicyV2;
  appliedAt?: string;
}

export type ContinuationV4StageBudgets = Record<
  ContinuationV4ContextStage,
  ContinuationV4StageBudget
>;

export interface FrozenContinuationStyleStageView {
  profileId: string | null;
  profileHash: string | null;
  rendererVersion: string | null;
  renderLevel: StyleRenderLevel | null;
  text: string;
  quantitative: {
    averageSentenceLength: number;
    averageParagraphLength: number;
    dialogueRatio: number;
    descriptionRatio: number;
    narrativePerson: string;
    tense: string;
  };
  omittedReason: string | null;
}

export interface FrozenContinuationSupplementStageView {
  text: string;
  selected: ContinuationSupplementBundle['selected'];
  omitted: ContinuationSupplementBundle['excluded'];
  contentHashes: string[];
  wrapper: string;
}

export interface FrozenContinuationCanonGuardView {
  hardFacts: Array<{
    ownerType: string;
    ownerId: number;
    text: string;
    evidenceIds: number[];
  }>;
  softFacts: Array<{
    ownerType: string;
    ownerId: number;
    text: string;
    evidenceIds: number[];
  }>;
  evidenceIds: number[];
}

export interface FrozenContinuationCheckerContextView {
  stage: 'checker';
  projectId: number;
  targetChapterId: number;
  targetPosition: ContinuationChapterPosition;
  targetChapterChars: number;
  userInstruction: string;
  lockedRules: string[];
  canon: FrozenContinuationCanonGuardView;
  effectiveState: Pick<
    EffectiveContinuationState,
    | 'characterStates'
    | 'relationships'
    | 'plotThreads'
    | 'knowledge'
    | 'experiences'
  >;
  seam: { summary: string; excerpt: string };
  style: FrozenContinuationStyleStageView;
  supplements: FrozenContinuationSupplementStageView;
  budget: ContinuationV4StageBudget;
  snapshotRefs: {
    canonSnapshotId: string;
    canonRevision: number;
    inputRevisionHash: string;
    styleProfileHash: string | null;
  };
}

export interface FrozenContinuationWriterContextView {
  stage: 'writer';
  projectId: number;
  targetChapterId: number;
  targetPosition: ContinuationChapterPosition;
  targetChapterChars: number;
  userInstruction: string;
  lockedRules: string[];
  canon: CanonContextBundle;
  effectiveState: EffectiveContinuationState;
  primaryAnchor: ContinuationContextSnapshot['primaryAnchor'];
  recentChapters: ContinuationContextBundles['recentChapters'];
  storyMemory: ContinuationContextBundles['storyMemory'];
  episodic: ContinuationContextBundles['episodic'];
  historicalDigests: HistoricalDigest[];
  style: FrozenContinuationStyleStageView;
  supplements: FrozenContinuationSupplementStageView;
  budget: ContinuationV4StageBudget;
  snapshotRefs: {
    canonSnapshotId: string;
    canonRevision: number;
    inputRevisionHash: string;
    styleProfileHash: string | null;
  };
}

export interface FrozenContinuationControlContextView {
  stage: 'control';
  projectId: number;
  targetChapterId: number;
  targetPosition: ContinuationChapterPosition;
  targetChapterChars: number;
  userInstruction: string;
  lockedRuleSummary: string[];
  style: FrozenContinuationStyleStageView;
  budget: ContinuationV4StageBudget;
  snapshotRefs: {
    canonSnapshotId: string;
    canonRevision: number;
    inputRevisionHash: string;
    styleProfileHash: string | null;
  };
}

export interface FrozenContinuationRepairContextView {
  stage: 'repair';
  projectId: number;
  targetChapterId: number;
  targetPosition: ContinuationChapterPosition;
  targetChapterChars: number;
  userInstruction: string;
  lockedRules: string[];
  canon: FrozenContinuationCanonGuardView;
  effectiveState: FrozenContinuationCheckerContextView['effectiveState'];
  primaryAnchorSummary: string;
  recentBridgeSummary: string;
  style: FrozenContinuationStyleStageView;
  supplements: FrozenContinuationSupplementStageView;
  budget: ContinuationV4StageBudget;
  snapshotRefs: {
    canonSnapshotId: string;
    canonRevision: number;
    inputRevisionHash: string;
    styleProfileHash: string | null;
  };
}

export interface ContinuationV4StageViews {
  writer: FrozenContinuationWriterContextView;
  checker: FrozenContinuationCheckerContextView;
  control: FrozenContinuationControlContextView;
  repair: FrozenContinuationRepairContextView;
}

export interface ContinuationV4Metrics {
  actualHanCharacters: number;
  targetHanCharacters: number;
  minHanCharacters: number;
  maxHanCharacters: number;
  missingToMinimum: number;
  excessOverMaximum: number;
  deltaToTarget: number;
  paragraphs: Array<{
    id: string;
    start: number;
    end: number;
    hanCharacters: number;
  }>;
  dialogueHanRatio: number;
  paragraphLengthDistribution: {
    min: number;
    max: number;
    mean: number;
    median: number;
  };
  duplicateWindows: Array<{ start: number; end: number; count: number }>;
  beatCoverage: Array<{ beatId: string; paragraphIds: string[] }>;
  insertionBoundaries: number[];
}

/**
 * Length-direction echo retained for telemetry/UI only.
 * V4 creative loosening: expand/compress never alone triggers Repair.
 */
export type ContinuationControlAction = 'keep' | 'expand' | 'compress';

export interface ContinuationControlSuggestion {
  suggestionId: string;
  type: string;
  location: string;
  expectedDeltaHan: number;
  instruction: string;
  preserveBeatIds: string[];
}

export type ContinuationControlFindingSeverity = 'info' | 'warning' | 'error';

/**
 * Style dimensions reviewed by Control (original-style consistency).
 * Not Beat coverage / length / dialogue-ratio hard metrics.
 */
export type ContinuationStyleDimension =
  | 'narrative_voice'
  | 'pov'
  | 'sentence_rhythm'
  | 'dialogue_voice'
  | 'emotional_expression'
  | 'description_density'
  | 'subtext'
  | 'scene_transition'
  | 'ai_template'
  | 'padding';

/**
 * Actionable or audit-only original-style finding from Control.
 * Only repairReady=true items may enter the single Repair request.
 */
export interface ContinuationStyleIssue {
  findingId: string;
  styleDimension: ContinuationStyleDimension;
  severity: 'warning' | 'error';
  confidence: number;
  generatedStart: number | null;
  generatedEnd: number | null;
  generatedExcerpt: string;
  description: string;
  styleEvidenceIds: string[];
  rewriteGoal: string;
  preserveMeaning: string[];
  repairReady: boolean;
}

/** Advisory/actionable finding used by Repair audit ids (findingId). */
export interface ContinuationControlFinding {
  findingId: string;
  subtype: string;
  severity: ContinuationControlFindingSeverity;
  location: string;
  generatedStart: number | null;
  generatedEnd: number | null;
  description: string;
  suggestedFix: string;
  /** When true, Repair must rewrite the targeted span and echo findingId. */
  repairReady?: boolean;
  rewriteGoal?: string;
  preserveMeaning?: string[];
  styleEvidenceIds?: string[];
  styleDimension?: ContinuationStyleDimension;
}

/**
 * Control report after creative loosening:
 * - numeric length fields remain for UI soft hints only
 * - action/suggestions no longer drive Repair eligibility
 * - styleIssues (repairReady) + styleWarnings (audit) are the new contract
 * - findings mirrors repairReady style issues for appliedControlFindingIds
 */
export interface ContinuationControlReport {
  schemaVersion: 1 | 2;
  /** Diagnostic length direction only; never a Repair hard requirement. */
  action: ContinuationControlAction;
  currentHan: number;
  targetHan: number;
  allowedMinHan: number;
  allowedMaxHan: number;
  /** Legacy field; V4 style-control leaves this empty (no expand/compress force). */
  suggestions: ContinuationControlSuggestion[];
  /** repairReady style issues projected for Repair audit. */
  findings: ContinuationControlFinding[];
  preserve: string[];
  /** Full style review set (actionable + already-filtered audit). */
  styleIssues?: ContinuationStyleIssue[];
  /** Explicit audit-only style observations (no Repair). */
  styleWarnings?: ContinuationStyleIssue[];
  styleProfileRevision?: number | null;
  writerArtifactHash?: string | null;
  metricEchoMismatch?: boolean;
  /** Legacy diagnostic; length-action echo is no longer authoritative. */
  actionEchoMismatch?: boolean;
}

export interface ContinuationV4WriterEnvelope {
  schemaVersion: 1;
  plan: {
    chapterGoal: string;
    centralConflict: string;
    beats: Array<{ id: string; summary: string }>;
  };
  content: string;
}

export interface ContinuationV4RepairEnvelope {
  schemaVersion: 1;
  content: string;
  appliedCheckerIssueIds: string[];
  appliedControlSuggestionIds: string[];
  /** Optional for backward compatibility with historical Repair envelopes. */
  appliedControlFindingIds?: string[];
  unappliedItems: string[];
}

export interface ContinuationContextSnapshot {
  schemaVersion: 1 | 2;
  /** New standard workflow marker; absent on historical snapshots. */
  workflowVersion?: 2 | 4;
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

/**
 * V4 snapshot. It is deliberately a separate type so historical V1/V2
 * callers can keep consuming the legacy stageBudgets shape without guessing
 * whether `stageBudgets` contains a V4 resolver result.
 */
export interface ContinuationContextSnapshotV3
  extends Omit<
    ContinuationContextSnapshot,
    'schemaVersion' | 'workflowVersion' | 'stageBudgets'
  > {
  schemaVersion: 3;
  workflowVersion: 4;
  budgetPolicy: FrozenContinuationBudgetPolicy;
  stageBudgets: ContinuationV4StageBudgets;
  stageViews: ContinuationV4StageViews;
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
  v4StageBudgets?: ContinuationV4StageBudgets;
  v4StageViewHashes?: Partial<Record<ContinuationV4ContextStage, string>>;
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
  workflowVersion?: 2 | 4;
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
  /** Explicit adoption semantics added in Schema 32; absent on old in-memory
   * fixtures/readers until the row is reloaded from the current database. */
  eligibilityStatus?: ContinuationArtifactEligibility;
  rejectionCode?: string | null;
  createdAt: string;
}

export interface ContinuationGenerationStageResult {
  id: string;
  runId: string;
  stage: ContinuationV4StageName;
  status: ContinuationStageResultStatus;
  requestReserved: boolean;
  requestCount: number;
  modelConfigId: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  minOutputTokens: number | null;
  maxOutputTokens: number | null;
  /** Structured reports only; never a prompt, credential, URL or reasoning. */
  outputJson: string | null;
  artifactId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
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
