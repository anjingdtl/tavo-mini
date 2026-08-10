/**
 * memory_summary 提示词与默认长度（V2.5.8 Story Memory Retrieval SPEC）。
 */

const chapter = {
  id: 1,
  project_id: 7,
  title: '雨夜钟楼',
  synopsis: '林岚发现密道',
  content: '林岚在雨夜推开钟楼暗门，发现银钥匙。',
};

describe('memory summary prompt (V2.5.8)', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  async function loadGenerator(callLLM: jest.Mock, updateChapter = jest.fn()) {
    jest.doMock('../src/services/database', () => ({
      getChapterById: jest.fn(async () => chapter),
      updateChapter,
    }));
    jest.doMock('../src/services/llm', () => ({ callLLM }));
    return {
      generateMemorySummary: require('../src/services/summaryGenerator')
        .generateMemorySummary as (
        chapterId: number,
        targetChars?: number,
      ) => Promise<string>,
      updateChapter,
    };
  }

  it('defaults to about 300 characters and keeps a single API call', async () => {
    const callLLM = jest.fn(async () => '林岚发现钟楼暗门与银钥匙。');
    const { generateMemorySummary, updateChapter } = await loadGenerator(
      callLLM,
    );

    await expect(generateMemorySummary(1)).resolves.toBe(
      '林岚发现钟楼暗门与银钥匙。',
    );

    expect(callLLM).toHaveBeenCalledTimes(1);
    expect(callLLM).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Number),
      expect.objectContaining({
        scenario: 'memory_summary',
        projectId: 7,
      }),
    );
    const callArgs = callLLM.mock.calls[0] as unknown as [
      Array<{ role: string; content: string }>,
      number,
      { scenario: string },
    ];
    const messages = callArgs[0];
    const maxTokens = callArgs[1];
    const config = callArgs[2];
    expect(maxTokens).toBe(700);
    expect(config).toEqual(
      expect.objectContaining({
        scenario: 'memory_summary',
        projectId: 7,
        queueClass: 'background',
        thinking: { type: 'disabled' },
      }),
    );

    const userContent = messages.find(m => m.role === 'user')!
      .content as string;
    const systemContent = messages.find(m => m.role === 'system')!
      .content as string;

    expect(systemContent).toContain('长篇小说连续性记忆编辑');
    expect(systemContent).toContain('高信息密度');
    expect(userContent).toContain('约 300 字');
    expect(userContent).toContain('谁对谁做了什么');
    expect(userContent).toMatch(/承诺|欺骗|冲突|合作|救援|拒绝|背叛/);
    expect(userContent).toMatch(/获得|失去|交给/);
    expect(userContent).toContain('模糊代词');
    expect(userContent).toMatch(/尚未解决|线索|秘密|误会|承诺|矛盾/);
    expect(updateChapter).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        memory_summary: '林岚发现钟楼暗门与银钥匙。',
        memory_summary_tokens: expect.any(Number),
      }),
    );
  });

  it('respects an explicit targetChars override', async () => {
    const callLLM = jest.fn(async () => '短摘要');
    const { generateMemorySummary } = await loadGenerator(callLLM);

    await expect(generateMemorySummary(1, 120)).resolves.toBe('短摘要');
    const callArgs = callLLM.mock.calls[0] as unknown as [
      Array<{ role: string; content: string }>,
      number,
    ];
    expect(callArgs[0][1].content).toContain('约 120 字');
    expect(callArgs[1]).toBe(700);
  });

  it('still throws when the model returns empty content', async () => {
    const callLLM = jest.fn(async () => '   ');
    const { generateMemorySummary } = await loadGenerator(callLLM);
    await expect(generateMemorySummary(1)).rejects.toThrow('记忆摘要');
  });
});
