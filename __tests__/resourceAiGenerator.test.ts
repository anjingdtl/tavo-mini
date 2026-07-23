jest.mock('../src/services/llm', () => ({
  callLLMResult: jest.fn(),
}));

import { callLLMResult } from '../src/services/llm';
import { generateResourceFromPrompt } from '../src/services/resourceAiGenerator';

describe('resource AI generator', () => {
  beforeEach(() => jest.clearAllMocks());

  it('normalizes a generated character card to the editor standard', async () => {
    (callLLMResult as jest.Mock).mockResolvedValue({
      text: '```json\n{"name":"沈砚","description":"机关师","personality":"克制","tags":"反派"}\n```',
    });
    const result = await generateResourceFromPrompt('characters', '生成机关师', {
      projectName: '雾港纪事',
    });
    expect(result.kind).toBe('characters');
    if (result.kind !== 'characters') throw new Error('expected character');
    expect(result.name).toBe('沈砚');
    expect(JSON.parse(result.dataJson)).toEqual(
      expect.objectContaining({
        name: '沈砚',
        description: '机关师',
        tags: ['反派'],
        alternate_greetings: [],
      }),
    );
    expect(callLLMResult).toHaveBeenCalledWith(
      expect.any(Array),
      3000,
      expect.objectContaining({ scenario: 'resource_character_generate' }),
    );
  });

  it('parses a generated worldbook entry and preserves the constant flag', async () => {
    (callLLMResult as jest.Mock).mockResolvedValue({
      text: '{"keyword_primary":"月蚀","keyword_secondary":"红月,月相","comment":"魔法规则","content":"月蚀时施法会折损寿命。","constant":true}',
    });
    await expect(
      generateResourceFromPrompt('worldbook', '设计月蚀规则'),
    ).resolves.toEqual({
      kind: 'worldbook',
      keywordPrimary: '月蚀',
      keywordSecondary: '红月,月相',
      comment: '魔法规则',
      content: '月蚀时施法会折损寿命。',
      constant: true,
    });
  });

  it('rejects an empty prompt without sending an LLM request', async () => {
    await expect(generateResourceFromPrompt('worldbook', '  ')).rejects.toThrow('请输入生成提示词');
    expect(callLLMResult).not.toHaveBeenCalled();
  });
});
