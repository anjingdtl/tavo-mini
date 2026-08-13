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
  aliases: ['雾港的锁匠', '沈工'],
  role: '负责维修港口核心机关、同时暗中追查旧事故真相的关键人物。'.repeat(10),
  identity: '出身底层工坊，现为机关行会登记的高级修理师，身份使他既受保护又受监视。'.repeat(10),
  appearance: '左手为银色义肢，袖口常有机油和盐霜，观察别人时习惯先看手而不是脸。'.repeat(8),
  background: '少年时期在雾港底层工坊长大，曾亲历一次被行会掩盖的爆炸事故，从此不再相信官方记录。'.repeat(10),
  personality: '表面克制，实际记仇；面对承诺极其认真，但会用冷淡和讥讽保护自己的恐惧。'.repeat(12),
  motivation: '查明旧事故的真正责任人，保护妹妹和仍在底层工作的学徒，并让被掩盖的证据重新进入公共记录。'.repeat(10),
  conflict: '不信任任何权威却必须依赖行会资源；渴望公正却害怕复仇会牵连无辜，常在沉默和冒险之间摇摆。'.repeat(10),
  relationships: ['与工会会长互相利用', '与妹妹保持秘密通信', '把一名年轻学徒视为未完成的补偿'],
  abilities: '精通机械机关、潮汐计和旧式密码，能从磨损痕迹还原设备最近的操作顺序。'.repeat(8),
  limitations: '义肢在高湿环境下会失灵；不擅长公开演说，也无法同时保护多个秘密。'.repeat(8),
  secrets: '他曾在事故当夜拿走一枚关键齿轮，错误地认为沉默能保护妹妹。'.repeat(8),
  speech_style: '说话短促，先问代价和证据；遇到真正关心的人会用维修术语回避直白情绪。',
  behavior_habits: '思考时反复擦拭同一枚齿轮，进陌生房间先检查出口和钟表。'.repeat(6),
  arc: '从以沉默换取局部安全，逐渐转向承担公开真相会带来的连锁代价。'.repeat(8),
  continuity: ['左手义肢不能长时间接触海水', '妹妹住在北码头', '旧事故记录缺少一枚齿轮'],
  initial_situation: '工坊即将被盐税官查封，他必须决定是否交出机关图纸换取暂时安全。'.repeat(6),
  tags: ['反派', '机关术', '雾港', '克制'],
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
      expect(artifact.card.data.alternate_greetings).toEqual([]);
      expect(artifact.card.data.first_mes).toBe('');
      expect(artifact.card.data.mes_example).toBe('');
      expect(artifact.card.data.system_prompt).toBe('');
      expect(artifact.card.data.post_history_instructions).toBe('');
      expect(artifact.card.data.extensions).toEqual(expect.objectContaining({
        shinewriter_novel_character_v1: expect.objectContaining({
          role: expect.any(String),
          personality: expect.any(String),
        }),
      }));
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
      expect(system).toContain('小说化角色资料');
      expect(system).toContain('role、identity、appearance、background');
      expect(system).not.toContain('first_mes');
      expect(system).not.toContain('mes_example');
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
      expect(system).toContain('title');
      expect(system).not.toContain('constant');
      expect(user).toContain('TXT 素材');
      expect(user).toContain('独立世界书条目');
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
      ).rejects.toThrow('核心信息');
    });

    it('keeps a structurally valid character when it misses the quality target', async () => {
      const shortCharacter = JSON.stringify({
        name: '沈砚',
        role: '雾港机关师。',
        personality: '克制而警惕。',
        tags: ['机关师'],
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
      expect(artifact.qualityReport?.warnings.some(item => item.code === 'output_tokens_short')).toBe(true);
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

    it('rejects a worldbook with empty content as a hard quality failure', async () => {
      (callLLMResult as jest.Mock).mockResolvedValue({
        text: JSON.stringify({
          name: '雾港',
          entries: [{ title: '港口规则', keywords: ['雾港'], content: '' }],
        }),
      });
      await expect(
        generateConstruction(
          { mode: 'worldbook_independent', entryCount: 1 },
          { maxTokens: 4096 },
        ),
      ).rejects.toThrow('正文为空');
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
        enabled: true,
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
