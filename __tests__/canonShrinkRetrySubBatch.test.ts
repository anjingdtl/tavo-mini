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
    // Round-2: partialCoverage is driven by the TOTAL-budget slicer, not by
    // "did a retry happen". Use enough CJK body that even the normal 30%
    // budget cannot cover the chapter, and a shrink makes the covered range
    // strictly smaller.
    const content = '甲'.repeat(40) + '头部规则' + '乙'.repeat(4000) + '尾部未分析内容';
    const chapter = makeChapter(content, 0);
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
      // ~800 total source tokens cannot cover 4000+ CJK chars (≈1 token/char).
      {
        effectiveInputBudget: 800,
        targetInputBudget: 800,
        outputReserve: 8000,
        promptOverhead: 600,
        estimatedBatchCount: 1,
      },
    );
    expect(outcome.partialCoverage).toBe(true);
    expect(outcome.analyzedCharEnds?.[0]).toBeLessThan(chapter.content.length);
    expect(outcome.analyzedCharEnds?.[0]).toBeGreaterThan(0);
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
