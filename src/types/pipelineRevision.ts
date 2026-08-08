/**
 * Outline pipeline V5-Lite — revision protocol types (workflow version 2).
 *
 * V1 (Legacy) keeps `src/types/pipelineAudit.ts` + pipelineAuditValidator.ts.
 * V2 introduces anchored audits, a revision contract and a final reviser.
 * These types are pure data; parsing/validation lives in
 * `src/services/pipeline/revisionAuditValidator.ts`.
 */

/** One stable, deterministic anchor on the canonical draft (0 LLM). */
export interface PipelineRevisionAnchor {
  id: string;
  /** UTF-16 code unit offset (inclusive) into the canonical draft. */
  start: number;
  /** UTF-16 code unit offset (exclusive) into the canonical draft. */
  end: number;
  /** Exact canonical-draft substring [start, end). */
  text: string;
  /** 0-based natural-paragraph index in the canonical draft. */
  paragraphIndex: number;
  /**
   * 0-based segment index within the paragraph; 0 when the paragraph fits
   * one anchor (no over-length split).
   */
  segmentIndex: number;
}

/** Explicit scope for a correction; a bare anchorId cannot express all. */
export type PipelineRevisionScope =
  | 'anchor'
  | 'range'
  | 'insertion'
  | 'chapter'
  | 'boundary';

export type PipelineRevisionSeverity = 'required' | 'hard' | 'warning';

/** One correction item emitted by Review V2 / FactCheck V2. */
export interface PipelineAuditCorrectionV2 {
  id: string;
  scope: PipelineRevisionScope;

  anchorId?: string;
  anchorIds?: string[];
  insertionBeforeAnchorId?: string;
  insertionAfterAnchorId?: string;
  boundary?: 'opening' | 'ending';

  dimension: string;
  severity: PipelineRevisionSeverity;
  diagnosis: string;
  rewriteGoal: string;
  preserveMeaning: string[];
}

/** Literary review V2 report (anchored). */
export interface PipelineReviewReportV2 {
  schemaVersion: 2;
  draftHash: string;
  requiredCorrections: PipelineAuditCorrectionV2[];
  protectedAnchorIds: string[];
  outlineExecution: {
    fulfilledBeats: string[];
    missingBeats: string[];
    deviations: string[];
    prematureBeats: string[];
    mustPreserve: string[];
    endingGoal?: string;
    mustNotAdvance: string[];
  };
}

/** Fact-check V2 report (anchored). */
export interface PipelineFactCheckReportV2 {
  schemaVersion: 2;
  draftHash: string;
  requiredCorrections: PipelineAuditCorrectionV2[];
  protectedFacts: string[];
  hardConstraints: string[];
}

/** One executable work item inside the revision contract. */
export interface PipelineRevisionWorkItem {
  id: string;
  scope: PipelineRevisionScope;
  dimension: string;
  severity: PipelineRevisionSeverity;
  diagnosis: string;
  rewriteGoal: string;
  preserveMeaning: string[];
  /** Backfilled by the client; absent for chapter/boundary scopes. */
  anchors?: Array<{ id: string; start: number; end: number; text: string }>;
  insertionBeforeAnchorId?: string;
  insertionAfterAnchorId?: string;
  boundary?: 'opening' | 'ending';
}

/**
 * Deterministic revision contract compiled from successful V2 audits.
 * Pure data; the compiler is `src/services/pipeline/revisionContract.ts`.
 */
export interface PipelineRevisionContract {
  schemaVersion: 1;
  compilerVersion: 1;
  draftHash: string;
  reviewHash?: string;
  factCheckHash?: string;
  workItems: PipelineRevisionWorkItem[];
  protectedAnchorIds: string[];
  protectedFacts: string[];
  hardConstraints: string[];
  outlineObligations: {
    fulfilledBeats: string[];
    missingBeats: string[];
    mustPreserve: string[];
    endingGoal?: string;
    mustNotAdvance: string[];
  };
}
