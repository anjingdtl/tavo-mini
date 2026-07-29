/**
 * Context trace helpers for result UI (Spec §15).
 */
import type { ContinuationContextTrace } from './types';

export function summarizeTrace(trace: ContinuationContextTrace): string {
  const cats = trace.categories
    .map(c => `${c.name}:${c.tokens}t`)
    .join(' · ');
  const freshness = [
    `canon=${trace.freshness.canonReady ? 'ready' : 'no'}`,
    `memory=${trace.freshness.storyMemoryStatus}`,
    `pendingExtract=${trace.freshness.pendingStateExtractionCount}`,
    `pendingMajor=${trace.freshness.pendingMajorProposalCount}`,
  ].join(' ');
  return [
    `Canon ${trace.canonSnapshotId.slice(0, 8)}@r${trace.canonRevision}`,
    `pos=${trace.targetPosition}`,
    `window=${trace.modelContextLimit ?? 'legacy'} budget=${trace.inputBudget ?? 'legacy'} in=${trace.totalInputTokens} outReserve=${trace.reservedOutputTokens}`,
    cats,
    freshness,
    trace.omittedCapabilities.length
      ? `omittedCaps=${trace.omittedCapabilities.join(',')}`
      : 'caps=ok',
  ].join(' | ');
}

export function parseTraceJson(json: string | null): ContinuationContextTrace | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as ContinuationContextTrace;
  } catch {
    return null;
  }
}
