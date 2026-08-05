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
  | 'failed';

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
   * Frozen PipelineContextSnapshot JSON (Schema 38+). Captured once after
   * buildContext succeeds and before the first LLM call. Resume MUST reuse
   * this instead of rebuilding from the live database. NULL for legacy tasks.
   */
  pipelineContextJson?: string | null;
  /** Snapshot schema version (currently 1). */
  pipelineContextVersion?: number | null;
  /** Integrity hash of pipelineContextJson. */
  pipelineContextHash?: string | null;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
  resolvedAction?: 'accept' | 'reject' | null;
}
