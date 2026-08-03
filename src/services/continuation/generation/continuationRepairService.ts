/**
 * Local repair of open blocking/error checks (Spec §9.4).
 */
import type { ContinuationCheckResult } from './types';

export interface DeterministicRepairResult {
  content: string;
  repairedIssueIds: number[];
}

/**
 * Apply simple deterministic repairs for known subtypes when LLM is unavailable.
 * Returns repaired text or null if no local repair possible.
 */
export function tryDeterministicRepair(
  text: string,
  openChecks: ContinuationCheckResult[],
): string | null {
  return tryDeterministicRepairWithReport(text, openChecks)?.content ?? null;
}

/** Apply only the narrow deterministic repairs and report their exact issue ids. */
export function tryDeterministicRepairWithReport(
  text: string,
  openChecks: ContinuationCheckResult[],
): DeterministicRepairResult | null {
  let next = text;
  let changed = false;
  const repairedIssueIds = new Set<number>();
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
  const appliedFutureRanges = new Set<string>();
  for (const c of futureLeakageChecks) {
    const start = c.generatedStart!;
    const end = c.generatedEnd!;
    const rangeKey = `${start}:${end}`;
    if (
      appliedFutureRanges.has(rangeKey) ||
      start < 0 ||
      end <= start ||
      end > text.length
    ) {
      continue;
    }
    appliedFutureRanges.add(rangeKey);
    next = next.slice(0, start) + '（已删除不当揭示）' + next.slice(end);
    changed = true;
    repairedIssueIds.add(c.id);
  }
  // resurrection_forbidden 是全局 replace，不受 offset 影响，放最后处理。
  for (const c of openChecks) {
    if (c.severity !== 'blocking' && c.severity !== 'error') continue;
    if (c.subtype === 'resurrection_forbidden') {
      const repaired = next
        .replace(/死而复生/g, '昏迷苏醒')
        .replace(/起死回生/g, '伤势好转')
        .replace(/复活/g, '醒来');
      if (repaired !== next) {
        next = repaired;
        repairedIssueIds.add(c.id);
        changed = true;
      }
    }
  }
  return changed
    ? { content: next, repairedIssueIds: Array.from(repairedIssueIds) }
    : null;
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
