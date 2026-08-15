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
  extractPlanJson,
  parseBatchPlanFallback,
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

describe('lenient planning (user-friendly output)', () => {
  it('extracts JSON from a markdown code block with surrounding prose', () => {
    const json = extractPlanJson(
      '好的，以下是计划：\n```json\n' +
        JSON.stringify(validPlan) +
        '\n```\n希望对你有帮助',
    );
    expect(json).not.toBeNull();
    const result = parseBatchChapterPlan(
      '好的，以下是计划：\n```json\n' +
        JSON.stringify(validPlan) +
        '\n```\n希望对你有帮助',
      2,
    );
    expect(result.ok).toBe(true);
  });

  it('extracts JSON wrapped by free-form prose (first { to last })', () => {
    const result = parseBatchChapterPlan(
      `这里是规划说明。\n{"chapters": [${JSON.stringify(validPlan.chapters[0])}, ${JSON.stringify(
        validPlan.chapters[1],
      )}]}\n以上就是全部。`,
      2,
    );
    expect(result.ok).toBe(true);
  });

  it('falls back to plain chapter summaries when the model skips JSON', () => {
    const freeText = `第 1 章 晨雾中的塔楼\n学院平静的日常生活被打破。艾琳对魔法史充满好奇。\n第 2 章 深渊中的回响\n艾琳走下阶梯，发现地下回廊中的古老魔法痕迹。\n第 3 章 封印的苏醒\n封印石碑前的光芒开始流动，精灵苏醒。`;
    const result = parseBatchChapterPlan(freeText, 3);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.chapters).toHaveLength(3);
    expect(result.plan.chapters[0].title).toContain('晨雾');
    expect(result.plan.chapters[1].title).toContain('深渊');
    expect(result.plan.chapters[0].synopsis).toContain('学院平静');
    expect(result.plan.chapters[0].targetWords).toBe(3000);
  });

  it('falls back to paragraph blocks without chapter markers', () => {
    const result = parseBatchChapterPlan(
      '第一段摘要内容。\n\n第二段摘要内容。\n\n第三段摘要内容。',
      3,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.chapters).toHaveLength(3);
    expect(result.plan.chapters[2].synopsis).toContain('第三段');
  });

  it('pads missing chapters with placeholders for the user to edit', () => {
    const result = parseBatchPlanFallback('第 1 章 只有一章。\n内容。', 3);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.chapters).toHaveLength(3);
    expect(result.plan.chapters[1].synopsis).toContain('待补充');
  });
});

describe('JSON-shaped but unparseable output (regression: raw JSON must never become a synopsis)', () => {
  /** Shape captured from a real truncated planner response (finish_reason=length). */
  const truncatedJson =
    '{\n  "chapters": [\n    {\n      "ordinal": 1,\n' +
    '      "title": "第1章·灯塔之外",\n' +
    '      "synopsis": "清晨，三人来到灯塔外墙寻找旧档案馆标记。",\n' +
    '      "keyBeats": [\n        "沿灯塔外墙搜寻旧档案馆标记",\n' +
    '        "确认北塔入口保持关闭",\n        "不进入北塔内部",\n' +
    '        "将标记位置拍照存档"';

  it('fails closed on truncated JSON instead of feeding it to the lenient fallback', () => {
    const result = parseBatchChapterPlan(truncatedJson, 2);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some(e => e.includes('无法解析'))).toBe(true);
  });

  it('fails closed on truncated JSON inside a closed markdown fence', () => {
    const result = parseBatchChapterPlan(
      '```json\n' + truncatedJson + '\n```',
      2,
    );
    expect(result.ok).toBe(false);
  });

  it('still falls back for brace-free prose output', () => {
    const result = parseBatchChapterPlan(
      '第一段摘要内容。\n\n第二段摘要内容。',
      2,
    );
    expect(result.ok).toBe(true);
  });

  it('extractPlanJson repairs dangling commas after a strict-parse failure', () => {
    const json = extractPlanJson('{"chapters": [],}');
    expect(json).toEqual({ chapters: [] });
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
    const firstShot = JSON.stringify({ chapters: [validPlan.chapters[0]] }); // missing chapter
    mockCallLLMResult
      .mockResolvedValueOnce({
        text: firstShot,
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
    // Repair reuses the frozen original messages + fix instruction, and the
    // stateless API can only see its previous output if we resend it.
    const secondCall = mockCallLLMResult.mock.calls[1][0] as any[];
    const repairText = secondCall[secondCall.length - 1].content;
    expect(repairText).toContain('仅修复 JSON 结构');
    expect(repairText).toContain('必须严格等于 2');
    expect(repairText).toContain('<previous_output>');
    expect(repairText).toContain(firstShot);
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

  it('repairs a length-truncated first shot exactly once, with a truncation-aware fix instruction', async () => {
    const truncatedFirstShot =
      '{\n  "chapters": [\n    {\n      "ordinal": 1,\n      "title": "截断章",\n      "synopsis": "内容被 max_tokens 截';
    mockCallLLMResult
      .mockResolvedValueOnce({
        text: truncatedFirstShot,
        finishReason: 'length',
        inputTokens: 10,
        outputTokens: 4000,
        totalTokens: 4010,
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
    const secondCall = mockCallLLMResult.mock.calls[1][0] as any[];
    const repairText = secondCall[secondCall.length - 1].content;
    expect(repairText).toContain('截断');
    expect(repairText).toContain(truncatedFirstShot);
  });

  it('throws with a truncation hint when the repair output is still truncated', async () => {
    mockCallLLMResult.mockResolvedValue({
      text: '{"chapters": [{"ordinal": 1, "title": "截',
      finishReason: 'length',
      inputTokens: 10,
      outputTokens: 4000,
      totalTokens: 4010,
    });
    await expect(createBatchChapterPlan(baseInput)).rejects.toThrow(
      /截断/,
    );
    await expect(createBatchChapterPlan(baseInput)).rejects.toMatchObject({
      code: 'BATCH_PLAN_INVALID',
    });
  });

  it('honors the configured max_output_tokens as the wire cap (window math permitting)', async () => {
    mockCallLLMResult.mockResolvedValue({
      text: JSON.stringify(validPlan),
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    });
    await createBatchChapterPlan(baseInput);
    // beforeEach config: context_window 128000, max_output_tokens 8000.
    const [, maxTokensArg, options] = mockCallLLMResult.mock.calls[0];
    expect(maxTokensArg).toBe(8000);
    expect((options as any).max_tokens).toBe(8000);
  });

  it('keeps the 4000 reservation cap when max_output_tokens is unset', async () => {
    mockResolveLLMRequestConfig.mockResolvedValue({
      id: 1,
      context_window: 128000,
      model_name: 'm',
      provider_type: 'openai_compatible',
    });
    mockCallLLMResult.mockResolvedValue({
      text: JSON.stringify(validPlan),
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    });
    await createBatchChapterPlan(baseInput);
    const [, maxTokensArg, options] = mockCallLLMResult.mock.calls[0];
    expect(maxTokensArg).toBe(4000);
    expect((options as any).max_tokens).toBe(4000);
  });
});
