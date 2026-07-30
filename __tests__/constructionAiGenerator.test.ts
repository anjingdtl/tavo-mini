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
  description: '雾港机关师的身份、经历、关系与矛盾。'.repeat(80),
  personality: '表面克制，实际记仇，会因旧债与承诺动摇底线。'.repeat(12),
  scenario: '雾港码头深处的工坊正被盐税之争波及，他需要决定是否交出机关图纸。'.repeat(8),
  first_mes: '你推开门时，沈砚正把一枚齿轮放回暗格。他没有立刻抬头，只用指节敲了敲桌面，示意你先说明来意。'.repeat(3),
  mes_example: '{{char}}: 需要什么？先说清楚代价。\n{{user}}: 我想看看机关图纸。\n{{char}}: 图纸可以看，但你得先回答谁让你来的。\n{{user}}: 没有人，我只是想救港口。\n{{char}}: 救港口的人很多，肯承担后果的人很少。\n{{user}}: 那我愿意承担。\n{{char}}: 好，别让我后悔把钥匙交给你。\n{{user}}: 我不会让你失望。'.repeat(3),
  system_prompt: '扮演沈砚：保持克制、敏锐和带条件的善意；先评估风险，再作答；不轻易交出机关术秘密。'.repeat(3),
  post_history_instructions: '保持角色的克制语气、风险意识与对旧债的敏感，不要突然变得轻率或全知。'.repeat(2),
  tags: ['反派', '机关术', '雾港', '克制'],
  alternate_greetings: ['另一场开场'],
});

const WORLDBOOK_JSON = JSON.stringify({
  name: '雾港纪事',
  entries: [
    { keys: ['雾港', '海雾港'], secondary_keys: ['港口'], content: '终年被海雾笼罩的港口城邦，其潮汐、税制与行会传统塑造了居民的生活。'.repeat(20), comment: '核心地点', constant: false },
    { keys: ['机关行会'], secondary_keys: ['工匠组织'], content: '垄断雾港机关术的行会掌握学徒、图纸和维修权，并与各码头势力长期博弈。'.repeat(20), comment: '组织', constant: false },
    { keys: ['月蚀'], secondary_keys: ['红月'], content: '月蚀期间施法会折损寿命，因此城市会实行宵禁、医疗配给和特殊航道管制。'.repeat(20), comment: '世界铁律', constant: true },
    { keys: ['盐税之争'], secondary_keys: ['冲突'], content: '内陆与雾港围绕盐税的长期冲突牵动走私、议会投票、码头罢工和家族联盟。'.repeat(20), comment: '主冲突', constant: false },
    { keys: ['沉船暗礁'], secondary_keys: ['暗礁'], content: '港区外的暗礁常致沉船，领航人会以雾灯、潮表和旧航图判断是否值得冒险。'.repeat(20), comment: '地理', constant: false },
    { keys: ['灰鳞鱼'], secondary_keys: ['特产'], content: '雾港特产的灰鳞鱼可入药，也支撑渔民、药商和盐税官之间复杂的利益链。'.repeat(20), comment: '物产', constant: false },
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
      expect(artifact.card.data.tags).toEqual(['反派', '机关术', '雾港', '克制']);
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
        { maxTokens: 8192 },
      );
      expect(artifact.kind).toBe('worldbook');
      if (artifact.kind !== 'worldbook') return;
      expect(artifact.lorebook.spec).toBe('lorebook_v3');
      expect(artifact.lorebook.data.name).toBe('雾港纪事');
      expect(artifact.lorebook.data.entries).toHaveLength(6);
      const orders = artifact.lorebook.data.entries.map(e => e.insertion_order);
      expect(orders).toEqual([0, 1, 2, 3, 4, 5]);
      // 构建产物强制全部常驻（不跟随模型输出的 false）
      expect(
        artifact.lorebook.data.entries.every(entry => entry.constant === true),
      ).toBe(true);
    });

    it('uses the construction_worldbook_independent scenario', async () => {
      (callLLMResult as jest.Mock).mockResolvedValue({ text: WORLDBOOK_JSON });
      await generateConstruction(
        { mode: 'worldbook_independent', entryCount: 6 },
        { maxTokens: 8192 },
      );
      expect(callLLMResult).toHaveBeenCalledWith(
        expect.any(Array),
        8192,
        expect.objectContaining({ scenario: 'construction_worldbook_independent' }),
        undefined,
      );
    });
  });

  describe('mode: character_from_worldbook', () => {
    it('embeds all worldbook source semantics into the user prompt', () => {
      const snapshot = buildWorldbookSourceSnapshot({
        name: '雾港纪事',
        entries: [{
          keyword_primary: '雾港',
          keyword_secondary: '海雾港, 港口',
          content: '海雾港口。',
          comment: '核心地点',
          constant: 1,
        }],
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
      expect(user).toContain('海雾港、港口');
      expect(user).toContain('核心地点');
      expect(user).toContain('常驻：是');
      expect(user).toContain('补充需求：设计一位机关师');
    });
  });

  describe('detail-level contracts', () => {
    it('puts full-detail character requirements in the system prompt', () => {
      const { messages } = buildConstructionMessages({
        mode: 'character_independent',
        theme: '蒸汽雾港',
        detailLevel: 'full',
      });
      const system = messages.find(message => message.role === 'system')!.content;
      expect(system).toContain('description 至少 1000');
      expect(system).toContain('至少 3 轮');
    });

    it('keeps deep TXT worldbook output always-on in the prompt', () => {
      const { messages } = buildConstructionMessages({
        mode: 'worldbook_from_text',
        sourceSnapshot: '【TXT 来源】雾港制度与盐税冲突。',
        entryCount: 4,
        detailLevel: 'deep',
      });
      const system = messages.find(message => message.role === 'system')!.content;
      const user = messages.find(message => message.role === 'user')!.content;
      expect(system).toContain('每条至少 920');
      expect(system).toContain('constant：布尔值，必须全部为 true');
      expect(user).toContain('TXT 素材');
      expect(user).toContain('常驻设定');
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

    it('rejects a character response that omits required fields instead of fabricating blanks', async () => {
      (callLLMResult as jest.Mock).mockResolvedValue({
        text: JSON.stringify({ name: '沈砚', description: '机关师' }),
      });
      await expect(
        generateConstruction(
          { mode: 'character_independent', theme: 'x' },
          { maxTokens: 1000 },
        ),
      ).rejects.toThrow('缺少或错误填写字段');
    });

    it('keeps a structurally valid character when it misses the quality target', async () => {
      const shortCharacter = JSON.stringify({
        name: '沈砚',
        description: '雾港机关师，背负旧债。',
        personality: '克制而警惕。',
        scenario: '工坊正被卷入盐税冲突。',
        first_mes: '先说明你的来意。',
        mes_example: '{{char}}: 谁让你来的？\n{{user}}: 没有人。',
        system_prompt: '保持克制、敏锐的角色声音。',
        post_history_instructions: '记住旧债与承诺。',
        tags: ['机关师'],
        alternate_greetings: [],
      });
      (callLLMResult as jest.Mock).mockResolvedValue({ text: shortCharacter });

      const artifact = await generateConstruction(
        {
          mode: 'character_independent',
          theme: '蒸汽雾港',
          detailLevel: 'full',
        },
        { maxTokens: 3000 },
      );

      expect(artifact.kind).toBe('character');
      expect(artifact.qualityReport?.passed).toBe(false);
      expect(
        artifact.qualityReport?.failures.some(
          item => item.code === 'output_tokens_short',
        ),
      ).toBe(true);
    });

    it('rejects a length-truncated response even if its JSON is otherwise valid', async () => {
      (callLLMResult as jest.Mock).mockResolvedValue({
        text: CHARACTER_JSON,
        finishReason: 'length',
      });
      await expect(
        generateConstruction(
          { mode: 'character_independent', theme: 'x' },
          { maxTokens: 1000 },
        ),
      ).rejects.toThrow('输出因长度限制被截断');
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
          { maxTokens: 8192 },
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

    it('preserves compatible boolean forms for worldbook entries', async () => {
      const response = JSON.stringify({
        name: '雾港',
        entries: [
          { keys: ['雾港'], content: '港口设定。'.repeat(180), comment: '地点', constant: 'true', enabled: 'false' },
          { keys: ['行会'], content: '组织设定。'.repeat(180), comment: '组织', constant: 1, enabled: 1 },
        ],
      });
      (callLLMResult as jest.Mock).mockResolvedValue({ text: response });
      const artifact = await generateConstruction(
        { mode: 'worldbook_independent', entryCount: 2, detailLevel: 'compact' },
        { maxTokens: 4096 },
      );
      if (artifact.kind !== 'worldbook') throw new Error('expected worldbook');
      expect(artifact.lorebook.data.entries[0]).toMatchObject({
        constant: true,
        enabled: false,
      });
      expect(artifact.lorebook.data.entries[1]).toMatchObject({
        constant: true,
        enabled: true,
      });
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

  describe('batched worldbook generation', () => {
    // 6 条 full + maxTokens=4096：requiredMin=4100 > 4096 → 分批 [3, 3]
    const makeBatch = (keys: string[], prefix: string) =>
      JSON.stringify({
        name: '雾港纪事',
        entries: keys.map((key, i) => ({
          keys: [key],
          content: `${prefix}设定 ${i}。`.repeat(180),
          comment: `${prefix}-${key}`,
          constant: true,
        })),
      });

    it('splits into batches when outputReserve < requiredMin and merges entries', async () => {
      const batch1 = makeBatch(['雾港', '行会', '月蚀'], '批一');
      const batch2 = makeBatch(['盐税', '暗礁', '灰鳞鱼'], '批二');
      (callLLMResult as jest.Mock)
        .mockResolvedValueOnce({ text: batch1 })
        .mockResolvedValueOnce({ text: batch2 });

      const progress: Array<{
        current: number;
        total: number;
        batchSize: number;
      }> = [];
      const artifact = await generateConstruction(
        {
          mode: 'worldbook_independent',
          name: '雾港纪事',
          entryCount: 6,
          detailLevel: 'full',
        },
        {
          maxTokens: 4096,
          onBatchProgress: p => progress.push(p),
        },
      );

      expect(artifact.kind).toBe('worldbook');
      if (artifact.kind !== 'worldbook') return;
      expect(artifact.lorebook.data.entries).toHaveLength(6);
      expect(callLLMResult).toHaveBeenCalledTimes(2);
      expect(progress).toEqual([
        { current: 1, total: 2, batchSize: 3 },
        { current: 2, total: 2, batchSize: 3 },
      ]);
      // insertion_order 重新编号
      const orders = artifact.lorebook.data.entries.map(e => e.insertion_order);
      expect(orders).toEqual([0, 1, 2, 3, 4, 5]);
      // 全部常驻
      expect(
        artifact.lorebook.data.entries.every(e => e.constant === true),
      ).toBe(true);
    });

    it('includes batch note and dedup hint in user message for batch 2+', async () => {
      const batch1 = makeBatch(['雾港', '行会', '月蚀'], '批一');
      const batch2 = makeBatch(['盐税', '暗礁', '灰鳞鱼'], '批二');
      (callLLMResult as jest.Mock)
        .mockResolvedValueOnce({ text: batch1 })
        .mockResolvedValueOnce({ text: batch2 });

      await generateConstruction(
        {
          mode: 'worldbook_independent',
          name: '雾港',
          entryCount: 6,
          detailLevel: 'full',
        },
        { maxTokens: 4096 },
      );

      expect(callLLMResult).toHaveBeenCalledTimes(2);
      // 第二次调用的 messages 应包含批次说明和去重提示
      const secondCallMessages = (callLLMResult as jest.Mock).mock.calls[1][0] as Array<{
        role: string;
        content: string;
      }>;
      const userMsg = secondCallMessages.find(m => m.role === 'user')!.content;
      expect(userMsg).toContain('第 2/2 批');
      expect(userMsg).toContain('雾港、行会、月蚀');
      expect(userMsg).toContain('避免与已生成条目');
      // 第一批不应有去重提示
      const firstCallMessages = (callLLMResult as jest.Mock).mock.calls[0][0] as Array<{
        role: string;
        content: string;
      }>;
      const firstUserMsg = firstCallMessages.find(m => m.role === 'user')!.content;
      expect(firstUserMsg).toContain('第 1/2 批');
      expect(firstUserMsg).not.toContain('避免与已生成条目');
    });

    it('rejects cross-batch duplicate primary keys after merge', async () => {
      // 两批都包含主触发词「雾港」→ 去重后 5 条 ≠ 6 → 抛错
      const batch1 = makeBatch(['雾港', '行会', '月蚀'], '批一');
      const batch2 = makeBatch(['雾港', '暗礁', '灰鳞鱼'], '批二');
      (callLLMResult as jest.Mock)
        .mockResolvedValueOnce({ text: batch1 })
        .mockResolvedValueOnce({ text: batch2 });

      await expect(
        generateConstruction(
          {
            mode: 'worldbook_independent',
            name: '雾港',
            entryCount: 6,
            detailLevel: 'full',
          },
          { maxTokens: 4096 },
        ),
      ).rejects.toThrow('分批合并后条目数');
    });

    it('propagates batch truncation with batch index in error message', async () => {
      const batch1 = makeBatch(['雾港', '行会', '月蚀'], '批一');
      (callLLMResult as jest.Mock)
        .mockResolvedValueOnce({ text: batch1 })
        .mockResolvedValueOnce({ text: '', finishReason: 'length' });

      await expect(
        generateConstruction(
          {
            mode: 'worldbook_independent',
            name: '雾港',
            entryCount: 6,
            detailLevel: 'full',
          },
          { maxTokens: 4096 },
        ),
      ).rejects.toThrow('第 2/2 批');
    });

    it('does not batch when outputReserve is sufficient', async () => {
      // 6 条 full + 8192：requiredMin=4100 ≤ 8192 → 不分批
      (callLLMResult as jest.Mock).mockResolvedValue({ text: WORLDBOOK_JSON });
      const progress: unknown[] = [];
      await generateConstruction(
        {
          mode: 'worldbook_independent',
          name: '雾港纪事',
          entryCount: 6,
          detailLevel: 'full',
        },
        {
          maxTokens: 8192,
          onBatchProgress: p => progress.push(p),
        },
      );
      expect(callLLMResult).toHaveBeenCalledTimes(1);
      expect(progress).toHaveLength(0);
    });
  });
});
