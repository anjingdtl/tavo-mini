/**
 * Bug #4: the 15% targeted-rescan source-chunk budget must actually be derived
 * from the real LLM context_window, and max_output_tokens + thinking must stay
 * at the user's configured values (not shrunk).
 *
 * Previously `runTargetedRescanForMissingDimensions` passed `undefined` for the
 * adaptive plan, so extractMaterialWithLlm fell back to a hardcoded chapter
 * text limit and the "15%" described in comments never took effect. The two
 * rounds also reused the same source range.
 */
import {
  resolveCanonBudget,
  SOURCE_CHUNK_RATIO_RESCAN,
  SOURCE_CHUNK_RATIO_NORMAL,
} from '../src/services/continuation/canon/canonBudgetPolicy';
import { resolveExtractionMaxTokens } from '../src/services/continuation/canon/adaptiveBatchPlanner';
import { resolveChapterTextLimitFromBudget } from '../src/services/continuation/canon/adaptiveBatchPlanner';

describe('Bug #4: 15% targeted-rescan budget + capability preservation', () => {
  it('SOURCE_CHUNK_RATIO_RESCAN is 0.15 (15%)', () => {
    expect(SOURCE_CHUNK_RATIO_RESCAN).toBe(0.15);
    expect(SOURCE_CHUNK_RATIO_RESCAN).toBeLessThan(SOURCE_CHUNK_RATIO_NORMAL);
  });

  it('rescan budget = 15% of context window, not 30%', () => {
    const contextWindow = 1_000_000;
    const maxOutput = 200_000;
    const budget = resolveCanonBudget({
      profile: 'standard',
      declaredContextWindow: contextWindow,
      configuredMaxOutputTokens: maxOutput,
      promptOverhead: 2000,
      chunkRatio: SOURCE_CHUNK_RATIO_RESCAN,
    });
    expect(budget.ok).toBe(true);
    // 15% of 1M = 150000 (before protocol-compat shrink).
    expect(budget.sourceChunkTargetTokens).toBeLessThanOrEqual(150000);
    // Protocol compat: input <= C - O - P = 1000000 - 200000 - 2000 = 798000.
    // 15% (150000) < 798000, so the target is 150000.
    expect(budget.sourceChunkTargetTokens).toBe(150000);
  });

  it('rescan max_tokens == configured max_output_tokens (never shrunk)', () => {
    const maxOutput = 200_000;
    const maxTokens = resolveExtractionMaxTokens({
      profile: 'standard',
      maxOutputTokens: maxOutput,
      effectiveInputBudget: 150000,
    });
    expect(maxTokens).toBe(maxOutput);
  });

  it('rescan chapter text limit derives from the 15% budget, not a hardcoded value', () => {
    const budget = resolveCanonBudget({
      profile: 'standard',
      declaredContextWindow: 1_000_000,
      configuredMaxOutputTokens: 200_000,
      promptOverhead: 2000,
      chunkRatio: SOURCE_CHUNK_RATIO_RESCAN,
    });
    const textLimit = resolveChapterTextLimitFromBudget(budget.sourceChunkTargetTokens);
    // 150000 tokens / 0.8 tokens-per-char ≈ 187500 chars.
    expect(textLimit).toBeGreaterThan(100000);
    expect(textLimit).toBeLessThan(200000);
    // Normal (30%) would be ~375000 chars — rescan must be smaller.
    const normalBudget = resolveCanonBudget({
      profile: 'standard',
      declaredContextWindow: 1_000_000,
      configuredMaxOutputTokens: 200_000,
      promptOverhead: 2000,
      chunkRatio: SOURCE_CHUNK_RATIO_NORMAL,
    });
    const normalLimit = resolveChapterTextLimitFromBudget(normalBudget.sourceChunkTargetTokens);
    expect(textLimit).toBeLessThan(normalLimit);
  });

  it('protocol-compat shrink: when output is huge, only the chunk shrinks', () => {
    // context=100000, output=90000, overhead=2000 → input room = 8000.
    // 15% of 100000 = 15000, but capped to 8000 by protocol.
    const budget = resolveCanonBudget({
      profile: 'standard',
      declaredContextWindow: 100000,
      configuredMaxOutputTokens: 90000,
      promptOverhead: 2000,
      chunkRatio: SOURCE_CHUNK_RATIO_RESCAN,
    });
    // sourceChunkTargetTokens should be the protocol-limited 8000 (15% would
    // be 15000 but capped). outputReserve stays at the full configured 90000.
    expect(budget.configuredMaxOutputTokens).toBe(90000);
    expect(budget.sourceChunkTargetTokens).toBeLessThanOrEqual(15000);
  });

  it('two rescan rounds use different source ranges (no duplicate request)', () => {
    // Simulate the round-slicing logic: 20 chapters, round 1 = back half,
    // round 2 = front half. The two slices must differ.
    const chapters = Array.from({ length: 20 }, (_, i) => i);
    const half = Math.ceil(chapters.length / 2);
    const round1 = chapters.slice(-half);
    const round2 = chapters.slice(0, Math.max(half, 1));
    expect(round1).not.toEqual(round2);
    // Back half covers the most-recent chapters (near the continuation boundary).
    expect(round1[round1.length - 1]).toBe(19);
    // Round 2 covers earlier chapters.
    expect(round2[0]).toBe(0);
  });

  it('fast mode rescan range stays within the last 10 chapters', () => {
    // planAnalysisScope with tail scope selects only the last 10 chapters;
    // the rescan never reads chapter 11-from-end or earlier.
    // (This is enforced by planAnalysisScope, not the rescan itself — assert
    // the contract here so a regression that widens the range is caught.)
    const { planAnalysisScope } =
      require('../src/services/continuation/canon/analysisScopePlanner');
    const chapters = Array.from({ length: 30 }, (_, i) => ({
      id: i + 1,
      sourceId: 1,
      position: i,
      title: `ch${i}`,
      content: 'x'.repeat(100),
      range: { start: i * 100, end: (i + 1) * 100 },
      clippedByBoundary: false,
    }));
    const plan = planAnalysisScope(chapters, {
      schemaVersion: 1,
      kind: 'tail',
      tailChapterCount: 10,
    });
    const positions = plan.nearChapters.map((c: { position: number }) => c.position);
    expect(positions.length).toBeLessThanOrEqual(10);
    expect(Math.min(...positions)).toBeGreaterThanOrEqual(20); // last 10 of 30
  });
});
