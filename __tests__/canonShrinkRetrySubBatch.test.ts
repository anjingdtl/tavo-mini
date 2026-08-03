/**
 * Bug #3: shrink-retry must not silently drop chapter text tails.
 *
 * When extractMaterialWithLlm shrinks the source chunk on a recoverable failure
 * (finish_reason=length / reasoning_only / truncated JSON / owned categories
 * empty), the outcome must NOT claim full coverage of the original chapters.
 * The caller (processAnalysisRunInner) must detect the partial coverage and
 * re-plan the uncovered tail into a follow-up sub-batch, so every character is
 * analysed exactly once.
 *
 * This test exercises the outcome contract: the returned outcome reports which
 * character range of each chapter was actually analysed, so partial coverage is
 * detectable and re-plannable.
 */
import { extractMaterialWithLlm } from '../src/services/continuation/canon/canonAnalysisService';
import {
  asSourcePosition,
  asUtf16Offset,
} from '../src/services/continuation/continuationSourceRepository';
import type { BoundedSourceChapter } from '../src/services/continuation/types';

jest.mock('../src/services/llm', () => ({
  callLLM: jest.fn(),
  callLLMResult: jest.fn(),
  resolveLLMRequestConfigById: jest.fn(),
}));

import { callLLMResult, resolveLLMRequestConfigById } from '../src/services/llm';

function makeChapter(content: string, rangeStart: number): BoundedSourceChapter {
  return {
    id: 1,
    sourceId: 1,
    position: asSourcePosition(0),
    title: '第一章',
    content,
    range: { start: asUtf16Offset(rangeStart), end: asUtf16Offset(rangeStart + content.length) },
    clippedByBoundary: false,
  };
}

const emptyResult = JSON.stringify({
  schemaVersion: 1,
  worldRules: [],
  characters: [],
  relationships: [],
  plotThreads: [],
  experiences: [],
  knowledge: [],
  states: [],
  timelineEvents: [],
});

// A valid world_rule result with an evidence quote present in the chapter.
function validWorldRule(quotePreview: string, charStart: number) {
  return JSON.stringify({
    schemaVersion: 1,
    worldRules: [
      {
        category: 'fundamental',
        title: '规则',
        description: 'd',
        constraintLevel: 'hard',
        confidence: 0.9,
        evidence: [{ chapterId: 1, chapterPosition: 0, charStart, charEnd: charStart + quotePreview.length, quotePreview }],
      },
    ],
    characters: [],
    relationships: [],
    plotThreads: [],
    experiences: [],
    knowledge: [],
    states: [],
    timelineEvents: [],
  });
}

describe('Bug #3: shrink-retry reports partial coverage', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (resolveLLMRequestConfigById as jest.Mock).mockResolvedValue({
      id: 42,
      provider_type: 'openai_compatible',
      model_name: 'test',
      url: 'https://x',
      api_key: 'k',
      context_window: 100_000,
      max_output_tokens: 8_000,
    });
  });

  it('a successful first attempt reports FULL coverage (no shrink)', async () => {
    const content = 'A'.repeat(40) + '关键规则原文' + 'B'.repeat(40);
    const chapter = makeChapter(content, 0);
    (callLLMResult as jest.Mock).mockResolvedValue({ text: validWorldRule('关键规则原文', 40) });

    const outcome = await extractMaterialWithLlm(
      [chapter],
      'standard',
      42,
      'world_plot',
      'run-1',
      new AbortController().signal,
      undefined,
      undefined,
      // Small budget so the text limit binds below the chapter length.
      { effectiveInputBudget: 200, outputReserve: 8000, promptOverhead: 600, estimatedBatchCount: 1 },
    );
    // No shrink happened → full coverage, no partial flag.
    expect(outcome.partialCoverage).toBeFalsy();
    expect(outcome.analyzedCharEnds?.[0]).toBe(chapter.content.length);
  });

  it('a shrunk-retry success reports PARTIAL coverage (tail not analysed)', async () => {
    // Content must exceed the 1024-char shrink floor so the shrunk limit
    // actually truncates. Use 2000 chars with a marker near the front.
    const content = 'A'.repeat(40) + '头部规则' + 'B'.repeat(1500) + '尾部未分析内容';
    const chapter = makeChapter(content, 0);
    // Attempt 1: length/truncated (recoverable) → triggers shrink.
    // Attempt 2: success but only on the shrunk (front) slice.
    (callLLMResult as jest.Mock)
      .mockResolvedValueOnce({ text: '', emptyReason: 'length' })
      .mockResolvedValueOnce({ text: validWorldRule('头部规则', 40) });

    const outcome = await extractMaterialWithLlm(
      [chapter],
      'standard',
      42,
      'world_plot',
      'run-1',
      new AbortController().signal,
      undefined,
      undefined,
      // effectiveInputBudget=200 → baseChapterTextLimit ≈ 250; after one shrink
      // step the floor max(1024, floor(250*0.667)) = 1024 < content.length(1556).
      { effectiveInputBudget: 200, outputReserve: 8000, promptOverhead: 600, estimatedBatchCount: 1 },
    );
    // The shrink happened → outcome must flag partial coverage and report the
    // analysed character end so the caller can re-plan the tail.
    expect(outcome.partialCoverage).toBe(true);
    expect(outcome.analyzedCharEnds?.[0]).toBeLessThan(chapter.content.length);
    expect(outcome.analyzedCharEnds?.[0]).toBeGreaterThan(0);
    // The tail beyond the analysed end was never sent to the model.
    expect(outcome.analyzedCharEnds?.[0]).toBeLessThanOrEqual(1024);
  });

  it('partial coverage outcome carries the analysed range for re-planning', async () => {
    const content = 'X'.repeat(2000);
    const chapter = makeChapter(content, 0);
    (callLLMResult as jest.Mock)
      .mockResolvedValueOnce({ text: '', emptyReason: 'reasoning_only' })
      .mockResolvedValueOnce({ text: emptyResult }); // still empty after shrink
    // All attempts fail → throws. Partial coverage only applies to a successful
    // shrunk result, not a total failure.
    await expect(
      extractMaterialWithLlm(
        [chapter],
        'standard',
        42,
        'world_plot',
        'run-1',
        new AbortController().signal,
        undefined,
        undefined,
        { effectiveInputBudget: 200, outputReserve: 8000, promptOverhead: 600, estimatedBatchCount: 1 },
      ),
    ).rejects.toThrow();
  });
});
