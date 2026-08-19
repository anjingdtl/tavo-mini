export type PipelineStageName =
  | 'draft'
  | 'qa'
  | 'review'
  | 'factCheck'
  | 'brief'
  | 'proof';
export type PipelineMode = 'noReview' | 'twoStage' | 'conditional' | 'full';
/**
 * New V3 settings use low/high/max. `medium` is retained only so historical
 * V2 execution snapshots and their retry fingerprints remain parseable.
 */
export type PipelineReasoningEffort = 'low' | 'medium' | 'high' | 'max';

export type PipelineTaskStatus =
  | 'idle'
  | 'queued'
  | 'drafting'
  | 'qa'
  | 'reviewing'
  | 'factChecking'
  | 'briefing'
  | 'proofing'
  | 'completed'
  | 'cancelled'
  | 'failed'
  /** Cold-start / process death with successful draft + valid snapshot. */
  | 'interrupted';

/**
 * One-Shot (极速) execution profile. Stored beside the reasoning tier in the
 * pipeline settings; frozen into each task's execution snapshot at start.
 */
export type PipelineExecutionProfile = 'standard' | 'one_shot';

export interface PipelineConfig {
  pipelineMode: PipelineMode;
  /** V2/V3 product tier; V3 settings normalize to low/high/max. */
  reasoningEffort?: PipelineReasoningEffort;
  /**
   * 极速 (One-Shot) execution profile. Not a reasoning tier: it changes how
   * many stages run, never how much context the model receives.
   */
  executionProfile?: PipelineExecutionProfile;
  /** Product reasoning profile version; new outline tasks freeze version 5. */
  reasoningProfileVersion?: 1 | 2 | 3 | 4 | 5;
  /** New tasks use one project-scoped active Writer Style. */
  activeWriterStyleId: number | null;
  draftPresetId: number | null;
  reviewPresetId: number | null;
  factCheckPresetId: number | null;
  proofPresetId: number | null;
  draftMaxTokens: number;
  reviewMaxTokens: number;
  factCheckMaxTokens: number;
  proofMaxTokens: number;
  /** Independent Brief visible JSON budget; no preset is required. */
  briefVisibleOutputFloor?: number;
  /** Independent low-Thinking headroom for Brief. */
  briefReasoningHeadroom?: number;
}

export interface PipelineStageResult {
  stage: PipelineStageName;
  text: string;
  status: 'success' | 'failed' | 'skipped';
  error?: string;
  /** Durable machine-readable failure code, when a stage needs special recovery. */
  errorCode?: string;
  /** Non-blocking local/audit quality warnings retained with the stage. */
  warnings?: string[];
  tokens?: {
    input: number;
    output: number;
    total: number;
    /** Hidden Thinking tokens, when reported by the provider. */
    reasoning?: number;
    /** Visible business-output tokens, independent from reasoning. */
    visible?: number;
  };
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
   * Frozen outline workflow protocol version (Schema 44+).
   * 1 = Legacy Review / FactCheck / Proof; 2 = anchored audits + revision
   * contract + Final Reviser. Frozen ONCE at task creation; resume never
   * re-reads the live default. Pre-upgrade tasks default to 1.
   */
  outlineWorkflowVersion?: number | null;
  /**
   * Frozen context-budget strategy version (Schema 44+).
   * 1 = Legacy budget; 2 = elastic budget V2; 5 = current five-stage
   * independent elastic reservations. Frozen with the task.
   */
  contextBudgetVersion?: number | null;
  /**
   * Frozen pipeline topology version (Schema 55+).
   * 1 = legacy_standard; 2 = compact_standard. Freeze ONCE at task creation;
   * batch child chapters inherit the batch value; resume NEVER re-reads the
   * live default. Pre-upgrade rows default to 1 (legacy) so historical Frozen
   * tasks are never taken over by the compact Standard topology.
   */
  pipelineTopologyVersion?: number | null;
  /** Parent task for a derived Final-only rewrite; source task is immutable. */
  parentTaskId?: string | null;
  /** Currently supported derived task kind. */
  derivedKind?: 'final_rewrite' | null;
  /** User-supplied low-priority instruction for a derived Final rewrite. */
  derivedInstruction?: string | null;
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
