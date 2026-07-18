const mockCallLLMResult = jest.fn();

jest.mock('../src/services/llm', () => ({
  callLLMResult: (...args: unknown[]) => mockCallLLMResult(...args),
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
      expect.objectContaining({ scenario: 'story_memory_patch_repair' }),
    );
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

  it('stops after a failed repair or truncated local-model JSON', async () => {
    mockCallLLMResult
      .mockResolvedValueOnce(response('{"schemaVersion":1'))
      .mockResolvedValueOnce(response('{still bad'));
    await expect(
      generateValidatedChapterMemoryPatch({
        chapter,
        previousState: createEmptyStoryMemory(7),
        memoryPatchMaxTokens: 800,
      }),
    ).rejects.toThrow('完整的 JSON');
    expect(mockCallLLMResult).toHaveBeenCalledTimes(2);
  });

  it('rejects empty output and respects an already aborted signal', async () => {
    mockCallLLMResult.mockResolvedValueOnce(response(null));
    await expect(
      generateValidatedChapterMemoryPatch({
        chapter,
        previousState: createEmptyStoryMemory(7),
        memoryPatchMaxTokens: 800,
      }),
    ).rejects.toThrow('没有返回记忆补丁');

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
});
