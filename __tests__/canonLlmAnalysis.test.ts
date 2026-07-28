jest.mock('../src/services/llm', () => ({
  callLLM: jest.fn(),
  callLLMResult: jest.fn(),
  resolveLLMRequestConfigById: jest.fn(),
}));

import {
  callLLM,
  callLLMResult,
  resolveLLMRequestConfigById,
} from '../src/services/llm';
import {
  ANALYSIS_MODE_PRESETS,
  extractWithLlm,
  extractMaterialWithLlm,
} from '../src/services/continuation/canon/canonAnalysisService';
import {
  asSourcePosition,
  asUtf16Offset,
} from '../src/services/continuation/continuationSourceRepository';

const chapter = {
  id: 7,
  sourceId: 3,
  position: asSourcePosition(0),
  title: '第一章',
  content: '林凡在青云镇拜师。',
  range: { start: asUtf16Offset(12), end: asUtf16Offset(22) },
  clippedByBoundary: false,
};

const validResult = JSON.stringify({
  schemaVersion: 1,
  worldRules: [],
  characters: [
    {
      canonicalName: '林凡',
      aliases: [],
      description: '在青云镇拜师的主角。',
      importance: 'primary',
      confidence: 0.9,
      evidence: [
        {
          chapterId: 7,
          chapterPosition: 0,
          charStart: 12,
          charEnd: 14,
          quotePreview: '林凡',
        },
      ],
    },
  ],
  relationships: [],
  plotThreads: [],
  experiences: [],
  knowledge: [],
  states: [],
  timelineEvents: [],
});

describe('Canon LLM analysis', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (resolveLLMRequestConfigById as jest.Mock).mockResolvedValue({
      id: 42,
      provider_type: 'openai_compatible',
      model_name: 'test-model',
      url: 'https://example.com/chat/completions',
      api_key: 'test',
    });
  });

  it('exposes exactly two LLM analysis modes', () => {
    expect(Object.keys(ANALYSIS_MODE_PRESETS)).toEqual([
      'fast_continuation',
      'full_canon',
    ]);
    expect(ANALYSIS_MODE_PRESETS.fast_continuation).toMatchObject({
      profile: 'standard',
      scope: { kind: 'tail', tailChapterCount: 30 },
    });
    expect(ANALYSIS_MODE_PRESETS.full_canon).toMatchObject({
      profile: 'deep',
      scope: { kind: 'full', tailChapterCount: null },
    });
  });

  it('binds Deep extraction to the captured configuration and requests structured JSON', async () => {
    (callLLM as jest.Mock).mockResolvedValue(validResult);

    const result = await extractWithLlm([chapter], 'deep', 42);

    expect(result.characters[0].canonicalName).toBe('林凡');
    expect(resolveLLMRequestConfigById).toHaveBeenCalledWith(42);
    expect(callLLM).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          content: expect.stringContaining('bodyStart=12'),
        }),
      ]),
      8000,
      expect.objectContaining({
        responseFormat: 'json_object',
        scenario: 'continuation_canon_analysis',
        requestConfig: expect.objectContaining({ id: 42 }),
      }),
    );
  });

  it('does not silently replace an LLM failure with deterministic keywords', async () => {
    (callLLM as jest.Mock).mockRejectedValue(new Error('network unavailable'));

    await expect(extractWithLlm([chapter], 'deep', 42)).rejects.toThrow(
      'network unavailable',
    );
  });

  it('keeps legacy five-family requests readable for interrupted Schema 22 tasks', async () => {
    (callLLMResult as jest.Mock).mockResolvedValue({ text: validResult });
    const outcome = await extractMaterialWithLlm(
      [chapter],
      'standard',
      42,
      'characters',
      'run-1',
      new AbortController().signal,
    );
    expect(outcome.result.characters).toHaveLength(1);
    expect(outcome.result.worldRules).toEqual([]);
    expect(callLLMResult).toHaveBeenCalledWith(
      expect.any(Array),
      5000,
      expect.objectContaining({
        queueClass: 'canon_analysis',
        taskId: 'run-1',
        responseFormat: 'json_object',
      }),
      expect.any(AbortSignal),
    );
  });

  it('extracts every character-state field in one Schema 23 request group', async () => {
    (callLLMResult as jest.Mock).mockResolvedValue({ text: validResult });

    const outcome = await extractMaterialWithLlm(
      [chapter],
      'standard',
      42,
      'character_state',
      'run-groups',
      new AbortController().signal,
    );

    expect(outcome.result.characters).toHaveLength(1);
    expect(outcome.result.worldRules).toEqual([]);
    expect((callLLMResult as jest.Mock).mock.calls[0][0][0].content).toContain(
      'relationships、experiences、knowledge、states',
    );
  });

  it('retries transient provider throttling before marking a material failed', async () => {
    jest.useFakeTimers();
    (callLLMResult as jest.Mock)
      .mockRejectedValueOnce(
        Object.assign(new Error('too many requests'), {
          code: 'provider_error',
          cause: { status: 429 },
        }),
      )
      .mockResolvedValueOnce({ text: validResult });

    const pending = extractMaterialWithLlm(
      [chapter],
      'standard',
      42,
      'characters',
      'run-retry',
      new AbortController().signal,
    );
    await jest.runAllTimersAsync();

    await expect(pending).resolves.toMatchObject({
      result: {
        characters: [expect.objectContaining({ canonicalName: '林凡' })],
      },
    });
    expect(callLLMResult).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it('retries empty or malformed model output before failing a material', async () => {
    jest.useFakeTimers();
    (callLLMResult as jest.Mock)
      .mockResolvedValueOnce({ text: '抱歉，以下是结果：' })
      .mockResolvedValueOnce({ text: '' })
      .mockResolvedValueOnce({ text: validResult });

    const pending = extractMaterialWithLlm(
      [chapter],
      'standard',
      42,
      'characters',
      'run-output-retry',
      new AbortController().signal,
    );
    await jest.runAllTimersAsync();

    await expect(pending).resolves.toMatchObject({
      result: {
        characters: [expect.objectContaining({ canonicalName: '林凡' })],
      },
    });
    expect(callLLMResult).toHaveBeenCalledTimes(3);
    expect((callLLMResult as jest.Mock).mock.calls[1][0][0].content).toContain(
      '上一轮输出无法解析或不符合 schema',
    );
    jest.useRealTimers();
  });

  it('exposes element-level field names in the prompt for grouped requests', async () => {
    (callLLMResult as jest.Mock).mockResolvedValue({ text: validResult });

    await extractMaterialWithLlm(
      [chapter],
      'standard',
      42,
      'world_plot',
      'run-prompt-spec',
      new AbortController().signal,
    );

    const prompt = (callLLMResult as jest.Mock).mock.calls[0][0][0]
      .content as string;
    // The grouped prompt must teach the model the exact field names so it does
    // not have to guess (S3 root cause). Both the array-spec and the
    // evidence-spec lines must be present.
    expect(prompt).toContain('characters(canonicalName');
    expect(prompt).toContain('relationships(sourceName');
    expect(prompt).toContain('knowledge(characterName');
    expect(prompt).toContain('evidence');
    expect(prompt).toContain('charStart');
  });

  it('triggers a stats-aware retry when received>0 but accepted=0 for a category', async () => {
    jest.useFakeTimers();
    // First attempt: characters all rejected (canonicalName missing, no alias
    // to rescue them). This is the S3 "silent wipe" failure mode.
    const allRejected = JSON.stringify({
      schemaVersion: 1,
      worldRules: [],
      characters: [
        { description: '无名字段', importance: 'primary', evidence: [] },
      ],
      relationships: [],
      plotThreads: [],
      experiences: [],
      knowledge: [],
      states: [],
      timelineEvents: [],
    });
    (callLLMResult as jest.Mock)
      .mockResolvedValueOnce({ text: allRejected })
      .mockResolvedValueOnce({ text: validResult });

    const pending = extractMaterialWithLlm(
      [chapter],
      'standard',
      42,
      'characters',
      'run-stats-retry',
      new AbortController().signal,
    );
    await jest.runAllTimersAsync();

    const outcome = await pending;
    expect(outcome.result.characters[0].canonicalName).toBe('林凡');
    expect(callLLMResult).toHaveBeenCalledTimes(2);
    // The retry instruction must carry the dropped statistics so the model
    // knows which field name it got wrong.
    const retryPrompt = (callLLMResult as jest.Mock).mock.calls[1][0][0]
      .content as string;
    expect(retryPrompt).toContain('received');
    expect(retryPrompt).toContain('accepted');
    jest.useRealTimers();
  });

  it('emits a warning string (without retrying) when some items survive but some are dropped', async () => {
    (callLLMResult as jest.Mock).mockResolvedValueOnce({
      text: JSON.stringify({
        schemaVersion: 1,
        worldRules: [],
        characters: [
          { canonicalName: '林凡', importance: 'primary', evidence: [] },
          { description: '缺名字', importance: 'primary', evidence: [] },
        ],
        relationships: [],
        plotThreads: [],
        experiences: [],
        knowledge: [],
        states: [],
        timelineEvents: [],
      }),
    });

    const outcome = await extractMaterialWithLlm(
      [chapter],
      'standard',
      42,
      'characters',
      'run-warning',
      new AbortController().signal,
    );

    expect(outcome.result.characters).toHaveLength(1);
    expect(outcome.result.characters[0].canonicalName).toBe('林凡');
    expect(outcome.warning).toEqual(
      expect.stringContaining('characters'),
    );
    expect(outcome.warning).toMatch(/dropped|丢弃/);
    expect(callLLMResult).toHaveBeenCalledTimes(1);
  });
});
