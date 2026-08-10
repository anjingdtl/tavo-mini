const mockCallLLMResult = jest.fn();
const mockGetActiveLLMConfig = jest.fn();

jest.mock('../src/services/llm', () => ({
  callLLMResult: (...args: unknown[]) => mockCallLLMResult(...args),
}));

jest.mock('../src/services/database', () => ({
  getActiveLLMConfig: (...args: unknown[]) => mockGetActiveLLMConfig(...args),
}));

import {
  createEmptyChapterMemoryPatch,
  createEmptyStoryMemory,
} from '../src/services/storyMemory/storyMemoryDefaults';
import {
  generateValidatedChapterMemoryPatch,
  parseAndValidateMemoryPatch,
} from '../src/services/storyMemory/storyMemoryService';

const chapter = {
  id: 1,
  project_id: 7,
  position: 0,
  title: '第一章',
  synopsis: '',
  content: '雨夜里，林岚推开钟楼暗门。',
  status: 'final' as const,
  summary_json: null,
  created_at: '',
  updated_at: '',
};

function validOutput(): string {
  return JSON.stringify(
    createEmptyChapterMemoryPatch({
      chapterId: 1,
      chapterPosition: 0,
      title: '第一章',
    }),
  );
}

function response(text: string | null) {
  return { text, inputTokens: 10, outputTokens: 10, totalTokens: 20 };
}

describe('story memory LLM patch service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCallLLMResult.mockReset();
    mockGetActiveLLMConfig.mockReset();
    // 默认大模型能力：主路径使用 Budget V5 的弹性 reservation。
    mockGetActiveLLMConfig.mockResolvedValue({
      id: 1,
      model_name: 'test-model',
      context_window: 131072,
      max_output_tokens: 65536,
    });
  });

  it('parses valid JSON and Markdown fenced JSON', () => {
    const state = createEmptyStoryMemory(7);
    expect(
      parseAndValidateMemoryPatch(validOutput(), state, chapter.content),
    ).toEqual(expect.objectContaining({ schemaVersion: 1 }));
    expect(
      parseAndValidateMemoryPatch(
        `\`\`\`json\n${validOutput()}\n\`\`\``,
        state,
        chapter.content,
      ),
    ).toEqual(expect.objectContaining({ schemaVersion: 1 }));
  });

  it('repairs invalid JSON exactly once', async () => {
    mockCallLLMResult
      .mockResolvedValueOnce(response('{bad'))
      .mockResolvedValueOnce(response(validOutput()));
    await expect(
      generateValidatedChapterMemoryPatch({
        chapter,
        previousState: createEmptyStoryMemory(7),
        memoryPatchMaxTokens: 1200,
      }),
    ).resolves.toEqual(expect.objectContaining({ schemaVersion: 1 }));
    expect(mockCallLLMResult).toHaveBeenCalledTimes(2);
    expect(mockCallLLMResult.mock.calls[1][2]).toEqual(
      expect.objectContaining({
        scenario: 'story_memory_patch_repair',
        responseFormat: 'json_object',
      }),
    );
    expect(mockCallLLMResult.mock.calls[0][1]).toBe(26214);
    expect(mockCallLLMResult.mock.calls[1][1]).toBe(26214);
  });

  it('does not silently retry a total-timeout outcome whose HTTP result is unknown', async () => {
    mockCallLLMResult
      .mockRejectedValueOnce(
        Object.assign(new Error('请求超时'), { code: 'total_timeout' }),
      )
      .mockResolvedValueOnce(response(validOutput()));

    await expect(
      generateValidatedChapterMemoryPatch({
        chapter,
        previousState: createEmptyStoryMemory(7),
        memoryPatchMaxTokens: 3200,
      }),
    ).rejects.toThrow('请求超时');
    expect(mockCallLLMResult).toHaveBeenCalledTimes(1);
  });

  it('repairs missing evidence and unknown entity references', async () => {
    const invalid = createEmptyChapterMemoryPatch({
      chapterId: 1,
      chapterPosition: 0,
      title: '第一章',
    });
    invalid.newCharacters.push({
      tempRef: 'new_char_1',
      canonicalName: '林岚',
      aliases: [],
      role: '',
      identity: '',
      stableTraits: [],
      initialState: {},
      status: 'active',
      evidenceQuote: '正文里没有这句话',
    });
    mockCallLLMResult
      .mockResolvedValueOnce(response(JSON.stringify(invalid)))
      .mockResolvedValueOnce(response(validOutput()));
    await expect(
      generateValidatedChapterMemoryPatch({
        chapter,
        previousState: createEmptyStoryMemory(7),
        memoryPatchMaxTokens: 1200,
      }),
    ).resolves.toBeTruthy();
    expect(mockCallLLMResult).toHaveBeenCalledTimes(2);
  });

  it('grounds a repeated paraphrased evidence quote after model repair is exhausted', async () => {
    const invalid = createEmptyChapterMemoryPatch({
      chapterId: 1,
      chapterPosition: 0,
      title: '第一章',
    });
    invalid.newCharacters.push({
      tempRef: 'new_char_世恒',
      canonicalName: '世恒',
      aliases: [],
      role: '联系人',
      identity: '',
      stableTraits: [],
      initialState: {},
      status: 'active',
      evidenceQuote: '世恒联系好了他的两个好朋友，李毅和周志豪。',
    });
    const modelOutput = JSON.stringify(invalid);
    mockCallLLMResult.mockResolvedValue({
      ...response(modelOutput),
      finishReason: 'stop',
    });

    const result = await generateValidatedChapterMemoryPatch({
      chapter: {
        ...chapter,
        content: '世恒联系好了他的秘密联系人，李毅与周志豪。',
      },
      previousState: createEmptyStoryMemory(7),
      memoryPatchMaxTokens: 1200,
    });

    expect(result.newCharacters[0].evidenceQuote).toBe(
      '世恒联系好了他的秘密联系人，李毅与周志豪。',
    );
    expect(mockCallLLMResult).toHaveBeenCalledTimes(3);
  });

  it('normalizes duplicate new-character refs without consuming a repair call', async () => {
    const twoPersonChapter = {
      ...chapter,
      content: '石璐和世恒是同事。石璐推了推金丝眼镜，世恒递给她一杯热咖啡。',
    };
    const patch = createEmptyChapterMemoryPatch({
      chapterId: 1,
      chapterPosition: 0,
      title: '第一章',
    });
    patch.newCharacters.push(
      {
        tempRef: 'new_char_人物',
        canonicalName: '石璐',
        aliases: [],
        role: '编辑',
        identity: '',
        stableTraits: [],
        initialState: {},
        status: 'active',
        evidenceQuote: '石璐推了推金丝眼镜',
      },
      {
        tempRef: 'new_char_人物',
        canonicalName: '世恒',
        aliases: [],
        role: '编辑',
        identity: '',
        stableTraits: [],
        initialState: {},
        status: 'active',
        evidenceQuote: '世恒递给她一杯热咖啡',
      },
    );
    patch.newRelationships.push({
      tempRef: 'new_rel_同事',
      fromRef: 'new_char_人物',
      toRef: 'new_char_人物',
      direction: 'bidirectional',
      relationType: '同事',
      currentState: '共同加班',
      trustLevel: 'medium',
      publicStatus: '同事',
      hiddenStatus: '',
      reason: '长期搭档',
      evidenceQuote: '石璐和世恒是同事',
    });
    mockCallLLMResult.mockResolvedValueOnce(response(JSON.stringify(patch)));

    const result = await generateValidatedChapterMemoryPatch({
      chapter: twoPersonChapter,
      previousState: createEmptyStoryMemory(7),
      memoryPatchMaxTokens: 1200,
    });
    expect(result.newCharacters.map(item => item.tempRef)).toEqual([
      'new_char_石璐',
      'new_char_世恒',
    ]);
    expect(result.newRelationships[0]).toEqual(
      expect.objectContaining({
        fromRef: 'new_char_石璐',
        toRef: 'new_char_世恒',
      }),
    );
    expect(mockCallLLMResult).toHaveBeenCalledTimes(1);
  });

  it('retries from scratch with a larger budget after two truncated JSON responses', async () => {
    mockCallLLMResult
      .mockResolvedValueOnce({
        ...response('{"schemaVersion":1'),
        finishReason: 'length',
      })
      .mockResolvedValueOnce({
        ...response('{still bad'),
        finishReason: 'length',
      })
      .mockResolvedValueOnce(response(validOutput()));
    await expect(
      generateValidatedChapterMemoryPatch({
        chapter,
        previousState: createEmptyStoryMemory(7),
        memoryPatchMaxTokens: 800,
      }),
    ).resolves.toEqual(expect.objectContaining({ schemaVersion: 1 }));
    expect(mockCallLLMResult).toHaveBeenCalledTimes(3);
    expect(mockCallLLMResult.mock.calls.map(call => call[1])).toEqual([
      26214, 26214, 26214,
    ]);
    expect(mockCallLLMResult.mock.calls[2][2]).toEqual(
      expect.objectContaining({ scenario: 'story_memory_patch_retry' }),
    );
    expect(mockCallLLMResult.mock.calls[2][0]).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ role: 'assistant' })]),
    );
  });

  it('reports the expanded output limit when all JSON responses are truncated', async () => {
    mockCallLLMResult.mockResolvedValue({
      ...response('{"schemaVersion":1'),
      finishReason: 'length',
    });
    await expect(
      generateValidatedChapterMemoryPatch({
        chapter,
        previousState: createEmptyStoryMemory(7),
        memoryPatchMaxTokens: 4000,
      }),
    ).rejects.toThrow('输出 reservation 为 26214 tokens');
    expect(mockCallLLMResult.mock.calls.map(call => call[1])).toEqual([
      26214, 26214, 26214,
    ]);
  });

  it('boundedly retries empty output then fails with actionable diagnostic', async () => {
    // Empty business body (no emptyReason classification) must enter the
    // bounded recovery flow instead of throwing on the first attempt.
    mockCallLLMResult.mockResolvedValue(response(null));
    await expect(
      generateValidatedChapterMemoryPatch({
        chapter,
        previousState: createEmptyStoryMemory(7),
        memoryPatchMaxTokens: 800,
      }),
    ).rejects.toThrow('模型连续没有返回任何输出');
    expect(mockCallLLMResult).toHaveBeenCalledTimes(3);

    const controller = new AbortController();
    controller.abort();
    await expect(
      generateValidatedChapterMemoryPatch({
        chapter,
        previousState: createEmptyStoryMemory(7),
        memoryPatchMaxTokens: 800,
        signal: controller.signal,
      }),
    ).rejects.toThrow('已取消');
  });

  it('legacy bootstrap never sends a doomed request when the window cannot fit the patch (P1 fix 5)', async () => {
    mockGetActiveLLMConfig.mockResolvedValue({
      id: 1,
      model_name: 'v5-model',
      context_window: 1200,
      max_output_tokens: 4000,
    });
    await expect(
      generateValidatedChapterMemoryPatch({
        chapter,
        previousState: createEmptyStoryMemory(7),
        memoryPatchMaxTokens: 1200,
      }),
    ).rejects.toThrow(/context_window/);
    // 不发送注定失败的 LLM 请求。
    expect(mockCallLLMResult).not.toHaveBeenCalled();
  });

  it('legacy patch retries respect the model max_output_tokens / context_window caps (P1 fix 5)', async () => {
    mockGetActiveLLMConfig.mockResolvedValue({
      id: 1,
      model_name: 'v5-model',
      context_window: 32768,
      max_output_tokens: 2000,
    });
    mockCallLLMResult.mockResolvedValue({
      text: null,
      inputTokens: 10,
      outputTokens: 0,
      totalTokens: 10,
      emptyReason: 'length',
      finishReason: 'length',
    });
    await expect(
      generateValidatedChapterMemoryPatch({
        chapter,
        previousState: createEmptyStoryMemory(7),
        memoryPatchMaxTokens: 1200,
      }),
    ).rejects.toThrow(/max_output_tokens|context_window/);
    // 每次重试预算都不突破 max_output_tokens=2000。
    for (const call of mockCallLLMResult.mock.calls) {
      expect(call[1]).toBeLessThanOrEqual(2000);
    }
    // 有界重试：最多 3 次物理请求。
    expect(mockCallLLMResult.mock.calls.length).toBeLessThanOrEqual(3);
  });
});
