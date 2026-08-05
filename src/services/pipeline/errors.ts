/**
 * Unified pipeline error codes (invariant: no Chinese regex classification).
 */
import type { PipelineError, PipelineErrorCode } from './types';
import { OutlineContextError } from '../outlineContextBuilder';

export function pipelineError(
  code: PipelineErrorCode,
  message: string,
  extra?: Partial<PipelineError>,
): PipelineError {
  return {
    code,
    message,
    stage: extra?.stage,
    userAction: extra?.userAction ?? 'none',
    diagnostics: extra?.diagnostics,
  };
}

export function mapOutlineErrorToPipelineError(
  error: unknown,
): PipelineError | null {
  if (error instanceof OutlineContextError) {
    const codeMap: Record<string, PipelineErrorCode> = {
      OUTLINE_OVER_BUDGET: 'OUTLINE_TOO_LARGE',
      OUTLINE_MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
      OUTLINE_SNAPSHOT_INVALID: 'SNAPSHOT_INVALID',
      OUTLINE_SNAPSHOT_PERSIST_FAILED: 'SNAPSHOT_PERSIST_FAILED',
      OUTLINE_EXECUTION_CONFIG_INVALID: 'EXECUTION_CONFIG_CHANGED',
      OUTLINE_CONTEXT_WINDOW_EXCEEDED: 'CONTEXT_WINDOW_EXCEEDED',
    };
    // Preserve structured codes only — never classify by Chinese message text.
    const code: PipelineErrorCode =
      codeMap[error.code] || 'CONTEXT_WINDOW_EXCEEDED';
    return pipelineError(code, error.message, {
      userAction: (error.userAction as PipelineError['userAction']) || 'none',
    });
  }
  return null;
}

export function formatPipelineErrorForUser(err: PipelineError): string {
  return err.message;
}

export function isOutlineBudgetError(err: PipelineError): boolean {
  return err.code === 'OUTLINE_TOO_LARGE';
}
