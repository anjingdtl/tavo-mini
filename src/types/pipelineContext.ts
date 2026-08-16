/**
 * Shared pipeline context snapshot (SPEC §7).
 *
 * `buildContext()` populates this once, while the draft messages are being
 * assembled. Every downstream stage (review / factCheck / proof) MUST consume
 * the snapshot fields instead of re-reading the database or re-parsing the
 * draft `messages`. This keeps all stages of one task on the same source view
 * (preset / story memory / characters / worldbook / episodic / bridge).
 *
 * The snapshot is deliberately a flat-bag of strings so it can be sliced into
 * per-stage budgets without coupling to `ChatMessage[]` ordering. Empty strings
 * are valid (e.g. a project with no characters) and MUST be filtered by the
 * message builders, not silently dropped here.
 */
import type { FrozenWriterStyleV1 } from '../services/writerStyle/types';
import type { GenerationStageTimings } from '../services/context/generationStageContracts';
import type { WritingSourceTrace } from '../services/writing/contracts/writingSource';
import type { WritingKernelTrace } from '../services/writing/contracts/frozenWritingContext';

/** Historical V3 snapshot written by Context Budget V6 tasks. */
export const PIPELINE_CONTEXT_SNAPSHOT_VERSION = 3 as const;
/** Phase-2 frozen resource contract written by Context Budget V7 tasks. */
export const PIPELINE_CONTEXT_SNAPSHOT_VERSION_V4 = 4 as const;
/** Third-phase frozen Writer Style + stage projection contract. */
export const PIPELINE_CONTEXT_SNAPSHOT_VERSION_V5 = 5 as const;

/**
 * Context Budget V3 hierarchical allocator summary embedded in the snapshot
 * (Plan §13). Carries per-board demand / soft target / allocated / borrowed so
 * the snapshot is self-describing — reviewers, factCheck and proof see the
 * SAME allocation view the draft was generated against, without re-running the
 * allocator. Optional; absent for V1/V2 snapshots.
 */
export interface ContextBudgetV3Summary {
  contextBudgetVersion: 6;
  contextAutomationPolicyVersion: 'context-automation-v3';
  policyHash: string;
  contextAutomationPolicyHash: string;
  contextAutomationPolicySnapshot: unknown;
  envelope: {
    contextWindow: number;
    reservedOutputTokens: number;
    safetyMargin: number;
    hardInputLimit: number;
    softInputLimit: number;
    burstInputLimit: number;
    mandatoryTokens: number;
    softElasticPool: number;
    burstElasticPool: number;
  };
  boards: {
    key: 'storyState' | 'resources' | 'slidingWindow' | 'episodic';
    actualDemandTokens: number;
    softTargetTokens: number;
    elasticMaxTokens: number;
    allocatedTokens: number;
    reclaimedTokens: number;
    borrowedTokens: number;
    reason: string;
  }[];
}

export interface ContextBudgetV7Summary {
  contextBudgetVersion: 7;
  resourceContextVersion: 2;
  contextAutomationPolicyVersion: 'context-automation-v3';
  policyHash: string;
  contextAutomationPolicyHash: string;
  contextAutomationPolicySnapshot: unknown;
  protectedAwarenessTokens: number;
  resourceDetailDemandTokens: number;
  resourceDetailAllocatedTokens: number;
  envelope: ContextBudgetV3Summary['envelope'];
  boards: ContextBudgetV3Summary['boards'];
}

export interface FrozenResourceAwarenessItem {
  id: string;
  sourceKind: 'character' | 'worldbook';
  sourceId: number;
  title: string;
  content: string;
  sourceFingerprint: string;
  compilerVersion: string;
  constraintClasses: string[];
  fallbackMode?: string;
  estimatedTokens?: number;
  legacyCharacterFallback?: boolean;
}

export interface FrozenResourceDetailItem {
  id: string;
  sourceKind: 'character' | 'worldbook' | 'note';
  sourceId: number | null;
  title: string;
  content: string;
  actualTokens: number;
  allocatedTokens: number;
  activationReason: string;
  sourceFingerprint?: string;
  clipped?: boolean;
}

export interface PipelineContextSnapshot {
  /** Macro-replaced system prompt, writing style and extra instructions. */
  presetText: string;
  /** Story Memory renderer output actually injected to the draft. */
  storyMemoryText: string;

  /** Character cards actually injected to the draft. */
  characterText: string;
  /** Project notes actually injected to the draft. */
  noteText: string;
  /** Activated worldbook entries actually injected to the draft. */
  worldbookText: string;

  /** Episodic memory hits (chapter summaries) injected to the draft. */
  episodicMemoryText: string;
  /** Pending Bridge / Seam / sliding-window recent body text. */
  recentBridgeText: string;
  /** The immediately preceding chapter, frozen independently of the bridge. */
  immediatePreviousChapterText?: string;
  immediatePreviousChapterEnding?: string;
  immediatePreviousChapterId?: number;
  immediatePreviousChapterPosition?: number;
  /** Current chapter title + synopsis instruction block. */
  currentInstructionText: string;

  /** The user's writing instruction for this run (retrieval prompt). */
  retrievalUserPrompt: string;

  /**
   * Project outline text (future plot plan) injected as the highest creative
   * constraint. Empty for non-outline modes / no enabled outlines. Frozen once
   * at buildContext time so every stage of one task sees the same plan.
   */
  outlineText: string;
  /** Stable fingerprint of the frozen outlines (contract + stitched text). */
  outlineFingerprint: string;
  /** Ids of the outlines actually injected, in stitch order. */
  outlineIds: number[];
  /** Whether the full outline text fit the budget (false → pipeline blocked). */
  outlineComplete: boolean;
  /** Human-readable reason when the outline could not be fully injected. */
  outlineBlockingReason?: string;
  /** Token estimate of the frozen outline text. */
  outlineEstimatedTokens: number;

  /**
   * Optional fingerprint for debugging cross-stage source consistency.
   * Not consumed by prompts; only logged at dev level.
   */
  sourceFingerprint?: string;

  /** Persisted snapshot metadata (Schema 38+). */
  projectId?: number;
  chapterId?: number;
  chapterUpdatedAt?: string | number;
  createdAt?: number;
  snapshotVersion?: 1 | 3 | 4 | 5;
  resourceContextVersion?: 1 | 2;
  characterAwarenessText?: string;
  worldbookAwarenessText?: string;
  globalResourceAwarenessText?: string;
  resourceAwarenessItems?: FrozenResourceAwarenessItem[];
  resourceDetailItems?: FrozenResourceDetailItem[];
  resourceSelectionTrace?: Array<Record<string, unknown> | {
    id: string;
    sourceId?: number | null;
    title: string;
    status?: string;
    mode?: string;
    included?: boolean;
    warning?: string;
    warningCode?: string;
    warningAction?: 'open_resources' | 'retry' | 'none';
  }>;
  presetSystemText?: string;
  presetWritingStyleText?: string;
  presetExtraInstructionsText?: string;
  presetSourceFingerprint?: string;
  presetSource?: 'user_selected' | 'default_runtime_baseline';
  includeResources?: boolean;
  resourcesDisabledWarning?: string;
  /** V5-only: task-start frozen Writer Style and all stage projections. */
  writerStyleSnapshot?: FrozenWriterStyleV1;
  contextBudgetV7Summary?: ContextBudgetV7Summary;
  /**
   * Context Budget V3 hierarchical allocator summary (Plan §13). Present only
   * when the task was frozen with context_budget_version >= 6. Downstream
   * stages use this to render the same allocation view in their prompts.
   */
  contextBudgetV3Summary?: ContextBudgetV3Summary;
  /**
   * Stability Phase 5 — structured diagnostics for semantic degradations
   * that occurred while building this context (plan §9). Frozen with the
   * snapshot so resume / replay / preview can explain WHY something was
   * degraded. Absent on historical snapshots.
   */
  stabilityDiagnostics?: import('./generationTrace').GenerationDiagnostic[];
  /** Phase II stage spans consumed by Generation Trace V2. */
  stageTimings?: GenerationStageTimings;
  /** Phase II decision-level Candidate/Allocation/Render contract. */
  generationContract?: import('../services/context/generation/generationContracts').FrozenGenerationContextContractV2;
  /** Phase I: normalized pre-kernel source boundary and fingerprint. */
  writingSourceTrace?: WritingSourceTrace;
  writingKernelTrace?: WritingKernelTrace;
  /** Kernel Final Closure: the authoritative frozen context object bound to
   * writingKernelTrace. Loaded by the Writing Kernel engine on resume; never
   * rebuilt from live data once present. */
  frozenWritingContext?: import('../services/writing/contracts/frozenWritingContext').FrozenWritingContext;
}

/**
 * Context consumed by the literary review. It includes every source injected
 * into the draft, so reviews cannot misclassify an enabled rule or style note
 * as a contradiction merely because it was omitted from their prompt.
 */
export interface ReviewContext {
  presetText: string;
  characterText: string;
  noteText: string;
  worldbookText: string;
  characterAwarenessText?: string;
  worldbookAwarenessText?: string;
  storyMemoryText: string;
  episodicMemoryText: string;
  recentBridgeText: string;
  currentInstructionText: string;
  retrievalUserPrompt: string;
  /** Project outline plan (future direction); empty when not applicable. */
  outlineText: string;
  immediatePreviousChapterText?: string;
  immediatePreviousChapterEnding?: string;
  /** V5 Protected Writer Style metadata; never enters elastic clipping. */
  writerStyleProtectedTokens?: number;
  writerStyleProjectionMode?: 'FULL' | 'EVALUATION' | 'HARD' | 'MINIMAL';
}

/**
 * Context consumed by the fact-check stage. Explicit writing-preset rules may
 * themselves be constraints, so the preset is part of its source snapshot.
 */
export interface FactCheckContext {
  presetText: string;
  characterAwarenessText?: string;
  worldbookAwarenessText?: string;
  currentInstructionText: string;
  retrievalUserPrompt: string;
  recentBridgeText: string;
  storyMemoryText: string;
  episodicMemoryText: string;
  worldbookText: string;
  characterText: string;
  noteText: string;
  /**
   * Project outline plan treated as FUTURE planning only — never as already-
   * happened facts. The fact-check prompt must keep this strictly separated
   * from story memory / recent body.
   */
  outlineText: string;
  immediatePreviousChapterText?: string;
  immediatePreviousChapterEnding?: string;
  writerStyleProtectedTokens?: number;
  writerStyleProjectionMode?: 'FULL' | 'EVALUATION' | 'HARD' | 'MINIMAL';
}

/**
 * Hard constraints handed to the proof stage. The proof keeps every source
 * used by the draft so targeted edits preserve facts and style references.
 */
export interface ProofConstraints {
  presetText: string;
  characterAwarenessText?: string;
  worldbookAwarenessText?: string;
  currentInstructionText: string;
  retrievalUserPrompt: string;
  relevantCharacterConstraints: string;
  relevantWorldRules: string;
  currentStoryState: string;
  episodicMemoryText: string;
  noteText: string;
  recentBridgeText: string;
  /** Project outline plan the proof must protect (preserve correct beats). */
  outlineText: string;
  immediatePreviousChapterText?: string;
  immediatePreviousChapterEnding?: string;
  writerStyleProtectedTokens?: number;
  writerStyleProjectionMode?: 'FULL' | 'EVALUATION' | 'HARD' | 'MINIMAL';
}

export function buildReviewContextFromSnapshot(
  snapshot: PipelineContextSnapshot,
): ReviewContext {
  return {
    presetText: snapshot.presetText,
    characterText: snapshot.characterText,
    noteText: snapshot.noteText,
    worldbookText: snapshot.worldbookText,
    characterAwarenessText: snapshot.characterAwarenessText || '',
    worldbookAwarenessText: snapshot.worldbookAwarenessText || '',
    storyMemoryText: snapshot.storyMemoryText,
    episodicMemoryText: snapshot.episodicMemoryText,
    recentBridgeText: snapshot.recentBridgeText,
    currentInstructionText: snapshot.currentInstructionText,
    retrievalUserPrompt: snapshot.retrievalUserPrompt,
  outlineText: snapshot.outlineText,
    immediatePreviousChapterText: snapshot.immediatePreviousChapterText || '',
    immediatePreviousChapterEnding: snapshot.immediatePreviousChapterEnding || '',
  };
}

export function buildFactCheckContextFromSnapshot(
  snapshot: PipelineContextSnapshot,
): FactCheckContext {
  return {
    presetText: snapshot.presetText,
    currentInstructionText: snapshot.currentInstructionText,
    retrievalUserPrompt: snapshot.retrievalUserPrompt,
    recentBridgeText: snapshot.recentBridgeText,
    storyMemoryText: snapshot.storyMemoryText,
    episodicMemoryText: snapshot.episodicMemoryText,
    worldbookText: snapshot.worldbookText,
    characterText: snapshot.characterText,
    characterAwarenessText: snapshot.characterAwarenessText || '',
    worldbookAwarenessText: snapshot.worldbookAwarenessText || '',
    noteText: snapshot.noteText,
    outlineText: snapshot.outlineText,
    immediatePreviousChapterText: snapshot.immediatePreviousChapterText || '',
    immediatePreviousChapterEnding: snapshot.immediatePreviousChapterEnding || '',
  };
}

export function buildProofConstraintsFromSnapshot(
  snapshot: PipelineContextSnapshot,
): ProofConstraints {
  return {
    presetText: snapshot.presetText,
    currentInstructionText: snapshot.currentInstructionText,
    retrievalUserPrompt: snapshot.retrievalUserPrompt,
    characterAwarenessText: snapshot.characterAwarenessText || '',
    worldbookAwarenessText: snapshot.worldbookAwarenessText || '',
    // Characters + worldbook + Story Memory carry the hard "must not violate"
    // facts the proof needs to respect while applying the audit fixes.
    relevantCharacterConstraints: snapshot.characterText,
    relevantWorldRules: snapshot.worldbookText,
    currentStoryState: snapshot.storyMemoryText,
    episodicMemoryText: snapshot.episodicMemoryText,
    noteText: snapshot.noteText,
    recentBridgeText: snapshot.recentBridgeText,
    outlineText: snapshot.outlineText,
    immediatePreviousChapterText: snapshot.immediatePreviousChapterText || '',
    immediatePreviousChapterEnding: snapshot.immediatePreviousChapterEnding || '',
  };
}

export interface FinalContinuityCapsule {
  fullOutlineText: string;
  immediatePreviousChapterText: string;
  immediatePreviousEnding: string;
  recentBridgeText: string;
  storyMemoryText: string;
  episodicMemoryText: string;
  relevantCharacterText: string;
  relevantWorldRules: string;
  noteText: string;
  currentInstructionText: string;
  retrievalUserPrompt: string;
  presetText: string;
  /** V5-only: Writer Style is a mandatory protected input, never elastic. */
  writerStyleProtectedTokens?: number;
  writerStyleProjectionMode?: 'FULL' | 'EVALUATION' | 'HARD' | 'MINIMAL';
}

export function buildFinalContinuityCapsule(
  snapshot: PipelineContextSnapshot,
): FinalContinuityCapsule {
  return {
    fullOutlineText: snapshot.outlineText,
    immediatePreviousChapterText: snapshot.immediatePreviousChapterText || '',
    immediatePreviousEnding: snapshot.immediatePreviousChapterEnding || '',
    recentBridgeText: snapshot.recentBridgeText,
    storyMemoryText: snapshot.storyMemoryText,
    episodicMemoryText: snapshot.episodicMemoryText,
    relevantCharacterText: snapshot.characterText,
    relevantWorldRules: snapshot.worldbookText,
    noteText: snapshot.noteText,
    currentInstructionText: snapshot.currentInstructionText,
    retrievalUserPrompt: snapshot.retrievalUserPrompt,
    presetText: snapshot.presetText,
    ...(snapshot.writerStyleSnapshot
      ? {
          writerStyleProtectedTokens:
            snapshot.writerStyleSnapshot.stageProjections.proof.estimatedTokens,
          writerStyleProjectionMode:
            snapshot.writerStyleSnapshot.stageProjections.proof.mode,
        }
      : {}),
  };
}
