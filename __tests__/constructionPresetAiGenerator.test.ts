jest.mock('../src/services/llm', () => ({
  callLLMResult: jest.fn(),
}));

import { callLLMResult } from '../src/services/llm';
import {
  buildConstructionMessages,
  generateConstruction,
} from '../src/services/constructionAiGenerator';

const PRESET_RESPONSE = JSON.stringify({
  name: '限知悬疑',
  system_prompt: '作者身份稳定，使用受限视角推进长篇。',
  writing_style:
    '叙述视角、距离、句法、词汇、段落、场景、环境、人物、对白、节奏、意象和感官都服务于可观察行动。',
  extra_instructions:
    '让冲突改变选择；信息揭示有层次，悬念和伏笔可回溯；章节结尾留下行动压力；禁止空泛总结。',
});

describe('preset construction AI contract', () => {
  beforeEach(() => jest.clearAllMocks());

  it('uses a three-section literary prompt for independent construction', () => {
    const { messages } = buildConstructionMessages({
      mode: 'preset_independent',
      name: '克制悬疑',
      pointOfView: '第三人称限知',
      dialogue: '通过停顿和回避区分人物声音',
      suspense: '线索可回溯，结尾留行动压力',
      detailLevel: 'deep',
    });
    const system = messages[0].content;
    const user = messages[1].content;
    expect(system).toContain('只能包含以下四个文学语义字段');
    expect(system).toContain('不要输出 spec');
    expect(system).toContain('不得复述故事');
    expect(user).toContain('第三人称限知');
    expect(user).toContain('线索可回溯');
  });

  it('extracts mechanisms from TXT without making source facts part of the contract', async () => {
    const { messages } = buildConstructionMessages({
      mode: 'preset_from_text',
      sourceName: 'sample.txt',
      sourceSnapshot: '林晚走过北码头，盐税官在雨里封存了蓝色档案。',
      extra: '只提炼写法',
    });
    const user = messages[1].content;
    expect(user).toContain('只总结可迁移的写作机制');
    expect(user).toContain('不要把来源故事中的人物、地名、事件');
    expect(user).toContain('林晚');
  });

  it('generates a preset with local sampling metadata and scenario', async () => {
    (callLLMResult as jest.Mock).mockResolvedValue({ text: PRESET_RESPONSE });
    const artifact = await generateConstruction(
      { mode: 'preset_independent', genre: '悬疑', detailLevel: 'full' },
      { maxTokens: 4000 },
    );
    expect(artifact.kind).toBe('preset');
    if (artifact.kind !== 'preset') return;
    expect(artifact.preset).toMatchObject({
      spec: 'shinewriter-preset-v1',
      temperature: 0.8,
      top_p: 0.9,
      max_tokens: 4000,
    });
    expect(callLLMResult).toHaveBeenCalledWith(
      expect.any(Array),
      4000,
      expect.objectContaining({ scenario: 'construction_preset_independent' }),
      undefined,
    );
  });

  it('hard-fails missing fields and truncated output', async () => {
    (callLLMResult as jest.Mock).mockResolvedValueOnce({
      text: JSON.stringify({ name: '缺字段', system_prompt: '作者。' }),
    });
    await expect(
      generateConstruction(
        { mode: 'preset_from_text', sourceSnapshot: '样本' },
        { maxTokens: 2000 },
      ),
    ).rejects.toThrow('writing_style');

    (callLLMResult as jest.Mock).mockResolvedValueOnce({
      text: PRESET_RESPONSE,
      finishReason: 'length',
    });
    await expect(
      generateConstruction(
        { mode: 'preset_independent', name: '截断' },
        { maxTokens: 2000 },
      ),
    ).rejects.toThrow('输出因长度限制被截断');
  });
});
