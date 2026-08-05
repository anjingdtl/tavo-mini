export type PipelineStageName = 'draft' | 'review' | 'factCheck' | 'proof';
export type PipelineMode = 'noReview' | 'twoStage' | 'conditional' | 'full';

export type PipelineTaskStatus =
  | 'idle'
  | 'queued'
  | 'drafting'
  | 'reviewing'
  | 'factChecking'
  | 'proofing'
  | 'completed'
  | 'cancelled'
  | 'failed'
  /** Cold-start / process death with successful draft + valid snapshot. */
  | 'interrupted';

export interface PipelineConfig {
  pipelineMode: PipelineMode;
  draftPresetId: number | null;
  reviewPresetId: number | null;
  factCheckPresetId: number | null;
  proofPresetId: number | null;
  draftMaxTokens: number;
  reviewMaxTokens: number;
  factCheckMaxTokens: number;
  proofMaxTokens: number;
}

export interface PipelineStageResult {
  stage: PipelineStageName;
  text: string;
  status: 'success' | 'failed' | 'skipped';
  error?: string;
  tokens?: { input: number; output: number; total: number };
  durationMs: number;
}

export interface PipelineTask {
  id: string;
  targetType: 'chapter' | 'freeform';
  targetId: number;
  status: PipelineTaskStatus;
  stageResults: PipelineStageResult[];
  finalText: string | null;
  error: string | null;
  /**
   * Frozen input fingerprint (projectId | chapterId | chapterUpdatedAt |
   * outlineFingerprint) captured at task completion. Used by the result-adoption
   * flow to detect whether the outline or chapter changed between generation
   * and adoption. NULL for legacy tasks created before Schema 37.
   */
  inputFingerprint?: string | null;
  /**
   * Frozen pipeline task context JSON (Schema 38+).
   * V1: bare PipelineContextSnapshot.
   * V2: envelope with draftContext + optional auditContext + execution.
   * Captured once after buildContext succeeds and before the first LLM call.
   * Resume MUST reuse this instead of rebuilding from the live database.
   */
  pipelineContextJson?: string | null;
  /** Snapshot envelope version (1 = bare snapshot, 2 = draft+audit+execution). */
  pipelineContextVersion?: number | null;
  /** Integrity hash of pipelineContextJson. */
  pipelineContextHash?: string | null;
  /**
   * True when cold-start classification left this task recoverable.
   * Only meaningful for status === 'interrupted'.
   */
  recoverable?: boolean;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
  resolvedAction?: 'accept' | 'reject' | null;
}
