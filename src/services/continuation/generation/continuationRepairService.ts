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
  // H9 修复：future_leakage 按 generatedStart 降序处理。原顺序处理时，前一个
  // 修改改变了字符串长度，后续 issue 的 offset（基于原 text）会指向错误位置，
  // 导致正文被切坏。从后往前处理，前面的 offset 不受后面修改影响。
  const futureLeakageChecks = openChecks
    .filter(
      c =>
        (c.severity === 'blocking' || c.severity === 'error') &&
        c.subtype === 'future_leakage' &&
        c.generatedStart != null &&
        c.generatedEnd != null,
    )
    .sort((a, b) => (b.generatedStart ?? 0) - (a.generatedStart ?? 0));
  for (const c of futureLeakageChecks) {
    next =
      next.slice(0, c.generatedStart!) +
      '（已删除不当揭示）' +
      next.slice(c.generatedEnd!);
    changed = true;
  }
  // resurrection_forbidden 是全局 replace，不受 offset 影响，放最后处理。
  for (const c of openChecks) {
    if (c.severity !== 'blocking' && c.severity !== 'error') continue;
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
