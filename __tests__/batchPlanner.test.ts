/**
 * Phase 5: batch chapter planner.
 * Covers strict validation (N=1/N=10, missing chapters, duplicate ordinals,
 * empty titles, illegal keyBeats/targetWords), elastic-budget compile
 * (mandatory summary overflow blocks with LLM call count 0), one-shot
 * structure repair, and planner hash freezing.
 */
import {
  validateBatchChapterPlan,
  parseBatchChapterPlan,
  computePlannerHash,
  normalizeEditedPlan,
  createBatchChapterPlan,
  BatchPlannerError,
} from '../src/services/multiChapterBatch/planner';
import { compileBatchPlannerRequest } from '../src/services/multiChapterBatch/plannerCompiler';

const mockCallLLMResult = jest.fn();
const mockResolveLLMRequestConfig = jest.fn();

jest.mock('../src/services/llm', () => ({
  callLLMResult: (...args: any[]) => mockCallLLMResult(...args),
  resolveLLMRequestConfig: (...args: any[]) =>
    mockResolveLLMRequestConfig(...args),
}));

const materials = {
  outlineText: '',
  recentChaptersText: '',
  charactersText: '',
  worldbookText: '',
  storyMemoryText: '',
};

const validPlan = {
  chapters: [
    {
      ordinal: 1,
      title: '第一章 启程',
      synopsis: '主角踏上旅程，遇到第一个同伴。',
      keyBeats: ['出发', '遇同伴'],
      carryIn: '',
      carryOut: '同伴的秘密',
      targetWords: 3000,
    },
    {
      ordinal: 2,
      title: '第二章 夜宿',
      synopsis: '夜宿客栈，发现追兵踪迹。',
      keyBeats: ['夜宿', '追兵'],
      carryIn: '同伴的秘密',
      carryOut: '追兵逼近',
      targetWords: 2800,
    },
  ],
};

describe('validateBatchChapterPlan', () => {
  it('accepts a valid N=2 plan', () => {
    const result = validateBatchChapterPlan(validPlan, 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.chapters).toHaveLength(2);
    expect(result.plan.chapters[0].targetWords).toBe(3000);
    expect(result.plan.chapters[1].carryIn).toBe('同伴的秘密');
  });

  it('accepts N=1 and N=10 plans', () => {
    const one = validateBatchChapterPlan(
      { chapters: [validPlan.chapters[0]] },
      1,
    );
    expect(one.ok).toBe(true);
    const ten = validateBatchChapterPlan(
      { chapters: Array.from({ length: 10 }, (_, i) => ({ ...validPlan.chapters[0], ordinal: i + 1, title: `第${i + 1}章` })) },
      10,
    );
    expect(ten.ok).toBe(true);
  });

  it('rejects a missing chapter count', () => {
    const result = validateBatchChapterPlan(validPlan, 3);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some(e => e.includes('必须严格等于 3'))).toBe(true);
  });

  it('rejects duplicate ordinals', () => {
    const result = validateBatchChapterPlan(
      { chapters: [validPlan.chapters[0], { ...validPlan.chapters[1], ordinal: 1 }] },
      2,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some(e => e.includes('ordinal 重复'))).toBe(true);
  });

  it('rejects empty titles / synopses / keyBeats and illegal targetWords', () => {
    const result = validateBatchChapterPlan(
      {
        chapters: [
          {
            ordinal: 1,
            title: '   ',
            synopsis: '',
            keyBeats: [],
            targetWords: 100,
          },
        ],
      },
      1,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some(e => e.includes('title 为空'))).toBe(true);
    expect(result.errors.some(e => e.includes('synopsis 为空'))).toBe(true);
    expect(result.errors.some(e => e.includes('keyBeats'))).toBe(true);
    expect(result.errors.some(e => e.includes('targetWords'))).toBe(true);
  });

  it('rejects non-JSON output', () => {
    const result = parseBatchChapterPlan('不是 JSON', 1);
    expect(result.ok).toBe(false);
  });
});

describe('planner hash + edited plan', () => {
  it('freezes a deterministic hash', () => {
    const hash1 = computePlannerHash(validPlan);
    const hash2 = computePlannerHash(validPlan);
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(32);
  });

  it('normalizes user-edited plans through the same validator', () => {
    const ok = normalizeEditedPlan(validPlan.chapters, 2);
    expect(ok.ok).toBe(true);
    const bad = normalizeEditedPlan(
      [validPlan.chapters[0], { ...validPlan.chapters[1], title: '' }],
      2,
    );
    expect(bad.ok).toBe(false);
  });
});

describe('planner elastic compile', () => {
  it('compiles Ready when the summary fits and blocks before any model call otherwise', () => {
    const ok = compileBatchPlannerRequest({
      sourcePrompt: '短摘要',
      chapterCount: 3,
      targetWordsPerChapter: 3000,
      pipelineMode: 'full',
      materials,
      contextWindow: 16_000,
      reservedOutputTokens: 2_000,
    });
    expect(ok.ready).toBe(true);
    if (!ok.ready) return;
    expect(ok.elasticBudgetTrace).toBeDefined();

    // 15k-token summary cannot fit C=13680 → blocked (LLM call count 0).
    const blocked = compileBatchPlannerRequest({
      sourcePrompt: '纲'.repeat(15_000),
      chapterCount: 3,
      targetWordsPerChapter: 3000,
      pipelineMode: 'full',
      materials,
      contextWindow: 16_000,
      reservedOutputTokens: 2_000,
    });
    expect(blocked.ready).toBe(false);
  });
});

describe('createBatchChapterPlan (mocked LLM)', () => {
  const baseInput = {
    projectId: 1,
    sourcePrompt: '主角寻找失落的王国，途中结识伙伴，最终揭开真相。',
    chapterCount: 2,
    targetWordsPerChapter: 3000,
    pipelineMode: 'full',
    materials,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveLLMRequestConfig.mockResolvedValue({
      id: 1,
      context_window: 128000,
      model_name: 'm',
      provider_type: 'openai_compatible',
      max_output_tokens: 8000,
    });
  });

  it('returns plan + frozen hash on first-shot valid JSON', async () => {
    mockCallLLMResult.mockResolvedValue({
      text: JSON.stringify(validPlan),
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    });
    const result = await createBatchChapterPlan(baseInput);
    expect(result.plan.chapters).toHaveLength(2);
    expect(result.hash).toBe(computePlannerHash(validPlan));
    expect(result.usedRepair).toBe(false);
    expect(mockCallLLMResult).toHaveBeenCalledTimes(1);
  });

  it('repairs invalid structure exactly once using the frozen raw output', async () => {
    mockCallLLMResult
      .mockResolvedValueOnce({
        text: JSON.stringify({ chapters: [validPlan.chapters[0]] }), // missing chapter
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
      })
      .mockResolvedValueOnce({
        text: JSON.stringify(validPlan),
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
      });
    const result = await createBatchChapterPlan(baseInput);
    expect(result.usedRepair).toBe(true);
    expect(mockCallLLMResult).toHaveBeenCalledTimes(2);
    // Repair reuses the frozen original messages + fix instruction.
    const secondCall = mockCallLLMResult.mock.calls[1][0] as any[];
    const repairText = secondCall[secondCall.length - 1].content;
    expect(repairText).toContain('仅修复 JSON 结构');
    expect(repairText).toContain('必须严格等于 2');
  });

  it('fails with BATCH_PLAN_INVALID when repair output is still invalid', async () => {
    mockCallLLMResult.mockResolvedValue({
      text: JSON.stringify({ chapters: [] }),
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    });
    await expect(createBatchChapterPlan(baseInput)).rejects.toThrow(
      BatchPlannerError,
    );
    await expect(createBatchChapterPlan(baseInput)).rejects.toMatchObject({
      code: 'BATCH_PLAN_INVALID',
    });
  });

  it('rejects invalid chapter count / empty summary before calling the model', async () => {
    await expect(
      createBatchChapterPlan({ ...baseInput, chapterCount: 0 }),
    ).rejects.toMatchObject({ code: 'BATCH_PLAN_INVALID' });
    await expect(
      createBatchChapterPlan({ ...baseInput, sourcePrompt: '   ' }),
    ).rejects.toMatchObject({ code: 'BATCH_PLAN_INVALID' });
    expect(mockCallLLMResult).not.toHaveBeenCalled();
  });
});
