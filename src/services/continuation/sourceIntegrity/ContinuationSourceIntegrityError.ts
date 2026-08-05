/**
 * Dedicated error for continuation source storage integrity failures.
 * Deterministic — not transient. Callers must not spin "稍后重试" loops.
 */

export type ContinuationSourceIntegrityCode =
  | 'continuation_source_integrity_failed'
  | 'style_sample_hash_mismatch'
  | 'chunk_length_mismatch'
  | 'chunk_hash_mismatch'
  | 'chunk_offset_gap'
  | 'chunk_offset_overlap'
  | 'chunk_surrogate_boundary'
  | 'chapter_range_invalid'
  | 'chapter_content_mismatch'
  | 'boundary_invalid'
  | 'read_range_length_mismatch';

export class ContinuationSourceIntegrityError extends Error {
  readonly code: ContinuationSourceIntegrityCode;
  readonly retryable = false as const;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ContinuationSourceIntegrityCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ContinuationSourceIntegrityError';
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isContinuationSourceIntegrityError(
  err: unknown,
): err is ContinuationSourceIntegrityError {
  return err instanceof ContinuationSourceIntegrityError;
}
