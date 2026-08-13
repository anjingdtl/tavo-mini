import {
  NOVEL_CHARACTER_EXTENSION_KEY,
  novelCharacterDraftToCharaCard,
  novelCharacterDraftToDescription,
  novelDraftHasCoreInfo,
  parseNovelCharacterDraft,
  readNovelCharacterDraft,
} from '../src/services/construction/characterDraftAdapter';
import {
  novelWorldbookDraftToLorebook,
  parseNovelWorldbookDraft,
} from '../src/services/construction/worldbookDraftAdapter';

describe('construction adapters', () => {
  test('compiles a novel character without chat fields and reads it back', () => {
    const draft = parseNovelCharacterDraft({
      name: '沈砚',
      role: '机关师',
      identity: '工会登记的修理师',
      personality: '克制且记仇',
      relationships: ['妹妹', '工会会长'],
      continuity: ['左手义肢不能接触海水'],
      first_mes: '不应进入小说草稿',
      future_fact: '未知语义字段仍应保留',
    });
    expect(novelDraftHasCoreInfo(draft)).toBe(true);
    expect(novelCharacterDraftToDescription(draft)).toContain('【核心性格】');

    const card = novelCharacterDraftToCharaCard(draft);
    expect(card.data.first_mes).toBe('');
    expect(card.data.mes_example).toBe('');
    expect(card.data.system_prompt).toBe('');
    expect(card.data.post_history_instructions).toBe('');
    expect(card.data.alternate_greetings).toEqual([]);
    expect(card.data.extensions).toEqual(expect.objectContaining({
      [NOVEL_CHARACTER_EXTENSION_KEY]: expect.objectContaining({
        role: '机关师',
        extra_fields: { future_fact: '未知语义字段仍应保留' },
      }),
    }));
    expect(readNovelCharacterDraft(card)).toMatchObject({
      name: '沈砚',
      role: '机关师',
      relationships: ['妹妹', '工会会长'],
    });
  });

  test('keeps missing optional novel dimensions as soft quality concerns', () => {
    const draft = parseNovelCharacterDraft({
      name: '只有核心的角色',
      role: '学徒',
      personality: '谨慎',
    });
    expect(novelDraftHasCoreInfo(draft)).toBe(true);
    expect(draft.arc).toBeUndefined();
  });

  test('renders structured relationship values without leaking object coercion', () => {
    const draft = parseNovelCharacterDraft({
      name: '结构关系角色',
      role: '调查者',
      personality: '谨慎',
      relationships: [{ name: '港务长', nature: '互相利用' }],
    });
    expect(draft.relationships).toEqual(['name：港务长；nature：互相利用']);
    expect(JSON.stringify(draft)).not.toContain('[object Object]');
  });

  test('maps novel world facts to Lorebook v3 deterministically', () => {
    const lorebook = novelWorldbookDraftToLorebook({
      name: '雾港纪事',
      entries: [
        {
          title: '雾港',
          category: '地点',
          keywords: ['雾港', '海雾港'],
          content: '终年海雾、潮汐和行会制度共同塑造城市生活。',
        },
      ],
    });
    expect(lorebook.data.entries[0]).toMatchObject({
      keys: ['雾港', '海雾港'],
      secondary_keys: [],
      comment: '雾港',
      category: '地点',
      enabled: true,
      constant: true,
      insertion_order: 0,
    });
    expect(parseNovelWorldbookDraft(lorebook).entries[0]).toMatchObject({
      title: '雾港',
      keywords: ['雾港', '海雾港'],
    });
  });
});
