jest.mock('../src/services/llm', () => ({
  callLLMResult: jest.fn(),
}));

import RNFS from 'react-native-fs';
import { callLLMResult } from '../src/services/llm';
import {
  buildConstructionMessages,
  generateConstruction,
} from '../src/services/constructionAiGenerator';
import {
  parseNovelCharacterDraft,
} from '../src/services/construction/characterDraftAdapter';
import { parseNovelWorldbookDraft } from '../src/services/construction/worldbookDraftAdapter';

const visualReference = {
  localPath: '/tmp/cache/character.png',
  name: 'character.png',
  mimeType: 'image/png' as const,
  size: 1024,
};

function characterJson(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: '沈砚',
    role: '雾港机关师',
    personality: '克制而警惕',
    ...fields,
  });
}

async function generateCharacter(
  text: string,
  options: { visual?: boolean } = {},
) {
  (callLLMResult as jest.Mock).mockResolvedValue({ text });
  return generateConstruction(
    {
      mode: 'character_independent',
      name: '沈砚',
      brief: '一位在雾港生活的机关师。',
      detailLevel: 'compact',
    },
    {
      maxTokens: 4000,
      ...(options.visual ? { visualReference } : {}),
    },
  );
}

describe('Construction tolerant output regression', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (RNFS.readFile as jest.Mock).mockResolvedValue('AQID');
  });

  describe('J: deterministic extraction and normalization', () => {
    it('J-1 accepts canonical JSON', async () => {
      const artifact = await generateCharacter(
        characterJson({ appearance: '黑色短发，左眉有浅疤。' }),
      );
      expect(artifact.kind).toBe('character');
    });

    it('J-2 accepts a Markdown JSON fence', async () => {
      const artifact = await generateCharacter(
        `以下是角色资料：\n\n\`\`\`json\n${characterJson({ appearance: '黑色短发。' })}\n\`\`\``,
      );
      expect(artifact.kind).toBe('character');
    });

    it('J-3 extracts the only JSON object from surrounding prose', async () => {
      const artifact = await generateCharacter(
        `好的，以下是角色资料：\n${characterJson({ appearance: '黑色短发。' })}\n希望对你有帮助。`,
      );
      expect(artifact.kind).toBe('character');
    });

    it('J-4 normalizes an appearance array to readable text', () => {
      expect(
        parseNovelCharacterDraft({
          name: '沈砚',
          appearance: ['黑色短发', '左眉浅疤', '灰色风衣'],
        }).appearance,
      ).toBe('黑色短发、左眉浅疤、灰色风衣');
    });

    it('J-5 normalizes an appearance object to readable text', () => {
      expect(
        parseNovelCharacterDraft({
          name: '沈砚',
          appearance: { hair: '黑色短发', clothes: '灰色风衣' },
        }).appearance,
      ).toBe('hair：黑色短发；clothes：灰色风衣');
    });

    it.each([
      'appearance_features',
      'appearanceFeatures',
      'visual_description',
      '外貌特征',
      '形象',
    ])('J-6/J-7 accepts appearance alias %s', alias => {
      const draft = parseNovelCharacterDraft({
        name: '沈砚',
        [alias]: '黑色短发，灰色风衣。',
      });
      expect(draft.appearance).toBe('黑色短发，灰色风衣。');
    });

    it('J-8 gives canonical appearance precedence over aliases', () => {
      const draft = parseNovelCharacterDraft({
        name: '沈砚',
        appearance: '正式值',
        外貌特征: '别名值',
      });
      expect(draft.appearance).toBe('正式值');
    });

    it('J-9 recovers appearance from an explicitly labeled description section', () => {
      const draft = parseNovelCharacterDraft({
        name: '沈砚',
        description:
          '【角色定位】\n雾港机关师\n\n【外貌与辨识特征】\n黑色短发，左眉有浅疤。\n\n【核心性格】\n克制而警惕。',
      });
      expect(draft.appearance).toBe('黑色短发，左眉有浅疤。');
    });

    it('J-9 also accepts content on the same line as an appearance heading', () => {
      const draft = parseNovelCharacterDraft({
        name: '沈砚',
        description: '【外貌】黑色短发，灰色风衣。\n【核心性格】克制而警惕。',
      });
      expect(draft.appearance).toBe('黑色短发，灰色风衣。');
    });

    it('J-10 preserves unknown semantic fields in extra_fields', () => {
      const draft = parseNovelCharacterDraft({
        name: '沈砚',
        role: '机关师',
        personality: '克制',
        signatureTool: '一枚会记录潮汐的旧齿轮',
      });
      expect(draft.extra_fields).toMatchObject({
        signatureTool: '一枚会记录潮汐的旧齿轮',
      });
    });

    it('J-11 repairs trailing commas without rejecting the artifact', async () => {
      const artifact = await generateCharacter(
        '{"name":"沈砚","role":"机关师","personality":"克制","appearance":["黑发",],}',
      );
      expect(artifact.kind).toBe('character');
    });

    it('J-12 fails closed and identifies truly truncated JSON', async () => {
      await expect(
        generateCharacter(
          '{"name":"沈砚","role":"机关师","personality":"克制","appearance":"黑色短发，穿着灰色',
        ),
      ).rejects.toThrow('截断');
    });

    it('keeps tolerant Worldbook keys, arrays, objects, and data envelopes', () => {
      const draft = parseNovelWorldbookDraft({
        data: {
          name: '雾港纪事',
          entries: {
            first: {
              comment: '核心地点',
              keys: '雾港, 海雾港',
              content: { rule: '终年有海雾' },
              constant: 'false',
            },
          },
        },
      });
      expect(draft).toMatchObject({
        name: '雾港纪事',
        entries: [
          {
            title: '核心地点',
            keywords: ['雾港', '海雾港'],
            content: 'rule：终年有海雾',
          },
        ],
      });
    });
  });

  describe('V: conditional visual requirements', () => {
    it('V-1 allows a pure-image character request and keeps one multimodal call', async () => {
      (callLLMResult as jest.Mock).mockResolvedValue({
        text: characterJson({ appearance: '黑色短发，灰色风衣，佩戴金属护目镜。' }),
      });
      const artifact = await generateConstruction(
        { mode: 'character_independent', detailLevel: 'compact' },
        { maxTokens: 4000, visualReference },
      );
      expect(artifact.kind).toBe('character');
      expect(callLLMResult).toHaveBeenCalledTimes(1);
      const messages = (callLLMResult as jest.Mock).mock.calls[0][0];
      expect(Array.isArray(messages[1].content)).toBe(true);
    });

    it('V-2 accepts canonical appearance with a visual reference', async () => {
      const artifact = await generateCharacter(
        characterJson({ appearance: '黑色短发，灰色风衣。' }),
        { visual: true },
      );
      expect(artifact.kind).toBe('character');
    });

    it('V-3 accepts aliased appearance with a visual reference', async () => {
      const artifact = await generateCharacter(
        characterJson({ appearance_features: '黑色短发，灰色风衣。' }),
        { visual: true },
      );
      expect(artifact.kind).toBe('character');
    });

    it('V-4 accepts object appearance with a visual reference', async () => {
      const artifact = await generateCharacter(
        characterJson({ appearance: { hair: '黑色短发', clothes: '灰色风衣' } }),
        { visual: true },
      );
      expect(artifact.kind).toBe('character');
    });

    it('V-5 recovers a description appearance section with a visual reference', async () => {
      const artifact = await generateCharacter(
        characterJson({
          description: '【外貌与辨识特征】\n黑色短发，灰色风衣。',
        }),
        { visual: true },
      );
      expect(artifact.kind).toBe('character');
    });

    it('V-6 hard-fails only when normalized appearance is truly absent', async () => {
      await expect(
        generateCharacter(characterJson(), { visual: true }),
      ).rejects.toThrow('参考图已成功发送，但生成结果没有包含可用的角色外貌描述');
    });

    it('V-7 keeps a short appearance and reports a soft warning', async () => {
      const artifact = await generateCharacter(
        characterJson({ appearance: '冷峻英俊。' }),
        { visual: true },
      );
      expect(artifact.kind).toBe('character');
      expect(artifact.qualityReport?.hardPassed).toBe(true);
      expect(
        artifact.qualityReport?.warnings.some(
          item => item.code === 'appearance_detail_low',
        ),
      ).toBe(true);
    });

    it('V-8 puts user text above visible image facts in the visual prompt', () => {
      const { messages } = buildConstructionMessages(
        {
          mode: 'character_independent',
          brief: '她是银白长发，目前染成黑色。',
        },
        { type: 'image', mimeType: 'image/png', base64: 'AQID' },
      );
      const system = messages[0].content as string;
      expect(system).toContain('appearance 是参考图生成的核心字段');
      expect(system).toContain('用户明确文字事实 > 图片明确可见事实 > 不冲突的合理创作');
      expect(system).toContain('不得根据外貌推断');
      expect(messages[1].content).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'image' })]),
      );
    });
  });

  describe('prompt contracts', () => {
    it('states that AI classifies a Character Brief without requiring user categories', () => {
      const { messages } = buildConstructionMessages({
        mode: 'character_independent',
        name: '沈砚',
        brief: '22岁赏金猎人，擅长机械维修。',
      });
      const system = messages[0].content as string;
      const user = messages[1].content as string;
      expect(system).toContain('AI 自行分类');
      expect(system).toContain('用户无需提前分类');
      expect(system).toContain('结构化字段中的用户明确事实优先于简介');
      expect(user).toContain('角色简介：22岁赏金猎人，擅长机械维修。');
    });

    it('states that Worldbook Brief is split into independent stable topics', () => {
      const { messages } = buildConstructionMessages({
        mode: 'worldbook_independent',
        name: '雾港纪事',
        brief: '大陆由三大城邦统治，魔法依赖蓝色矿石。',
        entryCount: 4,
      });
      const system = messages[0].content as string;
      const user = messages[1].content as string;
      expect(system).toContain('AI 自行识别并拆分');
      expect(system).toContain('不要机械按输入段落拆分');
      expect(user).toContain('世界设定简介：大陆由三大城邦统治，魔法依赖蓝色矿石。');
    });
  });

  describe('LLM empty-output diagnostics', () => {
    it('keeps reasoning-only, content-filter, and no-choices classifications visible', async () => {
      for (const [emptyReason, message] of [
        ['reasoning_only', 'reasoning'],
        ['content_filter', '内容安全策略'],
        ['no_choices', 'choices'],
      ] as const) {
        (callLLMResult as jest.Mock).mockResolvedValue({
          text: null,
          emptyReason,
        });
        await expect(
          generateConstruction(
            { mode: 'character_independent', brief: '一个角色。' },
            { maxTokens: 2000 },
          ),
        ).rejects.toThrow(message);
      }
    });

    it('keeps finishReason=length classified as truncation', async () => {
      (callLLMResult as jest.Mock).mockResolvedValue({
        text: null,
        finishReason: 'length',
        emptyReason: 'reasoning_only',
      });
      await expect(
        generateConstruction(
          { mode: 'character_independent', brief: '一个角色。' },
          { maxTokens: 2000 },
        ),
      ).rejects.toThrow('输出因长度限制被截断');
    });
  });
});
