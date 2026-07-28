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
  resolveExtractionEvidenceAgainstChapters,
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
      16384,
      expect.objectContaining({
        queueClass: 'canon_analysis',
        taskId: 'run-1',
        responseFormat: 'json_object',
      }),
      expect.any(AbortSignal),
    );
    expect((callLLMResult as jest.Mock).mock.calls[0][2].thinking).toBeUndefined();
  });

  it('uses complete chapter text when the selected online model declares a large context window', async () => {
    (resolveLLMRequestConfigById as jest.Mock).mockResolvedValue({
      id: 42,
      provider_type: 'openai_compatible',
      model_name: 'test-model',
      url: 'https://example.com/chat/completions',
      api_key: 'test',
      context_window: 1_000_000,
      max_output_tokens: 200_000,
    });
    (callLLMResult as jest.Mock).mockResolvedValue({ text: validResult });
    const longChapter = {
      ...chapter,
      content: `开头林凡${'中'.repeat(6_500)}结尾事实`,
    };

    await extractMaterialWithLlm(
      [longChapter],
      'standard',
      42,
      'characters',
      'run-full-context',
      new AbortController().signal,
    );

    expect((callLLMResult as jest.Mock).mock.calls[0][0][0].content).toContain(
      '结尾事实',
    );
  });

  it('re-locates quoted evidence against the supplied source and drops invented quotes', () => {
    const result = {
      schemaVersion: 1 as const,
      worldRules: [],
      characters: [
        {
          canonicalName: '林凡', aliases: [], description: '主角。',
          importance: 'primary' as const, confidence: 0.9,
          evidence: [
            { chapterId: 999, chapterPosition: 9, charStart: 1, charEnd: 2, quotePreview: '林凡' },
            { chapterId: 7, chapterPosition: 0, charStart: 12, charEnd: 14, quotePreview: '不存在的引文' },
          ],
        },
      ],
      relationships: [], plotThreads: [], experiences: [], knowledge: [], states: [], timelineEvents: [],
    };

    const resolved = resolveExtractionEvidenceAgainstChapters(result, [chapter]);

    expect(resolved.stats).toEqual({ received: 2, resolved: 1, rejected: 1 });
    expect(resolved.result.characters[0].evidence).toEqual([
      expect.objectContaining({
        chapterId: 7,
        chapterPosition: 0,
        charStart: 12,
        charEnd: 14,
        quotePreview: '林凡',
      }),
    ]);
  });

  it('accepts a close paraphrase only by storing the matched original excerpt as evidence', () => {
    const sourceChapter = {
      ...chapter,
      content: '我和你一起去丽江旅行过。',
    };
    const result = {
      schemaVersion: 1 as const,
      worldRules: [],
      characters: [
        {
          canonicalName: '林凡', aliases: [], description: '有旅行经历。',
          importance: 'primary' as const, confidence: 0.8,
          evidence: [{ chapterId: 7, chapterPosition: 0, charStart: 12, charEnd: 19, quotePreview: '我和你去过丽江' }],
        },
      ],
      relationships: [], plotThreads: [], experiences: [], knowledge: [], states: [], timelineEvents: [],
    };

    const resolved = resolveExtractionEvidenceAgainstChapters(result, [sourceChapter]);

    expect(resolved.result.characters[0].evidence).toEqual([
      expect.objectContaining({
        quotePreview: '我和你一起去丽江旅行过。',
        charStart: 12,
        charEnd: 24,
      }),
    ]);
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
    expect(retryPrompt).toContain('characters(canonicalName,aliases');
    expect(retryPrompt).not.toContain('详见下方规范');
    jest.useRealTimers();
  });

  it('returns a redacted structural diagnostic after every retry rejects a category', async () => {
    jest.useFakeTimers();
    const allRejected = JSON.stringify({
      schemaVersion: 1,
      worldRules: [],
      characters: [
        {
          display_name: '不应持久化的角色名',
          secret: '不应持久化的值',
          evidence: [{ quotePreview: '不应持久化的原著片段' }],
        },
      ],
      relationships: [],
      plotThreads: [],
      experiences: [],
      knowledge: [],
      states: [],
      timelineEvents: [],
    });
    (callLLMResult as jest.Mock).mockResolvedValue({ text: allRejected });

    const pending = extractMaterialWithLlm(
      [chapter],
      'standard',
      42,
      'characters',
      'run-redacted-diagnostic',
      new AbortController().signal,
    );
    const capturedError = pending.catch(reason => reason);
    await jest.runAllTimersAsync();

    const error = await capturedError;
    const diagnostic = (error as { diagnostic?: unknown }).diagnostic;
    expect(diagnostic).toEqual(
      expect.objectContaining({
        diagnosticVersion: 1,
        kind: 'canon_extraction_validation_failure',
        attempts: expect.arrayContaining([
          expect.objectContaining({
            responseLength: allRejected.length,
            categories: expect.objectContaining({
              characters: expect.objectContaining({
                received: 1,
                accepted: 0,
                dropped: 1,
                sampleKeySets: [['display_name', 'evidence', 'secret']],
              }),
            }),
          }),
        ]),
      }),
    );
    expect(JSON.stringify(diagnostic)).not.toContain('不应持久化的角色名');
    expect(JSON.stringify(diagnostic)).not.toContain('不应持久化的值');
    expect(JSON.stringify(diagnostic)).not.toContain('不应持久化的原著片段');
    jest.useRealTimers();
  });

  it('emits a warning string (without retrying) when some items survive but some are dropped', async () => {
    (callLLMResult as jest.Mock).mockResolvedValueOnce({
      text: JSON.stringify({
        schemaVersion: 1,
        worldRules: [],
        characters: [
          {
            canonicalName: '林凡',
            importance: 'primary',
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

  describe('S1: empty-response classification and adaptive retry', () => {
    it('raises a length-specific message and doubles max_tokens on retry when finish_reason=length', async () => {
      jest.useFakeTimers();
      (callLLMResult as jest.Mock)
        .mockResolvedValueOnce({
          text: null,
          emptyReason: 'length',
          finishReason: 'length',
        })
        .mockResolvedValueOnce({ text: validResult });

      const pending = extractMaterialWithLlm(
        [chapter],
        'standard',
        42,
        'characters',
        'run-length',
        new AbortController().signal,
      );
      await jest.runAllTimersAsync();
      const outcome = await pending;

      expect(outcome.result.characters[0].canonicalName).toBe('林凡');
      expect(callLLMResult).toHaveBeenCalledTimes(2);
      // Thinking remains enabled, so Canon reserves a larger completion floor.
      const firstMaxTokens = (callLLMResult as jest.Mock).mock.calls[0][1];
      const secondMaxTokens = (callLLMResult as jest.Mock).mock.calls[1][1];
      expect(firstMaxTokens).toBe(16384);
      expect(secondMaxTokens).toBe(16384 * 2);
      jest.useRealTimers();
    });

    it('raises a reasoning-only message and doubles max_tokens when reasoning_content filled the budget', async () => {
      jest.useFakeTimers();
      (callLLMResult as jest.Mock)
        .mockResolvedValueOnce({
          text: null,
          emptyReason: 'reasoning_only',
          reasoningText: '推理内容',
          finishReason: 'length',
        })
        .mockResolvedValueOnce({ text: validResult });

      const pending = extractMaterialWithLlm(
        [chapter],
        'standard',
        42,
        'characters',
        'run-reasoning',
        new AbortController().signal,
      );
      await jest.runAllTimersAsync();
      const outcome = await pending;

      expect(outcome.result.characters[0].canonicalName).toBe('林凡');
      const firstMaxTokens = (callLLMResult as jest.Mock).mock.calls[0][1];
      const secondMaxTokens = (callLLMResult as jest.Mock).mock.calls[1][1];
      expect(firstMaxTokens).toBe(16384);
      expect(secondMaxTokens).toBe(16384 * 2);
      jest.useRealTimers();
    });

    it('uses a 32768 baseline for the deep profile and doubles on length retry', async () => {
      jest.useFakeTimers();
      (callLLMResult as jest.Mock)
        .mockResolvedValueOnce({
          text: null,
          emptyReason: 'length',
          finishReason: 'length',
        })
        .mockResolvedValueOnce({ text: validResult });

      const pending = extractMaterialWithLlm(
        [chapter],
        'deep',
        42,
        'characters',
        'run-deep-length',
        new AbortController().signal,
      );
      await jest.runAllTimersAsync();
      await pending;

      expect((callLLMResult as jest.Mock).mock.calls[0][1]).toBe(32768);
      expect((callLLMResult as jest.Mock).mock.calls[1][1]).toBe(32768 * 2);
      jest.useRealTimers();
    });

    it('surfaces the real gateway error (no empty-reason spin) when the provider throws', async () => {
      const gatewayError = Object.assign(
        new Error('API 请求失败 (200, unsupported_parameter): response_format 不被支持'),
        { code: 'unsupported_parameter', status: 200 },
      );
      (callLLMResult as jest.Mock).mockRejectedValue(gatewayError);

      await expect(
        extractMaterialWithLlm(
          [chapter],
          'standard',
          42,
          'characters',
          'run-gateway-error',
          new AbortController().signal,
        ),
      ).rejects.toThrow(/unsupported_parameter|response_format/);
      // No retry: a 200-with-error-body is not transient.
      expect(callLLMResult).toHaveBeenCalledTimes(1);
    });

    it('attaches a redacted diagnostic footer with finishReason to the final failure message', async () => {
      jest.useFakeTimers();
      (callLLMResult as jest.Mock).mockResolvedValue({
        text: null,
        emptyReason: 'length',
        finishReason: 'length',
      });

      const pending = extractMaterialWithLlm(
        [chapter],
        'standard',
        42,
        'characters',
        'run-length-exhausted',
        new AbortController().signal,
      );
      // Attach a catch so the rejected promise does not become an unhandled
      // rejection while fake timers stall the retry backoff.
      pending.catch(() => {});
      await jest.runAllTimersAsync();

      await expect(pending).rejects.toThrow(
        /finishReason=length|max_tokens|截断/,
      );
      jest.useRealTimers();
    });

    it('never includes reasoning or prompt-like text in a final failure message', async () => {
      jest.useFakeTimers();
      const echoedPrompt = '章节正文：这是不应出现在错误信息中的小说原文';
      (callLLMResult as jest.Mock).mockResolvedValue({
        text: null,
        emptyReason: 'reasoning_only',
        finishReason: 'length',
        reasoningText: echoedPrompt,
      });

      const pending = extractMaterialWithLlm(
        [chapter],
        'standard',
        42,
        'characters',
        'run-redacted-reasoning',
        new AbortController().signal,
      );
      pending.catch(() => {});
      await jest.runAllTimersAsync();

      await expect(pending).rejects.not.toThrow(echoedPrompt);
      await expect(pending).rejects.not.toThrow(/响应前 200 字符/);
      jest.useRealTimers();
    });
  });
});
