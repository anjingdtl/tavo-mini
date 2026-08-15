/**
 * Generation Trace contracts (Stability Plan §6 / §9 / §14).
 *
 * Every real generation owns one generationTraceId that spans
 * UI → Collect → Normalize → Plan → Allocate → Render → Freeze → Draft →
 * Review → FactCheck → Proof → Finalize. The id is frozen inside the
 * persisted pipeline task context envelope, so resume / cold start reuse it
 * instead of minting a new identity for the same generation.
 *
 * This module is TYPES ONLY — runtime helpers live in
 * `services/pipeline/generationTrace.ts`.
 */

/** Plan §9 — structured severity for generation-semantic diagnostics. */
export type GenerationDiagnosticSeverity =
  | 'info'
  | 'warning'
  | 'error'
  | 'blocking';

/** Plan §9 — overall outcome derived from the diagnostic set. */
export type GenerationOverallStatus = 'OK' | 'DEGRADED' | 'BLOCKED';

/** Plan §9 — one structured diagnostic attached to a generation. */
export interface GenerationDiagnostic {
  /** Machine-readable code from GENERATION_ERROR_CODES (Plan §14). */
  code: string;
  severity: GenerationDiagnosticSeverity;
  message: string;
  /** Pipeline stage the diagnostic belongs to, when known. */
  stage?: string;
  /** Logical source module (e.g. 'contextBuilder.resources'). */
  source?: string;
  /** Optional structured detail; must stay JSON-serializable. */
  detail?: Record<string, unknown>;
}

/**
 * Plan §14 — unified error-code registry. Free-text errors must not keep
 * accumulating in local functions; new generation-semantic failures register
 * a code here.
 */
export const GENERATION_ERROR_CODES = {
  // Generation context domain
  GENERATION_CONTEXT_SOURCE_CHANGED: 'GENERATION_CONTEXT_SOURCE_CHANGED',
  GENERATION_CONTEXT_FREEZE_FAILED: 'GENERATION_CONTEXT_FREEZE_FAILED',
  // Resource domain
  RESOURCE_RETRIEVAL_FAILED: 'RESOURCE_RETRIEVAL_FAILED',
  RESOURCE_RENDER_FAILED: 'RESOURCE_RENDER_FAILED',
  RESOURCE_DEMAND_PROBE_FAILED: 'RESOURCE_DEMAND_PROBE_FAILED',
  RESOURCE_POOL_CAPTURE_FAILED: 'RESOURCE_POOL_CAPTURE_FAILED',
  // Story memory domain
  STORY_MEMORY_CHECKPOINT_DIRTY: 'STORY_MEMORY_CHECKPOINT_DIRTY',
  STORY_MEMORY_CHECKPOINT_FUTURE: 'STORY_MEMORY_CHECKPOINT_FUTURE',
  STORY_MEMORY_RENDER_FAILED: 'STORY_MEMORY_RENDER_FAILED',
  // Episodic memory domain
  EPISODIC_MEMORY_RETRIEVAL_FAILED: 'EPISODIC_MEMORY_RETRIEVAL_FAILED',
  // Note domain
  NOTE_RETRIEVAL_FAILED: 'NOTE_RETRIEVAL_FAILED',
  NOTE_STYLE_ANALYSIS_FAILED: 'NOTE_STYLE_ANALYSIS_FAILED',
  // Writer style domain
  WRITER_STYLE_RENDER_FAILED: 'WRITER_STYLE_RENDER_FAILED',
  // Budget domain
  BUDGET_MANDATORY_OVERFLOW: 'BUDGET_MANDATORY_OVERFLOW',
  BUDGET_INVALID_CAPACITY: 'BUDGET_INVALID_CAPACITY',
  // Snapshot domain
  SNAPSHOT_FINGERPRINT_MISMATCH: 'SNAPSHOT_FINGERPRINT_MISMATCH',
  SNAPSHOT_PARSE_FAILED: 'SNAPSHOT_PARSE_FAILED',
  SNAPSHOT_UNFROZEN_REREAD: 'SNAPSHOT_UNFROZEN_REREAD',
  // Pipeline domain
  PIPELINE_SNAPSHOT_MISSING: 'PIPELINE_SNAPSHOT_MISSING',
  PIPELINE_DRAFT_SAVE_FAILED: 'PIPELINE_DRAFT_SAVE_FAILED',
  // Resume domain
  RESUME_CONTEXT_MISMATCH: 'RESUME_CONTEXT_MISMATCH',
} as const;

export type GenerationErrorCode =
  (typeof GENERATION_ERROR_CODES)[keyof typeof GENERATION_ERROR_CODES];

/**
 * Trace identity record persisted inside the pipeline task context envelope
 * (PipelineContextEnvelopeV2+). Absent on historical tasks — absence is NOT
 * an error, it simply means the task predates Phase 1 tracing.
 */
export interface GenerationTraceRecordV1 {
  version: 1;
  generationTraceId: string;
  createdAt: number;
}

/** Plan §6 — budget block of the minimal generation trace summary. */
export interface GenerationTraceBudgetSummary {
  hardInputLimit: number | null;
  softInputLimit: number | null;
  burstInputLimit: number | null;
  finalEstimatedInputTokens: number | null;
}

/** Plan §6 — minimal generation trace summary (derived, never guessed). */
export interface GenerationTraceSummaryV1 {
  version: 1;
  generationTraceId: string | null;
  pipelineTaskId: string;
  projectId: number | null;
  chapterId: number | null;
  writingMode: string | null;
  outlineWorkflowVersion: number | null;
  contextBudgetVersion: number | null;
  modelId: string | null;
  contextWindow: number | null;
  reservedOutputTokens: number | null;
  safetyMargin: number | null;
  candidateCount: number | null;
  selectedCount: number | null;
  budget: GenerationTraceBudgetSummary;
  attemptCount: number;
  overallStatus: GenerationOverallStatus;
  diagnostics: GenerationDiagnostic[];
}
