/**
 * Local repair of open blocking/error checks (Spec §9.4).
 */
import type { ContinuationCheckResult } from './types';

/**
 * Apply simple deterministic repairs for known subtypes when LLM is unavailable.
 * Returns repaired text or null if no local repair possible.
 */
export function tryDeterministicRepair(
  text: string,
  openChecks: ContinuationCheckResult[],
): string | null {
  let next = text;
  let changed = false;
  for (const c of openChecks) {
    if (c.severity !== 'blocking' && c.severity !== 'error') continue;
    if (
      c.subtype === 'future_leakage' &&
      c.generatedStart != null &&
      c.generatedEnd != null
    ) {
      next =
        next.slice(0, c.generatedStart) +
        '（已删除不当揭示）' +
        next.slice(c.generatedEnd);
      changed = true;
    }
    if (c.subtype === 'resurrection_forbidden') {
      next = next
        .replace(/死而复生/g, '昏迷苏醒')
        .replace(/起死回生/g, '伤势好转')
        .replace(/复活/g, '醒来');
      changed = true;
    }
  }
  return changed ? next : null;
}

export function shouldRunRepair(
  openChecks: ContinuationCheckResult[],
  maxRounds: number,
  currentRound: number,
): boolean {
  if (currentRound >= maxRounds) return false;
  return openChecks.some(
    c =>
      c.resolutionStatus === 'open' &&
      (c.severity === 'error' || c.severity === 'blocking'),
  );
}
