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
    const result = await extractMaterialWithLlm(
      [chapter],
      'standard',
      42,
      'characters',
      'run-1',
      new AbortController().signal,
    );
    expect(result.characters).toHaveLength(1);
    expect(result.worldRules).toEqual([]);
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

    const result = await extractMaterialWithLlm(
      [chapter],
      'standard',
      42,
      'character_state',
      'run-groups',
      new AbortController().signal,
    );

    expect(result.characters).toHaveLength(1);
    expect(result.worldRules).toEqual([]);
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
      characters: [expect.objectContaining({ canonicalName: '林凡' })],
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
      characters: [expect.objectContaining({ canonicalName: '林凡' })],
    });
    expect(callLLMResult).toHaveBeenCalledTimes(3);
    expect((callLLMResult as jest.Mock).mock.calls[1][0][0].content).toContain(
      '上一轮输出无法解析或不符合 schema',
    );
    jest.useRealTimers();
  });
});
