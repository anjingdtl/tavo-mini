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
    trace.primaryAnchorKind === 'source_seam'
      ? '本章接缝：原著边界'
      : trace.primaryAnchorKind === 'continuation_chapter'
        ? `本章接缝：续写第 ${(trace.primaryAnchorPosition ?? 0) + 1} 章`
        : '本章接缝：legacy 原著接缝',
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
