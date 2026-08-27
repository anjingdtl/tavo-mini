/**
 * Adaptive batch planner unit tests (2026-08-01 fix).
 *
 * Verifies the planner is fully derived from the user's LLM configuration:
 *   - no hardcoded context-window thresholds
 *   - chapter count per batch grows with context_window
 *   - oversized chapters are split into chunk batches (never skipped)
 *   - tiny contexts produce a friendly, actionable refusal with suggestions
 */
import {
  planAdaptiveBatching,
  precheckCanonAnalysis,
  estimateChapterTokens,
  estimateTokensPerCharForChapter,
  resolveExtractionMaxTokens,
  resolveChapterTextLimitFromBudget,
  CANON_REASONING_RETRY_OUTPUT_CEILING,
} from '../src/services/continuation/canon/adaptiveBatchPlanner';
import {
  SOURCE_CHUNK_RATIO_NORMAL,
} from '../src/services/continuation/canon/canonBudgetPolicy';
import type { BoundedSourceChapter } from '../src/services/continuation/types';

function makeChapter(
  id: number,
  title: string,
  content: string,
): BoundedSourceChapter {
  return {
    id,
    sourceId: 1,
    position: id as unknown as BoundedSourceChapter['position'],
    title,
    content,
    range: {
      start: 0 as unknown as BoundedSourceChapter['range']['start'],
      end: content.length as unknown as BoundedSourceChapter['range']['end'],
    },
    clippedByBoundary: false,
  };
}

/** CJK-dense chapter: roughly 0.6–1.0 token per char. */
function cjkChapter(id: number, charCount: number): BoundedSourceChapter {
  const unit = '这是一个测试章节的正文内容。'; // 15 chars
  const repeats = Math.max(1, Math.ceil(charCount / unit.length));
  return makeChapter(id, `第${id}章`, unit.repeat(repeats).slice(0, charCount));
}

/** ASCII-dense chapter: roughly 0.25 token per char. */
function asciiChapter(id: number, charCount: number): BoundedSourceChapter {
  const unit = 'hello world this is a test chapter body. '; // ~40 chars
  const repeats = Math.max(1, Math.ceil(charCount / unit.length));
  return makeChapter(
    id,
    `Chapter ${id}`,
    unit.repeat(repeats).slice(0, charCount),
  );
}

describe('planAdaptiveBatching', () => {
  it('packs a small 10-chapter book into a handful of batches for a large window', () => {
    const chapters = Array.from({ length: 10 }, (_, i) =>
      cjkChapter(i + 1, 800),
    );
    const plan = planAdaptiveBatching({
      chapters,
      profile: 'deep',
      providerType: 'openai_compatible',
      contextWindow: 128_000,
      maxOutputTokens: 8_000,
    });
    expect(plan.ok).toBe(true);
    // 10 chapters × ~800 chars ≈ 500–800 tokens each; the 30% source-chunk
    // target (~38K tokens for a 128K window) absorbs them all into one batch.
    expect(plan.estimatedBatchCount).toBeGreaterThanOrEqual(1);
    expect(plan.estimatedBatchCount).toBeLessThanOrEqual(10);
    expect(plan.effectiveInputBudget).toBeGreaterThan(30_000);
    const normals = plan.batches.filter(b => b.type === 'normal');
    expect(normals.length).toBe(plan.estimatedBatchCount);
  });

  it('derives batch count from the configured window: bigger window → fewer batches', () => {
    const chapters = Array.from({ length: 50 }, (_, i) =>
      cjkChapter(i + 1, 2000),
    );
    const smallWindow = planAdaptiveBatching({
      chapters,
      profile: 'deep',
      providerType: 'openai_compatible',
      contextWindow: 8_000,
      maxOutputTokens: 2_000,
    });
    const largeWindow = planAdaptiveBatching({
      chapters,
      profile: 'deep',
      providerType: 'openai_compatible',
      contextWindow: 128_000,
      maxOutputTokens: 2_000,
    });
    expect(smallWindow.ok).toBe(true);
    expect(largeWindow.ok).toBe(true);
    expect(smallWindow.estimatedBatchCount).toBeGreaterThan(
      largeWindow.estimatedBatchCount,
    );
  });

  it('covers every chapter exactly once across normal batches', () => {
    const chapters = Array.from({ length: 23 }, (_, i) =>
      cjkChapter(i + 1, 1000),
    );
    const plan = planAdaptiveBatching({
      chapters,
      profile: 'deep',
      providerType: 'openai_compatible',
      contextWindow: 32_000,
      maxOutputTokens: 4_000,
    });
    expect(plan.ok).toBe(true);
    const ids = new Set<number>();
    for (const batch of plan.batches) {
      if (batch.type === 'normal') {
        for (const c of batch.chapters) ids.add(c.id);
      }
    }
    expect(ids.size).toBe(23);
  });

  it('does not create batches solely because a source has many short chapters', () => {
    const chapters = Array.from({ length: 1_000 }, (_, i) =>
      cjkChapter(i + 1, 200),
    );
    const plan = planAdaptiveBatching({
      chapters,
      profile: 'deep',
      providerType: 'openai_compatible',
      contextWindow: 1_000_000,
      maxOutputTokens: 8_000,
    });
    expect(plan.ok).toBe(true);
    // ~200K CJK tokens fit under the ~790K derived input budget. Chapter
    // boundaries remain in the batch for provenance but cannot force 50 calls.
    expect(plan.estimatedBatchCount).toBe(1);
    expect(plan.batches[0]).toMatchObject({ type: 'normal' });
    if (plan.batches[0]?.type === 'normal') {
      expect(plan.batches[0].chapters).toHaveLength(1_000);
    }
  });

  it('splits a single oversized 100K-char chapter into chunk batches instead of refusing', () => {
    const giant = cjkChapter(1, 100_000);
    const plan = planAdaptiveBatching({
      chapters: [giant],
      profile: 'deep',
      providerType: 'openai_compatible',
      contextWindow: 8_000,
      maxOutputTokens: 2_000,
    });
    expect(plan.ok).toBe(true);
    expect(plan.batches.length).toBeGreaterThan(1);
    const chunkBatches = plan.batches.filter(b => b.type === 'chunk');
    expect(chunkBatches.length).toBe(plan.batches.length);
    // Chunks must tile the whole chapter without gaps.
    const chunk = chunkBatches[0] as Extract<
      (typeof chunkBatches)[number],
      { type: 'chunk' }
    >;
    expect(chunk.chunkStartChar).toBe(0);
    const lastChunk = chunkBatches[chunkBatches.length - 1] as Extract<
      (typeof chunkBatches)[number],
      { type: 'chunk' }
    >;
    expect(lastChunk.chunkEndChar).toBe(100_000);
    expect(chunk.chunkCount).toBe(chunkBatches.length);
  });

  it('chunk char size is derived from the input budget, not hardcoded', () => {
    const smallBudget = resolveChapterTextLimitFromBudget(4_000);
    const largeBudget = resolveChapterTextLimitFromBudget(100_000);
    expect(smallBudget).toBeLessThan(largeBudget);
    // A 4K budget cannot yield a 24K-char chunk (the old hardcoded limit).
    expect(smallBudget).toBeLessThan(24_000);
  });

  it('refuses with a friendly, actionable message when max_output_tokens leaves no input budget', () => {
    const chapters = [cjkChapter(1, 500)];
    const plan = planAdaptiveBatching({
      chapters,
      profile: 'deep',
      providerType: 'openai_compatible',
      contextWindow: 2_000,
      maxOutputTokens: 2_000,
    });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain('max_output_tokens');
    expect(plan.reason).toContain('context_window');
    expect(plan.suggestedMaxOutputTokens).toBeDefined();
    expect(plan.suggestedContextWindow).toBeDefined();
  });

  it('keeps the full configured max_output_tokens as the output reserve (no 25% share)', () => {
    const chapters = [cjkChapter(1, 200)];
    const plan = planAdaptiveBatching({
      chapters,
      profile: 'deep',
      providerType: 'openai_compatible',
      contextWindow: 32_000,
      maxOutputTokens: 12_345,
    });
    expect(plan.ok).toBe(true);
    // Output reserve == full configured max_output_tokens; never a 25% share.
    expect(plan.outputReserve).toBe(12_345);
    // Source-chunk target = 30% of the declared window, bounded by protocol
    // compat (window - output - overhead).
    const rawTarget = Math.floor(32_000 * SOURCE_CHUNK_RATIO_NORMAL);
    const protocolLimit = Math.max(
      0,
      32_000 - 12_345 - plan.promptOverhead,
    );
    expect(plan.targetInputBudget).toBe(Math.min(rawTarget, protocolLimit));
    expect(plan.effectiveInputBudget).toBe(plan.targetInputBudget);
  });

  it('uses a 30% source-chunk target of a huge advertised model context window and keeps full output', () => {
    const chapters = Array.from({ length: 4 }, (_, i) =>
      cjkChapter(i + 1, 300_000),
    );
    const plan = planAdaptiveBatching({
      chapters,
      profile: 'deep',
      providerType: 'openai_compatible',
      contextWindow: 1_000_000,
      maxOutputTokens: 200_000,
    });

    expect(plan.ok).toBe(true);
    // Full configured output preserved — never compressed to 25% of anything.
    expect(plan.outputReserve).toBe(200_000);
    // Source-chunk target = 30% of the declared window. No 80% utilization,
    // no 60% large-context fill ratio.
    const expectedTarget = Math.floor(1_000_000 * SOURCE_CHUNK_RATIO_NORMAL);
    expect(plan.targetInputBudget).toBe(expectedTarget);
    expect(plan.effectiveInputBudget).toBe(expectedTarget);
    expect(plan.retryOutputCeiling).toBe(plan.outputReserve);
  });

  it('keeps the full configured output as the retry ceiling (no 64K Canon cap)', () => {
    const plan = planAdaptiveBatching({
      chapters: [cjkChapter(1, 1_000)],
      profile: 'deep',
      providerType: 'openai_compatible',
      contextWindow: 1_000_000,
      maxOutputTokens: 8_000,
    });
    expect(plan.ok).toBe(true);
    // retryOutputCeiling equals the full configured output; there is no
    // Canon-specific 64K ceiling anymore.
    expect(plan.retryOutputCeiling).toBe(8_000);
    // The exported constant is now Infinity (a no-op sentinel), confirming no
    // internal output cap is applied.
    expect(CANON_REASONING_RETRY_OUTPUT_CEILING).toBe(Number.POSITIVE_INFINITY);
  });

  it('uses the 30% source-chunk target for oversized chapter chunks', () => {
    const plan = planAdaptiveBatching({
      chapters: [cjkChapter(1, 700_000)],
      profile: 'deep',
      providerType: 'openai_compatible',
      contextWindow: 1_000_000,
      maxOutputTokens: 8_000,
    });
    expect(plan.ok).toBe(true);
    expect(plan.batches.every(batch => batch.type === 'chunk')).toBe(true);
    const chunk = plan.batches[0] as Extract<
      (typeof plan.batches)[number],
      { type: 'chunk' }
    >;
    // Dense CJK must be sliced below the 30% source-chunk target (~300K tokens
    // → well under 600K chars at the CJK token ratio).
    expect(chunk.chunkEndChar).toBeLessThan(600_000);
  });

  it('fails closed when context_window is not declared', () => {
    const chapters = [cjkChapter(1, 200)];
    const plan = planAdaptiveBatching({
      chapters,
      profile: 'deep',
      providerType: 'openai_compatible',
      contextWindow: null,
      maxOutputTokens: 4_096,
    });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain('context_window');
    expect(plan.effectiveInputBudget).toBe(0);
  });
});

describe('estimateChapterTokens / estimateTokensPerCharForChapter', () => {
  it('estimates more tokens for CJK-heavy than ASCII-heavy chapters', () => {
    const cjk = cjkChapter(1, 4_000);
    const ascii = asciiChapter(1, 4_000);
    expect(estimateChapterTokens(cjk)).toBeGreaterThan(
      estimateChapterTokens(ascii),
    );
  });

  it('tokens-per-char adapts to language mix', () => {
    const cjk = cjkChapter(1, 4_000);
    const ascii = asciiChapter(1, 4_000);
    expect(estimateTokensPerCharForChapter(cjk)).toBeGreaterThan(
      estimateTokensPerCharForChapter(ascii),
    );
  });
});

describe('resolveExtractionMaxTokens', () => {
  it('mirrors the configured max_output_tokens when the budget allows', () => {
    const maxTokens = resolveExtractionMaxTokens({
      profile: 'deep',
      maxOutputTokens: 10_000,
      effectiveInputBudget: 100_000,
    });
    expect(maxTokens).toBe(10_000);
  });

  it('keeps the full configured max_output_tokens even on tiny input budgets', () => {
    const maxTokens = resolveExtractionMaxTokens({
      profile: 'deep',
      maxOutputTokens: 16_000,
      effectiveInputBudget: 1_024,
    });
    // The model's configured output is sent in full; there is no 4× input
    // ceiling. The request budget / protocol compat is handled by the planner,
    // not by compressing the output.
    expect(maxTokens).toBe(16_000);
  });

  it('keeps output within the adaptive plan reserve', () => {
    const maxTokens = resolveExtractionMaxTokens({
      profile: 'deep',
      maxOutputTokens: 200_000,
      effectiveInputBudget: 600_000,
      outputReserve: 200_000,
    });

    expect(maxTokens).toBe(200_000);
  });
});

describe('precheckCanonAnalysis', () => {
  it('returns structured estimation for a valid configuration', () => {
    const chapters = Array.from({ length: 30 }, (_, i) =>
      cjkChapter(i + 1, 2_000),
    );
    const precheck = precheckCanonAnalysis({
      chapters,
      profile: 'deep',
      providerType: 'openai_compatible',
      contextWindow: 128_000,
      maxOutputTokens: 8_000,
    });
    expect(precheck.ok).toBe(true);
    expect(precheck.contextWindow).toBe(128_000);
    expect(precheck.maxOutputTokens).toBe(8_000);
    expect(precheck.targetInputBudget).toBeLessThanOrEqual(
      precheck.effectiveInputBudget,
    );
    expect(precheck.estimatedBatchCount).toBeGreaterThan(0);
    // Each batch produces 2 work items (character_state + world_plot).
    expect(precheck.estimatedWorkItemCount).toBe(
      precheck.estimatedBatchCount * 2,
    );
    expect(precheck.estimatedDurationMinutes).toBeGreaterThan(0);
  });

  it('returns suggested values when the configuration cannot analyse', () => {
    const precheck = precheckCanonAnalysis({
      chapters: [cjkChapter(1, 200)],
      profile: 'deep',
      providerType: 'openai_compatible',
      contextWindow: 1_000,
      maxOutputTokens: 1_000,
    });
    expect(precheck.ok).toBe(false);
    expect(precheck.reason).toContain('max_output_tokens');
    expect(precheck.suggestedMaxOutputTokens).toBeGreaterThan(0);
    expect(precheck.suggestedContextWindow).toBeGreaterThan(0);
    expect(precheck.estimatedBatchCount).toBe(0);
  });
});
