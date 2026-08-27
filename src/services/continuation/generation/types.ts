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
import type { ContinuationStageBudgets } from '../../writing/scenario/continuationStageCapacity';
import type { ContinuationV4StageBudget } from './continuationV4Budget';
import type { StyleRenderLevel } from '../styleProfile/styleProfileRenderer';
import type { OriginalStyleProfileV2 } from '../styleProfile/styleProfileV2Schema';
import type { WritingSourceTrace } from '../../writing/contracts/writingSource';
import type {
  FrozenWritingContext,
  WritingKernelTrace,
} from '../../writing/contracts/frozenWritingContext';

export type ContinuationStageName =
  | 'context'
  | 'planner'
  | 'writer'
  | 'checker'
  | 'auditing'
  | 'repair'
  | 'local_verify'
  | 'awaiting_user'
  | 'draft_writer'
  | 'narrative_architect'
  | 'revision_writer'
  | 'adversarial_auditor'
  | 'final_reviser'
  | 'final_validate'
  | 'round1'
  | 'round2'
  | 'round3'
  | 'round4';

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

/** V5 physical LLM nodes (each reserves at most one request). */
export type ContinuationV5PhysicalNode =
  | 'draft_writer'
  | 'narrative_architect'
  | 'revision_writer'
  | 'adversarial_auditor'
  // Phase 4 (二 §7.2): the unified qa node replaces the legacy trio
  // (narrative_architect + adversarial_auditor + any historical fact_check).
  | 'unified_qa'
  | 'final_reviser';

/** V5 zero-request local node. */
export type ContinuationV5LocalNode = 'final_validate';

export type ContinuationV5Node =
  | ContinuationV5PhysicalNode
  | ContinuationV5LocalNode;

/** Stage-result ledger stage names across V4 and V5. */
export type ContinuationStageResultStageName =
  | ContinuationV4StageName
  | ContinuationV5Node;

export type ContinuationV5ContextStage = ContinuationV5PhysicalNode;

export const CONTINUATION_V5_ROUNDS = {
  round1: ['draft_writer', 'narrative_architect'],
  // C2 must review the actual V2, so the final three nodes are deliberately
  // serial. This preserves the five-request budget while making V3's edit
  // instructions grounded in the prose it is about to revise.
  round2: ['revision_writer'],
  round3: ['adversarial_auditor'],
  round4: ['final_reviser'],
} as const;

/**
 * Phase 4 (二 §7.2): compact Standard V5 round map. Round1 = draft only,
 * Round2 = unified QA + revision_writer (replaces the legacy review +
 * audit/factCheck + revision split). Proof is removed from the compact DAG
 * (Phase 3 §6), so round3 collapses to nothing.
 */
export const CONTINUATION_V5_COMPACT_ROUNDS = {
  round1: ['draft_writer'],
  round2: ['unified_qa', 'revision_writer'],
  round3: [],
} as const;

export const CONTINUATION_V5_MAX_PHYSICAL_REQUESTS = 5;

export type ContinuationStageResultStatus =
  | 'queued'
  | 'running'
  | 'success'
  | 'failed'
  | 'interrupted'
  | 'skipped';

export type ContinuationArtifactEligibility =
  | 'eligible'
  | 'rejected'
  | 'intermediate';

export type ContinuationArtifactStage =
  | 'writer'
  | 'repair'
  | 'user_edit'
  | 'draft'
  | 'revision_1'
  | 'final';

export type ContinuationRunState =
  | 'queued'
  | 'running'
  | 'awaiting_user'
  | 'awaiting_regeneration'
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

/**
 * Canonical subject reference values accepted by the durable proposal
 * schema. Canon views call a canon plot thread `plot_thread`; proposals use
 * the existing `plotline` reference vocabulary so they can be committed into
 * the ONE Continuity State event pipeline without a schema-invalid write.
 */
export const CONTINUATION_PROPOSAL_SUBJECT_REF_TYPES = [
  'canon_character',
  'continuation_entity',
  'plotline',
  'world',
] as const;

export type ContinuationProposalSubjectRefType =
  (typeof CONTINUATION_PROPOSAL_SUBJECT_REF_TYPES)[number];

/**
 * Normalize the only known model/context spelling alias and reject every
 * other non-empty value. Keeping this at the domain boundary prevents
 * SQLite's INSERT OR IGNORE from silently dropping an authoritative proposal
 * because it violates the subject_ref_type CHECK constraint.
 */
export function normalizeContinuationProposalSubjectRefType(
  value: unknown,
): ContinuationProposalSubjectRefType | null {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const canonical = text === 'plot_thread' ? 'plotline' : text;
  return (CONTINUATION_PROPOSAL_SUBJECT_REF_TYPES as readonly string[]).includes(
    canonical,
  )
    ? (canonical as ContinuationProposalSubjectRefType)
    : null;
}

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
  workflowVersion?: 2 | 4 | 5;
  values: ContinuationGenerationSettings;
  resolvedModelConfigIds: {
    planner: number;
    writer: number;
    checker: number | null;
    repair: number | null;
    stateExtraction: number;
    control?: number | null;
    /** V5 frozen routing aliases (no new settings columns in v1). */
    draftWriter?: number;
    narrativeArchitect?: number;
    revisionWriter?: number;
    adversarialAuditor?: number;
    finalReviser?: number;
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
    draftWriter?: FrozenContinuationModelConfig | null;
    narrativeArchitect?: FrozenContinuationModelConfig | null;
    revisionWriter?: FrozenContinuationModelConfig | null;
    adversarialAuditor?: FrozenContinuationModelConfig | null;
    finalReviser?: FrozenContinuationModelConfig | null;
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
  providerAdapterId?: string | null;
  allowInsecureLanHttp?: boolean;
  thinking?: { type: 'enabled' | 'disabled' };
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max';
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

/** V5 length policy: prompt/budget/warning only — never eligibility. */
export interface ContinuationV5LengthPolicy {
  preferredMinRatio: number;
  preferredMaxRatio: number;
  severeUnderRatio: number;
  outputHeadroomRatio: number;
}

export interface ContinuationV5StageBudget {
  stage: ContinuationV5PhysicalNode;
  configId: number;
  contextWindow: number;
  effectiveWindow: number;
  declaredMaxOutputTokens: number;
  /** Provider-adapted value available on the `max_tokens` wire field. */
  wireMaxOutputTokens?: number;
  compiledPromptTokens: number;
  protocolSkeletonTokens: number;
  promptReserveTokens: number;
  safetyReserveTokens: number;
  hardContextTokens: number;
  inputBudget: number;
  availableOutputTokens: number;
  demandTokens: number;
  minimumOutputTokens: number;
  maximumOutputTokens: number;
  targetChapterChars: number;
  pressure: number;
  blockedReason: string | null;
}

export type ContinuationV5StageBudgets = Record<
  ContinuationV5PhysicalNode,
  ContinuationV5StageBudget
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
  duplicateWindows: ContinuationDuplicateWindow[];
  beatCoverage: Array<{ beatId: string; paragraphIds: string[] }>;
  insertionBoundaries: number[];
}

export interface ContinuationDuplicateOccurrence {
  start: number;
  end: number;
  paragraphId: string;
}

/**
 * `start`/`end`/`count` remain for old consumers. `occurrences` is the
 * authoritative precise representation and never spans the normal text
 * between two duplicate paragraphs.
 */
export interface ContinuationDuplicateWindow {
  start: number;
  end: number;
  count: number;
  occurrences: ContinuationDuplicateOccurrence[];
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
  bindingStatus?: ContinuationStyleIssueBindingStatus;
}

export type ContinuationStyleIssueBindingStatus =
  | 'bound_by_range'
  | 'bound_by_unique_excerpt'
  | 'range_excerpt_mismatch'
  | 'excerpt_not_found'
  | 'excerpt_not_unique'
  | 'invalid_location';

/** Advisory/actionable finding used by Repair audit ids (findingId). */
export interface ContinuationControlFinding {
  findingId: string;
  subtype: string;
  severity: ContinuationControlFindingSeverity;
  location: string;
  generatedStart: number | null;
  generatedEnd: number | null;
  /** Hit span from Writer artifact (UTF-16 slice or model-provided excerpt). */
  generatedExcerpt?: string;
  /** Real model confidence; missing values are audit-only on compatibility paths. */
  confidence?: number;
  description: string;
  suggestedFix: string;
  /** When true, Repair must rewrite the targeted span and echo findingId. */
  repairReady?: boolean;
  rewriteGoal?: string;
  preserveMeaning?: string[];
  styleEvidenceIds?: string[];
  styleDimension?: ContinuationStyleDimension;
  bindingStatus?: ContinuationStyleIssueBindingStatus;
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
  styleProfileHash?: string | null;
  styleRendererVersion?: string | null;
  echoedWriterArtifactHash?: string | null;
  echoedStyleProfileHash?: string | null;
  echoedStyleRendererVersion?: string | null;
  controlBindingErrorCodes?: string[];
  legacyFindingDowngradeCount?: number;
  telemetryEvents?: string[];
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

// ── Continuation V5 envelopes ───────────────────────────────────────────

export interface ContinuationV5DraftEnvelope {
  schemaVersion: 1;
  plan: {
    chapterGoal: string;
    centralConflict: string;
    beats: Array<{
      id: string;
      summary: string;
      stateChange: string;
    }>;
  };
  content: string;
}

export interface ContinuationV5SceneUnit {
  sceneId: string;
  entryState: string;
  characterAction: string;
  resistance: string;
  turningPoint: string;
  consequence: string;
  relationshipChange: string | null;
  informationChange: string | null;
  riskChange: string | null;
  canonEvidenceIds: number[];
  requiredContinuity: string[];
  forbiddenInventions: string[];
}

export interface ContinuationV5ArchitectureEnvelope {
  schemaVersion: 1;
  chapterGoal: string;
  centralConflict: string;
  sceneUnits: ContinuationV5SceneUnit[];
  endingState: string;
  forbiddenPaddingPatterns: string[];
}

export interface ContinuationV5RevisionEnvelope {
  schemaVersion: 1;
  draftArtifactHash: string;
  architectureHash: string;
  content: string;
  usedArchitectSceneIds: string[];
  omittedArchitectSceneIds: string[];
  declaredNewCoreFacts: string[];
}

export type ContinuationV5CanonAuditCategory =
  | 'character'
  | 'world'
  | 'relationship'
  | 'plot'
  | 'experience'
  | 'knowledge'
  | 'timeline'
  | 'boundary'
  | 'locked_rule';

export type ContinuationV5StyleDimension =
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

export type ContinuationV5RejectedSceneReason =
  | 'canon_conflict'
  | 'future_leakage'
  | 'knowledge_conflict'
  | 'relationship_conflict'
  | 'style_drift'
  | 'padding_risk'
  | 'duplicate_function'
  | 'unsupported_core_fact';

/**
 * A client-derived, immutable slice of the actual V2 artifact. C2 chooses
 * these ids rather than generating approximate quotations from memory.
 */
export interface ContinuationV5RevisionAnchor {
  anchorId: string;
  start: number;
  end: number;
  text: string;
}

export interface ContinuationV5AuditEnvelope {
  schemaVersion: 1;
  /** V1 provenance retained for the Draft → V2 → C2 audit trail. */
  draftArtifactHash: string;
  /** The actual V2 text reviewed by C2 and supplied to Final Reviser. */
  revisionArtifactHash: string;
  architectureHash: string;
  canonSnapshotId: string;
  canonRevision: number;
  inputRevisionHash: string;
  styleProfileHash: string | null;
  styleRendererVersion: string | null;
  canonAudit: {
    requiredCorrections: Array<{
      requirementId: string;
      category: ContinuationV5CanonAuditCategory;
      severity: 'warning' | 'error' | 'blocking';
      confidence: number;
      generatedStart: number | null;
      generatedEnd: number | null;
      generatedExcerpt: string;
      description: string;
      evidenceIds: number[];
      requiredOutcome: string;
      forbiddenChanges: string[];
    }>;
    protectedFacts: string[];
    forbiddenFacts: string[];
  };
  styleAudit: {
    requiredCorrections: Array<{
      requirementId: string;
      /** Stable V2 segment selected by C2; null only for legacy contracts. */
      anchorId: string | null;
      dimension: ContinuationV5StyleDimension;
      severity: 'warning' | 'error';
      confidence: number;
      generatedStart: number | null;
      generatedEnd: number | null;
      generatedExcerpt: string;
      description: string;
      styleEvidenceIds: string[];
      rewriteGoal: string;
      preserveMeaning: string[];
    }>;
    protectedPassages: Array<{
      passageId: string;
      generatedStart: number;
      generatedEnd: number;
      generatedExcerpt: string;
      reason: string;
    }>;
    forbiddenExpansionPatterns: string[];
  };
  architectureAudit: {
    safeSceneIds: string[];
    rejectedScenes: Array<{
      sceneId: string;
      reasonCode: ContinuationV5RejectedSceneReason;
      description: string;
      evidenceIds: number[];
    }>;
  };
  finalObligations: Array<{
    obligationId: string;
    source: 'canon' | 'style' | 'architecture' | 'user_rule';
    priority: number;
    description: string;
    requiredOutcome: string;
    forbiddenChanges: string[];
  }>;
}

export interface ContinuationV5FinalEnvelope {
  schemaVersion: 1;
  revisionArtifactHash: string;
  architectureHash: string;
  auditContractHash: string;
  content: string;
  appliedObligationIds: string[];
  appliedCanonRequirementIds: string[];
  appliedStyleRequirementIds: string[];
  usedArchitectSceneIds: string[];
  restoredProtectedPassageIds: string[];
  declaredNewCoreFacts: string[];
  unappliedItems: string[];
  /** Explicit proof for requirements already satisfied before V3. */
  validNoOpRequirementIds?: string[];
  validNoOpReasons?: Record<string, string>;
}

/** Shared frozen context slice for V5 full-text nodes. */
export interface FrozenContinuationV5BaseContextView {
  projectId: number;
  targetChapterId: number;
  targetPosition: ContinuationChapterPosition;
  targetChapterChars: number;
  preferredMinHan: number;
  preferredMaxHan: number;
  severeUnderHan: number;
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
  primaryAnchorSummary: string;
  /**
   * Compact previous-chapter seam injected into every full-text V5 stage so
   * revision/audit/polish can verify and preserve chapter-to-chapter linkage.
   * Carries the real anchor summary plus its token-budgeted excerpt tail
   * (empty only when no anchor exists). Distinct from primaryAnchorSummary,
   * which is a legacy label field that the context builder empties for
   * continuation-chapter anchors.
   */
  primaryAnchorSeamText: string;
  recentBridgeSummary: string;
  style: FrozenContinuationStyleStageView;
  supplements: FrozenContinuationSupplementStageView;
  budget: ContinuationV5StageBudget;
  snapshotRefs: {
    canonSnapshotId: string;
    canonRevision: number;
    inputRevisionHash: string;
    styleProfileHash: string | null;
    styleRendererVersion: string | null;
  };
}

export interface FrozenContinuationV5DraftWriterView
  extends FrozenContinuationV5BaseContextView {
  stage: 'draft_writer';
  primaryAnchor: ContinuationContextSnapshot['primaryAnchor'];
  recentChapters: ContinuationContextBundles['recentChapters'];
  storyMemory: ContinuationContextBundles['storyMemory'];
  episodic: ContinuationContextBundles['episodic'];
  historicalDigests: HistoricalDigest[];
  fullCanon: CanonContextBundle;
}

export interface FrozenContinuationV5ArchitectView
  extends FrozenContinuationV5BaseContextView {
  stage: 'narrative_architect';
  fullCanon: CanonContextBundle;
}

export interface FrozenContinuationV5RevisionWriterView
  extends FrozenContinuationV5BaseContextView {
  stage: 'revision_writer';
}

export interface FrozenContinuationV5AuditorView
  extends FrozenContinuationV5BaseContextView {
  stage: 'adversarial_auditor';
}

export interface FrozenContinuationV5FinalReviserView
  extends FrozenContinuationV5BaseContextView {
  stage: 'final_reviser';
}

export interface ContinuationV5StageViews {
  draft_writer: FrozenContinuationV5DraftWriterView;
  narrative_architect: FrozenContinuationV5ArchitectView;
  revision_writer: FrozenContinuationV5RevisionWriterView;
  adversarial_auditor: FrozenContinuationV5AuditorView;
  final_reviser: FrozenContinuationV5FinalReviserView;
}

/** Phase II observability adapter event names. The execution protocol keeps
 * its existing state machine; these names describe what happened to the
 * durable run without changing that protocol. */
export type ContinuationGenerationTraceEventName =
  | 'queued'
  | 'running'
  | 'awaiting_user'
  | 'awaiting_regeneration'
  | 'interrupted'
  | 'resume'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'outdated';

export interface ContinuationGenerationTraceEvent {
  sequence: number;
  event: ContinuationGenerationTraceEventName;
  state: ContinuationRunState;
  stage: ContinuationStageName | null;
  at: string;
  reason: string | null;
}

export interface ContinuationGenerationTraceV2 {
  schemaVersion: 2;
  generationTraceId: string;
  batchTraceId: string | null;
  lineage: {
    batchTraceId: string | null;
    chapterOrdinal: number | null;
    chapterCount: number | null;
    chapterFingerprint: string;
  };
  sourceSnapshot: {
    sourceId: number;
    sourceVersion: number;
    normalizedSha256: string;
    parserVersion: string;
    normalizationVersion: string;
    boundaryChapterId: number | null;
    boundaryPosition: number | null;
    boundaryCharOffsetExclusive: number | null;
  };
  canon: {
    snapshotId: string;
    revision: number;
  };
  tail: {
    kind: 'source_seam' | 'continuation_chapter' | 'legacy';
    chapterId: number | null;
    position: ContinuationChapterPosition | null;
    storyMemoryThroughPosition: ContinuationChapterPosition | -1;
    storyMemoryFingerprint: string;
  };
  currentInstruction: {
    sha256: string;
    charCount: number;
  };
  budget: {
    modelContextLimit: number | null;
    inputBudget: number | null;
    effectiveInputBudget: number | null;
    reservedOutputTokens: number;
    requestedMaxTokens: number | null;
    effectiveWindow: number | null;
    pressure: number | null;
  };
  llmRequestIdentity: {
    stageConfigIds: Record<string, number | null>;
    stageModelNames: Record<string, string | null>;
    secretsExcluded: true;
  };
  eligibility: {
    status: 'unknown' | 'eligible' | 'rejected' | 'intermediate';
    rejectionCode: string | null;
  };
  adoption: {
    status: 'not_attempted' | 'pending' | 'adopted' | 'abandoned' | 'conflict';
    adoptedRevisionHash: string | null;
  };
  finalization: {
    status: 'not_started' | 'pending' | 'finalized' | 'failed';
    finalizedRevisionHash: string | null;
    completionReason: 'adopted' | 'abandoned' | null;
  };
  stateGate: {
    currentState: ContinuationRunState;
    lastEvent: ContinuationGenerationTraceEventName;
  };
  events: ContinuationGenerationTraceEvent[];
}

export interface ContinuationContextSnapshot {
  schemaVersion: 1 | 2;
  /** New standard workflow marker; absent on historical snapshots. */
  workflowVersion?: 2 | 4 | 5;
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
  /** Phase II unified trace identity, persisted for resume stability. */
  generationTraceId?: string;
  settingsSnapshot: ContinuationGenerationSettingsSnapshot;
  bundles: ContinuationContextBundles;
  createdAt: string;
  /** Phase I: unified pre-kernel source trace. */
  writingSourceTrace?: WritingSourceTrace;
  writingKernelTrace?: WritingKernelTrace;
  /** Kernel Final Closure: the immutable post-Freeze input contract. */
  frozenWritingContext?: FrozenWritingContext;
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

/**
 * V5 snapshot. Separate from V3 so historical V4 readers never guess V5
 * stageBudgets / stageViews shapes.
 */
export interface ContinuationContextSnapshotV5
  extends Omit<
    ContinuationContextSnapshot,
    'schemaVersion' | 'workflowVersion' | 'stageBudgets'
  > {
  schemaVersion: 4;
  workflowVersion: 5;
  budgetPolicy: FrozenContinuationBudgetPolicy;
  stageBudgets: ContinuationV5StageBudgets;
  stageViews: ContinuationV5StageViews;
  lengthPolicy: ContinuationV5LengthPolicy;
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
  v5StageBudgets?: ContinuationV5StageBudgets;
  v5StageViewHashes?: Partial<Record<ContinuationV5PhysicalNode, string>>;
  /** Phase II adapter: legacy trace fields remain authoritative for old UI. */
  generationTraceId?: string;
  batchTraceId?: string | null;
  generationTrace?: ContinuationGenerationTraceV2;
  /** Phase I: normalized pre-kernel source boundary and fingerprint. */
  writingSourceTrace?: WritingSourceTrace;
  writingKernelTrace?: WritingKernelTrace;
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
  workflowVersion?: 2 | 4 | 5;
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
  stage: ContinuationArtifactStage;
  repairRound: number;
  parentArtifactId: string | null;
  content: string;
  contentHash: string;
  /** Explicit adoption semantics added in Schema 32; intermediate is V5-only
   * for non-deliverable V1/V2 drafts. */
  eligibilityStatus?: ContinuationArtifactEligibility;
  rejectionCode?: string | null;
  createdAt: string;
}

export interface ContinuationGenerationStageResult {
  id: string;
  runId: string;
  stage: ContinuationStageResultStageName;
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

export type ContinuationTruncatedStage =
  | 'writer'
  | 'checker'
  | 'control'
  | 'repair'
  | 'draft_writer'
  | 'revision_writer'
  | 'final_reviser';

/** Stable, stage-specific diagnostic for finish_reason=length. */
export class ContinuationStageOutputTruncatedError extends Error {
  readonly code: `${ContinuationTruncatedStage}_output_truncated`;
  readonly stage: ContinuationTruncatedStage;
  readonly diagnostics: Record<string, unknown>;

  constructor(
    stage: ContinuationTruncatedStage,
    diagnostics: Record<string, unknown> = {},
  ) {
    super(
      stage === 'writer' || stage === 'draft_writer'
        ? 'Writer 输出被模型最大输出限制截断，未形成完整初稿。'
        : stage === 'repair'
        ? 'Repair 输出被模型最大输出限制截断，未形成完整终稿，系统已保留 Writer 初稿。'
        : stage === 'revision_writer'
        ? 'Revision Writer 输出被模型最大输出限制截断，未形成 V2。'
        : stage === 'final_reviser'
        ? 'Final Reviser 输出被模型最大输出限制截断，未形成 V3。'
        : `${stage} 输出被模型最大输出限制截断。`,
    );
    this.name = 'ContinuationStageOutputTruncatedError';
    this.stage = stage;
    this.code = `${stage}_output_truncated`;
    this.diagnostics = diagnostics;
  }
}
