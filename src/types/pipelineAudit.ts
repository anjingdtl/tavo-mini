/** Outline-consistency assessment status returned by literary review. */
export type OutlineAssessmentStatus =
  | 'aligned'
  | 'partial'
  | 'deviated'
  | 'over_advanced';

/**
 * Structured outline execution assessment produced by the review stage when
 * a project outline was injected. Arrays are empty when no issues found.
 */
export interface OutlineAssessment {
  status: OutlineAssessmentStatus;
  fulfilledBeats: string[];
  missingBeats: string[];
  deviations: string[];
  prematureBeats: string[];
  factRollbackRisks: string[];
}

/** Literary review report shape (strengths / issues / suggestions). */
export interface ReviewReport {
  strengths: string[];
  issues: string[];
  suggestions: string[];
  /** Present only when the review stage received a project outline. */
  outlineAssessment?: OutlineAssessment;
}

/** Structured fact-check item (compatible with free-form string items). */
export interface FactCheckItem {
  category?: string;
  description: string;
  draftQuote?: string;
  evidenceType?: string;
  evidence?: string;
  suggestedAction?: string;
}

/** Fact-check report shape. Arrays may mix strings and objects. */
export interface FactCheckReport {
  errors: Array<string | FactCheckItem>;
  warnings: Array<string | FactCheckItem>;
  confirmed: Array<string | FactCheckItem>;
}

export type AuditValidationFailureReason =
  | 'empty_content'
  | 'reasoning_only'
  | 'invalid_json'
  | 'missing_required_fields'
  | 'draft_echo'
  | 'truncated_output'
  | 'oversized_report'
  | 'unexpected_shape'
  | 'novel_output'
  | 'conflict';

export interface AuditValidationResult<T> {
  valid: boolean;
  report?: T;
  normalizedText?: string;
  reason?: AuditValidationFailureReason;
  details?: string;
  similarity?: number;
  /** Non-blocking Review V2 normalization/fallback notes. */
  warnings?: string[];
}

export interface DraftEchoCheckResult {
  isEcho: boolean;
  similarity: number;
  longestSharedSegment?: number;
  reason?: string;
}

/** Local lightweight thresholds for draft-echo detection (adjustable via tests). */
export const AUDIT_ECHO_THRESHOLDS = {
  /** Reject when audit text length / draft length exceeds this (long drafts). */
  AUDIT_TO_DRAFT_LENGTH_RATIO: 0.65,
  /** Continuous shared segment longer than this is treated as draft echo. */
  LONG_SHARED_SEGMENT_CHARS: 400,
  /** A single report item must not approach full-chapter size. */
  MAX_SINGLE_AUDIT_ITEM_CHARS: 2000,
  /** Absolute max for the whole normalized report body. */
  MAX_REPORT_CHARS: 12000,
  /** Draft shorter than this relies primarily on structure checks. */
  SHORT_DRAFT_CHARS: 300,
  /** Max non-JSON prose allowed outside a fenced JSON block. */
  MAX_SURROUNDING_PROSE_CHARS: 200,
} as const;
