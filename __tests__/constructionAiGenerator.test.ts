jest.mock('../src/services/llm', () => ({
  callLLMResult: jest.fn(),
}));

import { callLLMResult } from '../src/services/llm';
import {
  buildCharacterSourceSnapshot,
  buildConstructionMessages,
  buildWorldbookSourceSnapshot,
  estimateConstructionInputTokens,
  generateConstruction,
} from '../src/services/constructionAiGenerator';

const CHARACTER_JSON = JSON.stringify({
  name: '沈砚',
  description: '表面温和的机关师。',
  personality: '克制、记仇。',
  scenario: '雾港码头深处的工坊。',
  first_mes: '你推开门，他头也不抬。',
  mes_example: '{{char}}: 需要什么？\n{{user}}: 看看机关。',
  system_prompt: '扮演沈砚。',
  post_history_instructions: '保持克制。',
  tags: ['反派', '机关术'],
  alternate_greetings: ['另一场开场'],
});

const WORLDBOOK_JSON = JSON.stringify({
  name: '雾港纪事',
  entries: [
    { keys: ['雾港', '海雾港'], secondary_keys: ['港口'], content: '终年被海雾笼罩的港口城邦。', comment: '核心地点', constant: false },
    { keys: ['机关行会'], secondary_keys: ['工匠组织'], content: '垄断雾港机关术的行会。', comment: '组织', constant: false },
    { keys: ['月蚀'], secondary_keys: ['红月'], content: '月蚀期间施法会折损寿命。', comment: '世界铁律', constant: true },
    { keys: ['盐税之争'], secondary_keys: ['冲突'], content: '内陆与雾港围绕盐税的长期冲突。', comment: '主冲突', constant: false },
    { keys: ['沉船暗礁'], secondary_keys: ['暗礁'], content: '港区外的暗礁常致沉船。', comment: '地理', constant: false },
    { keys: ['灰鳞鱼'], secondary_keys: ['特产'], content: '雾港特产的鱼类，可入药。', comment: '物产', constant: false },
  ],
});

describe('constructionAiGenerator', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('mode: character_independent', () => {
    it('parses a character card, wraps the v3 envelope and round-trips', async () => {
      (callLLMResult as jest.Mock).mockResolvedValue({ text: CHARACTER_JSON });
      const artifact = await generateConstruction(
        {
          mode: 'character_independent',
          name: '沈砚',
          theme: '蒸汽雾港',
          role: '反派机关师',
          personality: '克制记仇',
        },
        { maxTokens: 1600 },
      );
      expect(artifact.kind).toBe('character');
      if (artifact.kind !== 'character') return;
      expect(artifact.name).toBe('沈砚');
      expect(artifact.card.spec).toBe('chara_card_v3');
      expect(artifact.card.spec_version).toBe('3.0');
      expect(artifact.card.data.creator).toBe('ShineWriter 构建');
      expect(artifact.card.data.tags).toEqual(['反派', '机关术']);
      expect(artifact.card.data.alternate_greetings).toEqual(['另一场开场']);
      expect(artifact.card.data.mes_example).toContain('{{char}}');
    });

    it('calls the LLM with the construction scenario and reserved tokens', async () => {
      (callLLMResult as jest.Mock).mockResolvedValue({ text: CHARACTER_JSON });
      await generateConstruction(
        { mode: 'character_independent', theme: 'x' },
        { maxTokens: 1234 },
      );
      expect(callLLMResult).toHaveBeenCalledWith(
        expect.any(Array),
        1234,
        expect.objectContaining({
          scenario: 'construction_character_independent',
          queueClass: 'normal',
          queuePriority: 'manual',
        }),
        undefined,
      );
    });
  });

  describe('mode: worldbook_independent', () => {
    it('parses a lorebook collection with the requested entry count', async () => {
      (callLLMResult as jest.Mock).mockResolvedValue({ text: WORLDBOOK_JSON });
      const artifact = await generateConstruction(
        { mode: 'worldbook_independent', name: '雾港纪事', entryCount: 6 },
        { maxTokens: 4096 },
      );
      expect(artifact.kind).toBe('worldbook');
      if (artifact.kind !== 'worldbook') return;
      expect(artifact.lorebook.spec).toBe('lorebook_v3');
      expect(artifact.lorebook.data.name).toBe('雾港纪事');
      expect(artifact.lorebook.data.entries).toHaveLength(6);
      const orders = artifact.lorebook.data.entries.map(e => e.insertion_order);
      expect(orders).toEqual([0, 1, 2, 3, 4, 5]);
      expect(artifact.lorebook.data.entries[2].constant).toBe(true);
    });

    it('uses the construction_worldbook_independent scenario', async () => {
      (callLLMResult as jest.Mock).mockResolvedValue({ text: WORLDBOOK_JSON });
      await generateConstruction(
        { mode: 'worldbook_independent', entryCount: 6 },
        { maxTokens: 4096 },
      );
      expect(callLLMResult).toHaveBeenCalledWith(
        expect.any(Array),
        4096,
        expect.objectContaining({ scenario: 'construction_worldbook_independent' }),
        undefined,
      );
    });
  });

  describe('mode: character_from_worldbook', () => {
    it('embeds the worldbook source snapshot into the user prompt', () => {
      const snapshot = buildWorldbookSourceSnapshot({
        name: '雾港纪事',
        entries: [{ keys: ['雾港'], content: '海雾港口。' }],
      });
      const { messages } = buildConstructionMessages({
        mode: 'character_from_worldbook',
        sourceSnapshot: snapshot,
        sourceName: '雾港纪事',
        extra: '设计一位机关师',
      });
      const user = messages.find(m => m.role === 'user')!.content;
      expect(user).toContain('雾港纪事');
      expect(user).toContain('海雾港口');
      expect(user).toContain('补充需求：设计一位机关师');
    });
  });

  describe('mode: worldbook_from_character', () => {
    it('embeds the character snapshot and the requested entry count', () => {
      const snapshot = buildCharacterSourceSnapshot({
        name: '沈砚',
        data: { name: '沈砚', description: '机关师', personality: '克制' },
      });
      const { messages } = buildConstructionMessages({
        mode: 'worldbook_from_character',
        sourceSnapshot: snapshot,
        entryCount: 4,
        extra: '扩展势力关系',
      });
      const user = messages.find(m => m.role === 'user')!.content;
      expect(user).toContain('4 条独立世界书条目');
      expect(user).toContain('沈砚');
      expect(user).toContain('机关师');
    });
  });

  describe('error handling', () => {
    it('rejects when the model returns non-JSON prose', async () => {
      (callLLMResult as jest.Mock).mockResolvedValue({ text: '抱歉，无法生成。' });
      await expect(
        generateConstruction(
          { mode: 'character_independent', theme: 'x' },
          { maxTokens: 1000 },
        ),
      ).rejects.toThrow('模型没有返回有效 JSON');
    });

    it('rejects when the model returns empty content', async () => {
      (callLLMResult as jest.Mock).mockResolvedValue({ text: '   ' });
      await expect(
        generateConstruction(
          { mode: 'character_independent', theme: 'x' },
          { maxTokens: 1000 },
        ),
      ).rejects.toThrow('模型未返回生成内容');
    });

    it('rejects a character card without a name', async () => {
      (callLLMResult as jest.Mock).mockResolvedValue({
        text: JSON.stringify({ description: '某角色' }),
      });
      await expect(
        generateConstruction(
          { mode: 'character_independent', theme: 'x' },
          { maxTokens: 1000 },
        ),
      ).rejects.toThrow('缺少角色名称');
    });

    it('rejects a worldbook whose entry count does not match', async () => {
      (callLLMResult as jest.Mock).mockResolvedValue({
        text: JSON.stringify({
          name: '雾港',
          entries: [
            { keys: ['a'], content: 'x' },
            { keys: ['b'], content: 'y' },
          ],
        }),
      });
      await expect(
        generateConstruction(
          { mode: 'worldbook_independent', entryCount: 6 },
          { maxTokens: 4096 },
        ),
      ).rejects.toThrow('条目数（2）与要求的 6 条不一致');
    });

    it('rejects a worldbook with duplicate primary keys', async () => {
      (callLLMResult as jest.Mock).mockResolvedValue({
        text: JSON.stringify({
          name: '雾港',
          entries: [
            { keys: ['雾港'], content: 'x' },
            { keys: ['雾港', '港'], content: 'y' },
          ],
        }),
      });
      await expect(
        generateConstruction(
          { mode: 'worldbook_independent', entryCount: 2 },
          { maxTokens: 4096 },
        ),
      ).rejects.toThrow('重复主触发词');
    });

    it('propagates cancellation from the LLM layer without producing an artifact', async () => {
      const controller = new AbortController();
      controller.abort();
      (callLLMResult as jest.Mock).mockImplementation(
        (_msgs: unknown, _max: unknown, _cfg: unknown, signal?: AbortSignal) =>
          signal?.aborted
            ? Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            : Promise.resolve({ text: CHARACTER_JSON }),
      );
      await expect(
        generateConstruction(
          { mode: 'character_independent', theme: 'x' },
          { maxTokens: 1000, signal: controller.signal },
        ),
      ).rejects.toThrow('aborted');
    });
  });

  describe('token estimation', () => {
    it('estimates input tokens that grow with the source snapshot', () => {
      const small = estimateConstructionInputTokens({
        mode: 'character_independent',
        theme: '短',
      });
      const big = estimateConstructionInputTokens({
        mode: 'character_from_worldbook',
        sourceSnapshot: buildWorldbookSourceSnapshot({
          name: '大部头',
          entries: Array.from({ length: 10 }, (_, i) => ({
            keys: [`条目${i}`],
            content: '很长'.repeat(50),
          })),
        }),
      });
      expect(big).toBeGreaterThan(small);
      expect(big).toBeGreaterThan(0);
    });
  });
});
