import type { Chapter } from '../../types/novel';
import { estimateTokens } from '../../utils/tokenEstimator';
import type { StoryMemoryCoveragePlan } from './storyMemoryTypes';

/**
 * Hard ceiling on how many chapters may enter the draft context as RAW full
 * text — regardless of the model context window or the sliding token budget.
 * Applies to both the pending bridge (chapters after the last checkpoint) and
 * the plain sliding window. Older history must be covered by episodic
 * summaries / Story Memory, never by raw text.
 */
export const STORY_MEMORY_MAX_RAW_CHAPTERS = 10;

/**
 * Budget-neutral Story Coverage candidates used by Context Budget V3.
 *
 * Candidate collection deliberately does not know about ContextConfig or a
 * token grant. It only describes what could be covered. The V3 board grant is
 * applied later by `resolveStoryMemoryCoverage`, after all boards have
 * reported their actual demand and the global allocator has reclaimed/borrowed
 * capacity.
 */
export interface StoryCoverageCandidates {
  checkpointThroughPosition: number;
  pendingChapters: Chapter[];
  seamChapter: Chapter | null;
  rawEligibleChapters: Chapter[];
  episodicEligibleChapters: Chapter[];
}

function hasUsableEpisodicSummary(chapter: Chapter): boolean {
  return Boolean(chapter.memory_summary?.trim());
}

function chapterRawTokens(chapter: Chapter): number {
  const title = chapter.title || `第 ${chapter.position + 1} 章`;
  const body = chapter.content || '';
  return estimateTokens(`${title}\n${body}`);
}

function chapterSummaryTokens(chapter: Chapter): number {
  return estimateTokens(chapter.memory_summary || '');
}

function collectPendingChapters(input: {
  currentChapter: Chapter;
  chapters: Chapter[];
  checkpointThroughPosition: number;
}): Chapter[] {
  return input.chapters
    .filter(
      chapter =>
        chapter.position > input.checkpointThroughPosition &&
        chapter.position < input.currentChapter.position &&
        Boolean(chapter.content?.trim()),
    )
    .sort((a, b) => a.position - b.position);
}

function findSeamChapter(currentChapter: Chapter, chapters: Chapter[]): Chapter | null {
  return (
    chapters
      .filter(
        chapter =>
          chapter.position < currentChapter.position &&
          Boolean(chapter.content?.trim()),
      )
      .sort((a, b) => b.position - a.position)[0] || null
  );
}

/** Collect Story Coverage candidates without applying any token budget. */
export function collectStoryMemoryCoverageCandidates(input: {
  currentChapter: Chapter;
  chapters: Chapter[];
  checkpointThroughPosition: number;
}): StoryCoverageCandidates {
  const pendingChapters = collectPendingChapters(input);
  const seamChapter = findSeamChapter(input.currentChapter, input.chapters);
  const rawEligibleChapters = pendingChapters.slice(-STORY_MEMORY_MAX_RAW_CHAPTERS);
  const episodicEligibleChapters = pendingChapters.filter(hasUsableEpisodicSummary);
  return {
    checkpointThroughPosition: input.checkpointThroughPosition,
    pendingChapters,
    seamChapter,
    rawEligibleChapters,
    episodicEligibleChapters,
  };
}

/**
 * Convert budget-neutral candidates into a grant-resolved plan.
 *
 * The most recent raw candidates (including the immediate seam) win first;
 * chapters with a verified summary can fall back to Episodic. The raw product
 * hard guard remains ten chapters, while the actual raw/summary decision is
 * made solely from the V3 sliding-board grant.
 */
export function resolveStoryMemoryCoverage(input: {
  candidates: StoryCoverageCandidates;
  slidingBudgetTokens: number;
}): StoryMemoryCoveragePlan {
  const { candidates } = input;
  const budget = Math.max(0, Math.floor(Number(input.slidingBudgetTokens) || 0));
  const pending = [...candidates.pendingChapters].sort(
    (a, b) => a.position - b.position,
  );
  const rawEligibleIds = new Set(
    candidates.rawEligibleChapters.map(chapter => chapter.id),
  );
  const episodicEligibleIds = new Set(
    candidates.episodicEligibleChapters.map(chapter => chapter.id),
  );
  const pendingIds = new Set(pending.map(chapter => chapter.id));
  const rawChapterIds: number[] = [];
  const episodicFallbackChapterIds: number[] = [];
  const uncoveredChapterIds: number[] = [];
  let remaining = budget;
  let usedTokens = 0;

  // A seam outside the pending range is still protected, but only with the
  // grant it actually receives. The final renderer may tail-clip this block.
  const seamIsPending = Boolean(
    candidates.seamChapter && pendingIds.has(candidates.seamChapter.id),
  );
  if (candidates.seamChapter && !seamIsPending) {
    const seamReserve = Math.min(
      remaining,
      chapterRawTokens(candidates.seamChapter),
    );
    remaining -= seamReserve;
    usedTokens += seamReserve;
  }

  const assignChapter = (chapter: Chapter, allowRaw: boolean) => {
    const rawCost = chapterRawTokens(chapter);
    const summaryCost = chapterSummaryTokens(chapter);
    if (allowRaw && rawCost <= remaining) {
      rawChapterIds.push(chapter.id);
      remaining -= rawCost;
      usedTokens += rawCost;
      return;
    }
    if (episodicEligibleIds.has(chapter.id) && summaryCost <= remaining) {
      episodicFallbackChapterIds.push(chapter.id);
      remaining -= summaryCost;
      usedTokens += summaryCost;
      return;
    }
    uncoveredChapterIds.push(chapter.id);
  };

  // Newest first preserves the immediate seam and lets the grant expand
  // backwards as capacity becomes available. We sort the resulting ids below
  // so the rendered bridge remains chronological.
  for (const chapter of [...candidates.rawEligibleChapters].sort(
    (a, b) => b.position - a.position,
  )) {
    assignChapter(chapter, rawEligibleIds.has(chapter.id));
  }
  for (const chapter of [...pending]
    .filter(chapter => !rawEligibleIds.has(chapter.id))
    .sort((a, b) => b.position - a.position)) {
    assignChapter(chapter, false);
  }

  const positionOf = (id: number) =>
    pending.find(chapter => chapter.id === id)?.position ||
    candidates.seamChapter?.position ||
    0;
  rawChapterIds.sort((a, b) => positionOf(a) - positionOf(b));
  episodicFallbackChapterIds.sort((a, b) => positionOf(a) - positionOf(b));
  uncoveredChapterIds.sort((a, b) => positionOf(a) - positionOf(b));

  const hardDue = uncoveredChapterIds.length > 0;
  return {
    checkpointThroughPosition: candidates.checkpointThroughPosition,
    pendingChapters: pending,
    seamChapter: candidates.seamChapter,
    rawChapterIds,
    episodicFallbackChapterIds,
    uncoveredChapterIds,
    estimatedRawTokens: usedTokens,
    hardDue,
    reason: hardDue
      ? 'coverage_gap'
      : episodicFallbackChapterIds.length > 0
        ? 'mixed_raw_episodic'
        : 'full_raw',
    bridgeBudgetTokens: budget,
  };
}

/** Natural sliding-board demand before the V3 grant resolves coverage. */
export function estimateStoryCoverageCandidateDemand(
  candidates: StoryCoverageCandidates,
): number {
  const pendingIds = new Set(candidates.pendingChapters.map(chapter => chapter.id));
  const rawDemand = candidates.rawEligibleChapters.reduce(
    (sum, chapter) => sum + chapterRawTokens(chapter),
    0,
  );
  const seamDemand =
    candidates.seamChapter && !pendingIds.has(candidates.seamChapter.id)
      ? chapterRawTokens(candidates.seamChapter)
      : 0;
  return rawDemand + seamDemand;
}

export function createCandidateStoryMemoryCoveragePlan(
  candidates: StoryCoverageCandidates,
): StoryMemoryCoveragePlan {
  return {
    checkpointThroughPosition: candidates.checkpointThroughPosition,
    pendingChapters: [...candidates.pendingChapters],
    seamChapter: candidates.seamChapter,
    rawChapterIds: [],
    episodicFallbackChapterIds: [],
    uncoveredChapterIds: [],
    estimatedRawTokens: 0,
    hardDue: false,
    reason: 'candidate_first',
  };
}

/**
 * Empty coverage plan used when prepare() hard-blocks before planning
 * (e.g. illegal target chapter position). Never triggers hardDue / LLM.
 */
export function createEmptyStoryMemoryCoveragePlan(
  reason = 'invalid_target_position',
): StoryMemoryCoveragePlan {
  return {
    checkpointThroughPosition: -1,
    pendingChapters: [],
    seamChapter: null,
    rawChapterIds: [],
    episodicFallbackChapterIds: [],
    uncoveredChapterIds: [],
    estimatedRawTokens: 0,
    hardDue: false,
    reason,
  };
}

/**
 * Plan how pending chapters between the last checkpoint and the current
 * chapter are covered by raw text or episodic fallback summaries.
 *
 * Invariant: every pending chapter must appear in rawChapterIds,
 * episodicFallbackChapterIds, or uncoveredChapterIds.
 */
export function planStoryMemoryCoverage(input: {
  currentChapter: Chapter;
  chapters: Chapter[];
  checkpointThroughPosition: number;
  slidingBudgetTokens: number;
}): StoryMemoryCoveragePlan {
  const budget = Math.max(0, Math.floor(input.slidingBudgetTokens || 0));
  const pendingChapters = input.chapters
    .filter(
      chapter =>
        chapter.position > input.checkpointThroughPosition &&
        chapter.position < input.currentChapter.position &&
        Boolean(chapter.content?.trim()),
    )
    .sort((a, b) => a.position - b.position);

  const seamChapter =
    input.chapters
      .filter(
        chapter =>
          chapter.position < input.currentChapter.position &&
          Boolean(chapter.content?.trim()),
      )
      .sort((a, b) => b.position - a.position)[0] || null;

  if (pendingChapters.length === 0) {
    return {
      checkpointThroughPosition: input.checkpointThroughPosition,
      pendingChapters: [],
      seamChapter,
      rawChapterIds: [],
      episodicFallbackChapterIds: [],
      uncoveredChapterIds: [],
      estimatedRawTokens: 0,
      hardDue: false,
      reason: 'no_pending',
    };
  }

  // Raw full text is capped at the most recent 10 valid chapters. Older
  // pending chapters may only be covered by episodic summaries (never raw),
  // so a huge context window cannot silently grow the raw prompt — history
  // must be carried by Story Memory / summaries / checkpoint catch-up.
  const rawCandidates = pendingChapters.slice(-STORY_MEMORY_MAX_RAW_CHAPTERS);
  const rawCandidateIds = new Set(rawCandidates.map(c => c.id));
  const olderPending = pendingChapters.filter(c => !rawCandidateIds.has(c.id));

  // Prefer full raw coverage in position order. Never drop early pending
  // chapters while keeping only the tail.
  const rawChapterIds: number[] = [];
  const episodicFallbackChapterIds: number[] = [];
  const uncoveredChapterIds: number[] = [];
  let usedTokens = 0;

  // Reserve seam if it is not already pending raw content.
  let seamReserve = 0;
  if (
    seamChapter &&
    !pendingChapters.some(chapter => chapter.id === seamChapter.id)
  ) {
    seamReserve = Math.min(budget, chapterRawTokens(seamChapter));
  }
  const pendingBudget = Math.max(0, budget - seamReserve);

  // First pass: try to place all raw candidates as raw in order.
  let canAllRaw = true;
  let probeTokens = 0;
  for (const chapter of rawCandidates) {
    const tokens = chapterRawTokens(chapter);
    if (probeTokens + tokens > pendingBudget) {
      canAllRaw = false;
      break;
    }
    probeTokens += tokens;
  }

  if (canAllRaw) {
    for (const chapter of rawCandidates) {
      rawChapterIds.push(chapter.id);
      usedTokens += chapterRawTokens(chapter);
    }
    // Older-than-10 pending chapters: episodic summary only, never raw.
    for (const chapter of olderPending) {
      if (hasUsableEpisodicSummary(chapter)) {
        const cost = chapterSummaryTokens(chapter);
        if (cost <= pendingBudget - usedTokens) {
          episodicFallbackChapterIds.push(chapter.id);
          usedTokens += cost;
        } else {
          uncoveredChapterIds.push(chapter.id);
        }
      } else {
        uncoveredChapterIds.push(chapter.id);
      }
    }
    const hardDue = uncoveredChapterIds.length > 0;
    return {
      checkpointThroughPosition: input.checkpointThroughPosition,
      pendingChapters,
      seamChapter,
      rawChapterIds,
      episodicFallbackChapterIds,
      uncoveredChapterIds,
      estimatedRawTokens: usedTokens + seamReserve,
      hardDue,
      reason: hardDue
        ? 'coverage_gap'
        : episodicFallbackChapterIds.length > 0
          ? 'mixed_raw_episodic'
          : 'full_raw',
    };
  }

  // Second pass: keep as much raw as possible within the recent-10 candidates,
  // then degrade earliest remaining chapters to verified episodic summaries.
  // Still never invent coverage for empty summaries.
  let remainingBudget = pendingBudget;
  const remaining: Chapter[] = [];

  for (const chapter of rawCandidates) {
    const tokens = chapterRawTokens(chapter);
    if (tokens <= remainingBudget) {
      rawChapterIds.push(chapter.id);
      remainingBudget -= tokens;
      usedTokens += tokens;
    } else {
      remaining.push(chapter);
    }
  }

  // If we still have remaining chapters, free raw budget from the earliest
  // raw chapters by converting them to episodic when possible, then place
  // remaining chapters.
  if (remaining.length > 0) {
    const rawSet = new Set(rawChapterIds);
    const ordered = [...rawCandidates];
    for (const chapter of ordered) {
      if (!rawSet.has(chapter.id)) continue;
      if (remaining.length === 0) break;
      if (!hasUsableEpisodicSummary(chapter)) continue;
      const freed = chapterRawTokens(chapter);
      const summaryCost = chapterSummaryTokens(chapter);
      // Convert earliest raw to summary only if it helps cover next remaining.
      const next = remaining[0];
      const nextCost = hasUsableEpisodicSummary(next)
        ? chapterSummaryTokens(next)
        : chapterRawTokens(next);
      if (remainingBudget + freed - summaryCost >= nextCost) {
        rawSet.delete(chapter.id);
        episodicFallbackChapterIds.push(chapter.id);
        remainingBudget = remainingBudget + freed - summaryCost;
        usedTokens = usedTokens - freed + summaryCost;
      }
    }
    rawChapterIds.length = 0;
    rawChapterIds.push(
      ...rawCandidates.filter(c => rawSet.has(c.id)).map(c => c.id),
    );

    const stillRemaining = rawCandidates.filter(
      chapter =>
        !rawSet.has(chapter.id) &&
        !episodicFallbackChapterIds.includes(chapter.id),
    );
    for (const chapter of stillRemaining) {
      if (hasUsableEpisodicSummary(chapter)) {
        const cost = chapterSummaryTokens(chapter);
        if (cost <= remainingBudget) {
          episodicFallbackChapterIds.push(chapter.id);
          remainingBudget -= cost;
          usedTokens += cost;
          continue;
        }
      }
      // Try raw if it somehow fits now.
      const rawCost = chapterRawTokens(chapter);
      if (rawCost <= remainingBudget) {
        rawChapterIds.push(chapter.id);
        remainingBudget -= rawCost;
        usedTokens += rawCost;
        continue;
      }
      uncoveredChapterIds.push(chapter.id);
    }
  }

  // Older-than-10 pending chapters: episodic summary only, never raw.
  for (const chapter of olderPending) {
    if (hasUsableEpisodicSummary(chapter)) {
      const cost = chapterSummaryTokens(chapter);
      if (cost <= remainingBudget) {
        episodicFallbackChapterIds.push(chapter.id);
        remainingBudget -= cost;
        usedTokens += cost;
      } else {
        uncoveredChapterIds.push(chapter.id);
      }
    } else {
      uncoveredChapterIds.push(chapter.id);
    }
  }

  // Ensure seam is represented: if seam is pending and not raw, prefer keeping
  // at least its tail via raw if budget allows; otherwise mark in reason.
  const hardDue = uncoveredChapterIds.length > 0;
  const reason = hardDue
    ? 'coverage_gap'
    : episodicFallbackChapterIds.length > 0
      ? 'mixed_raw_episodic'
      : 'full_raw';

  return {
    checkpointThroughPosition: input.checkpointThroughPosition,
    pendingChapters,
    seamChapter,
    rawChapterIds: [...rawChapterIds].sort(
      (a, b) =>
        (pendingChapters.find(c => c.id === a)?.position || 0) -
        (pendingChapters.find(c => c.id === b)?.position || 0),
    ),
    episodicFallbackChapterIds: [...episodicFallbackChapterIds].sort(
      (a, b) =>
        (pendingChapters.find(c => c.id === a)?.position || 0) -
        (pendingChapters.find(c => c.id === b)?.position || 0),
    ),
    uncoveredChapterIds,
    estimatedRawTokens: usedTokens + seamReserve,
    hardDue,
    reason,
  };
}

export function buildPendingBridgeText(
  plan: StoryMemoryCoveragePlan,
  chaptersById: Map<number, Chapter>,
  /**
   * Optional display-number mapper (Spec §11.3). Continuation callers pass
   * numbering.getDisplayNumber so bridge headers continue from the boundary.
   */
  getDisplayNumber: (position: number) => number = position => position + 1,
): string {
  const sections: string[] = [];
  const ordered = [...plan.pendingChapters].sort(
    (a, b) => a.position - b.position,
  );
  for (const chapter of ordered) {
    const live = chaptersById.get(chapter.id) || chapter;
    const displayNum = getDisplayNumber(live.position);
    const title = live.title || `第 ${displayNum} 章`;
    if (plan.rawChapterIds.includes(live.id)) {
      sections.push(`【第 ${displayNum} 章｜${title}】\n${live.content}`);
      continue;
    }
    if (plan.episodicFallbackChapterIds.includes(live.id)) {
      sections.push(
        `【第 ${displayNum} 章事件摘要｜${title}】\n${
          live.memory_summary || ''
        }`,
      );
    }
  }
  return sections.join('\n\n');
}

export function excludeRawFromEpisodicCandidates(
  chapters: Chapter[],
  rawChapterIds: number[],
): Chapter[] {
  const excluded = new Set(rawChapterIds);
  return chapters.filter(chapter => !excluded.has(chapter.id));
}
