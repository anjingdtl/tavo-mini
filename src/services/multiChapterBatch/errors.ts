/**
 * Multi-chapter batch errors — codes are stable identifiers (never derive
 * logic from Chinese copy).
 */
import type { MultiChapterBatchErrorCode } from '../../types/multiChapterBatch';

export class MultiChapterBatchError extends Error {
  readonly code: MultiChapterBatchErrorCode;
  constructor(code: MultiChapterBatchErrorCode, message: string) {
    super(message);
    this.name = 'MultiChapterBatchError';
    this.code = code;
  }
}
