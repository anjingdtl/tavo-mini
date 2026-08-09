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
/** Current persisted pipeline context snapshot schema version. */
export const PIPELINE_CONTEXT_SNAPSHOT_VERSION = 3 as const;

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
  snapshotVersion?: 1 | 3;
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
  storyMemoryText: string;
  episodicMemoryText: string;
  recentBridgeText: string;
  currentInstructionText: string;
  retrievalUserPrompt: string;
  /** Project outline plan (future direction); empty when not applicable. */
  outlineText: string;
  immediatePreviousChapterText?: string;
  immediatePreviousChapterEnding?: string;
}

/**
 * Context consumed by the fact-check stage. Explicit writing-preset rules may
 * themselves be constraints, so the preset is part of its source snapshot.
 */
export interface FactCheckContext {
  presetText: string;
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
}

/**
 * Hard constraints handed to the proof stage. The proof keeps every source
 * used by the draft so targeted edits preserve facts and style references.
 */
export interface ProofConstraints {
  presetText: string;
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
}

export function buildReviewContextFromSnapshot(
  snapshot: PipelineContextSnapshot,
): ReviewContext {
  return {
    presetText: snapshot.presetText,
    characterText: snapshot.characterText,
    noteText: snapshot.noteText,
    worldbookText: snapshot.worldbookText,
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
  currentInstructionText: string;
  retrievalUserPrompt: string;
  presetText: string;
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
    currentInstructionText: snapshot.currentInstructionText,
    retrievalUserPrompt: snapshot.retrievalUserPrompt,
    presetText: snapshot.presetText,
  };
}
