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
  /** Current chapter title + synopsis instruction block. */
  currentInstructionText: string;

  /** The user's writing instruction for this run (retrieval prompt). */
  retrievalUserPrompt: string;
  /**
   * Optional fingerprint for debugging cross-stage source consistency.
   * Not consumed by prompts; only logged at dev level.
   */
  sourceFingerprint?: string;
}

/**
 * Subset of {@link PipelineContextSnapshot} consumed by the literary review.
 * (SPEC §8.2) Review focuses on style/structure/character voice, so it does
 * NOT need episodic or worldbook text.
 */
export interface ReviewContext {
  presetText: string;
  characterText: string;
  storyMemoryText: string;
  recentBridgeText: string;
  currentInstructionText: string;
  retrievalUserPrompt: string;
}

/**
 * Subset consumed by the fact-check stage. (SPEC §8.3) Fact-check needs every
 * continuity source: world rules, Story Memory, episodic events, bridge body
 * and current chapter instruction.
 */
export interface FactCheckContext {
  currentInstructionText: string;
  retrievalUserPrompt: string;
  recentBridgeText: string;
  storyMemoryText: string;
  episodicMemoryText: string;
  worldbookText: string;
  characterText: string;
  noteText: string;
}

/**
 * Hard constraints handed to the proof stage. (SPEC §8.4) The proof is a
 * targeted revision driven by the audit reports, not a free rewrite — it only
 * needs the constraints that must not be violated while editing.
 */
export interface ProofConstraints {
  currentInstructionText: string;
  retrievalUserPrompt: string;
  relevantCharacterConstraints: string;
  relevantWorldRules: string;
  currentStoryState: string;
  recentBridgeText: string;
}

export function buildReviewContextFromSnapshot(
  snapshot: PipelineContextSnapshot,
): ReviewContext {
  return {
    presetText: snapshot.presetText,
    characterText: snapshot.characterText,
    storyMemoryText: snapshot.storyMemoryText,
    recentBridgeText: snapshot.recentBridgeText,
    currentInstructionText: snapshot.currentInstructionText,
    retrievalUserPrompt: snapshot.retrievalUserPrompt,
  };
}

export function buildFactCheckContextFromSnapshot(
  snapshot: PipelineContextSnapshot,
): FactCheckContext {
  return {
    currentInstructionText: snapshot.currentInstructionText,
    retrievalUserPrompt: snapshot.retrievalUserPrompt,
    recentBridgeText: snapshot.recentBridgeText,
    storyMemoryText: snapshot.storyMemoryText,
    episodicMemoryText: snapshot.episodicMemoryText,
    worldbookText: snapshot.worldbookText,
    characterText: snapshot.characterText,
    noteText: snapshot.noteText,
  };
}

export function buildProofConstraintsFromSnapshot(
  snapshot: PipelineContextSnapshot,
): ProofConstraints {
  return {
    currentInstructionText: snapshot.currentInstructionText,
    retrievalUserPrompt: snapshot.retrievalUserPrompt,
    // Characters + worldbook + Story Memory carry the hard "must not violate"
    // facts the proof needs to respect while applying the audit fixes.
    relevantCharacterConstraints: snapshot.characterText,
    relevantWorldRules: snapshot.worldbookText,
    currentStoryState: snapshot.storyMemoryText,
    recentBridgeText: snapshot.recentBridgeText,
  };
}
