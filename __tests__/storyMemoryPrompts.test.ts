import { createEmptyStoryMemory } from '../src/services/storyMemory/storyMemoryDefaults';
import {
  buildStoryMemoryCheckpointMessages,
  buildStoryMemoryCheckpointRepairMessages,
  buildStoryMemoryCheckpointRetryMessages,
  buildStoryMemoryFreshRetryMessages,
  buildStoryMemoryPatchMessages,
  buildStoryMemoryRepairMessages,
  compactState,
  STORY_MEMORY_CHECKPOINT_SYSTEM_PROMPT,
  STORY_MEMORY_SYSTEM_PROMPT,
} from '../src/services/storyMemory/storyMemoryPrompts';

const chapter = {
  id: 3,
  project_id: 7,
  position: 2,
  title: '雨夜钟楼',
  synopsis: '发现暗门',
  content: '林岚推开钟楼暗门。石璐在门外守夜。',
  status: 'final' as const,
  summary_json: null,
  created_at: '',
  updated_at: '',
};

describe('story memory prompts', () => {
  it('forbids cumulative summaries and requires evidence and system IDs', () => {
    expect(STORY_MEMORY_SYSTEM_PROMPT).toContain('不得输出完整故事摘要');
    expect(STORY_MEMORY_SYSTEM_PROMPT).toContain('evidenceQuote');
    expect(STORY_MEMORY_SYSTEM_PROMPT).toContain('不得改词、增词或概括');
    expect(STORY_MEMORY_SYSTEM_PROMPT).toContain('精确 ID');
    expect(STORY_MEMORY_SYSTEM_PROMPT).toContain('new_char_石璐');
    expect(STORY_MEMORY_SYSTEM_PROMPT).toContain('每个临时引用必须唯一');
    expect(STORY_MEMORY_SYSTEM_PROMPT).toContain('不要输出 Markdown');
    expect(STORY_MEMORY_SYSTEM_PROMPT).toContain('人物抽取硬性要求');
    expect(STORY_MEMORY_SYSTEM_PROMPT).toContain('newCharacters');
  });

  it('includes current state, full chapter content, roster, and strict schema', () => {
    const state = createEmptyStoryMemory(7);
    state.characters.char_x = {
      id: 'char_x',
      canonicalName: '周恪',
      aliases: [],
      role: '',
      immutableProfile: { identity: '', stableTraits: [], affiliations: [] },
      currentState: {
        location: '',
        physicalState: '',
        emotionalState: '',
        currentGoal: '',
        knowledge: [],
        possessions: [],
        secrets: [],
      },
      status: 'active',
      firstSeenChapterId: 1,
      firstSeenPosition: 0,
      lastChangedChapterId: 1,
      lastChangedPosition: 0,
      evidenceChapterIds: [1],
    };
    const messages = buildStoryMemoryPatchMessages(chapter, state);
    expect(messages[1].content).toContain('林岚推开钟楼暗门');
    expect(messages[1].content).toContain('newCharacters');
    expect(messages[1].content).toContain('canonicalName');
    expect(messages[1].content).toContain('每条关系必须连接两个不同');
    expect(messages[1].content).toContain('throughChapterPosition');
    expect(messages[1].content).toContain('已知人物名册');
    expect(messages[1].content).toContain('周恪');
    expect(messages[1].content).toContain('人物字段优先');
    // newCharacters should appear before episodicSummary in schema block
    const schemaIdx = messages[1].content.indexOf('【严格输出范式');
    const slice = messages[1].content.slice(schemaIdx);
    expect(slice.indexOf('newCharacters')).toBeLessThan(
      slice.indexOf('episodicSummary'),
    );
  });

  it('asks repair to fix evidence without dropping characters', () => {
    const initial = buildStoryMemoryPatchMessages(
      chapter,
      createEmptyStoryMemory(7),
    );
    const repaired = buildStoryMemoryRepairMessages(
      initial,
      '{bad',
      'JSON 无效',
    );
    expect(repaired.at(-1)?.content).toContain('不要重新创作剧情');
    expect(repaired.at(-1)?.content).toContain('禁止通过删除 newCharacters');
    expect(repaired.at(-1)?.content).toContain('JSON 无效');
  });

  it('checkpoint prompts define net-change without omitting cast', () => {
    expect(STORY_MEMORY_CHECKPOINT_SYSTEM_PROMPT).toContain('净变化');
    expect(STORY_MEMORY_CHECKPOINT_SYSTEM_PROMPT).toContain(
      '不指：可以省略本批新出现的人物',
    );
    expect(STORY_MEMORY_CHECKPOINT_SYSTEM_PROMPT).toContain(
      '人物抽取硬性要求',
    );
    expect(STORY_MEMORY_CHECKPOINT_SYSTEM_PROMPT).toContain(
      'newCharacters → characterUpdates',
    );
    expect(STORY_MEMORY_CHECKPOINT_SYSTEM_PROMPT).toContain(
      '矛盾事实 / 改写正文',
    );
    expect(STORY_MEMORY_CHECKPOINT_SYSTEM_PROMPT).toContain(
      'removePossessions',
    );

    const state = createEmptyStoryMemory(1);
    const chapters = [
      { ...chapter, id: 1, position: 0, content: '林岚出场。' },
      { ...chapter, id: 2, position: 1, content: '周恪递地图。' },
      { ...chapter, id: 3, position: 2, content: '两人会合。' },
    ];
    const messages = buildStoryMemoryCheckpointMessages(chapters as any, state);
    const user = messages[1].content;
    expect(user).toContain('已知人物名册');
    expect(user).toContain('本批次范围');
    expect(user).toContain('林岚出场');
    expect(user).toContain('周恪递地图');
    const schemaIdx = user.indexOf('【严格输出范式');
    const slice = user.slice(schemaIdx);
    expect(slice.indexOf('newCharacters')).toBeLessThan(
      slice.indexOf('chapterSummaries'),
    );
  });

  it('checkpoint prompts require dense per-chapter retrieval summaries', () => {
    const system = STORY_MEMORY_CHECKPOINT_SYSTEM_PROMPT;
    expect(system).toContain('逐章检索摘要要求');
    expect(system).toContain('谁对谁实施了什么行为');
    expect(system).toContain('承诺');
    expect(system).toContain('欺骗');
    expect(system).toContain('冲突');
    expect(system).toContain('合作');
    expect(system).toContain('救援');
    expect(system).toContain('拒绝');
    expect(system).toContain('背叛');
    expect(system).toContain('获得');
    expect(system).toContain('失去');
    expect(system).toContain('使用');
    expect(system).toContain('交给谁');
    expect(system).toContain('得知');
    expect(system).toContain('误解');
    expect(system).toContain('隐瞒');
    expect(system).toContain('泄露');
    expect(system).toContain('关系、信任');
    expect(system).toContain('线索');
    expect(system).toContain('秘密');
    expect(system).toContain('误会');
    expect(system).toContain('矛盾');
    expect(system).toContain('模糊代词');
    expect(system).toContain('二人');
    expect(system).toContain('他们');
    expect(system).toContain('双方');

    const messages = buildStoryMemoryCheckpointMessages(
      [chapter as any],
      createEmptyStoryMemory(1),
    );
    const user = messages[1].content;
    expect(user).toContain('主体、行为、对象和结果');
    expect(user).toContain('人物A 对人物B 做了某事');
    expect(user).toContain('双方姓名');
    expect(user).toContain('涉及人物、物品、秘密或误会');
    expect(user).toContain('谁对谁做了什么');
    expect(user).toContain('禁止“二人/他们/双方/有人”');
  });

  it('checkpoint repair/retry forbid dropping newCharacters to shorten output', () => {
    const base = buildStoryMemoryCheckpointMessages(
      [chapter as any],
      createEmptyStoryMemory(1),
    );
    const repair = buildStoryMemoryCheckpointRepairMessages(
      base,
      '{}',
      '证据无效',
    );
    expect(repair.at(-1)?.content).toContain('禁止删除 newCharacters');
    const retry = buildStoryMemoryCheckpointRetryMessages(base, '截断');
    expect(retry.at(-1)?.content).toContain('不要为了缩短输出而省略 newCharacters');
    const fresh = buildStoryMemoryFreshRetryMessages(base, '截断');
    expect(fresh.at(-1)?.content).toContain('不得为缩短输出而漏掉具名新人物');
  });

  it('compactState exposes roster and character count', () => {
    const state = createEmptyStoryMemory(9);
    state.characters.a = {
      id: 'a',
      canonicalName: '林岚',
      aliases: ['小岚'],
      role: '调查员',
      immutableProfile: { identity: '', stableTraits: [], affiliations: [] },
      currentState: {
        location: '钟楼',
        physicalState: '',
        emotionalState: '',
        currentGoal: '',
        knowledge: [],
        possessions: [],
        secrets: [],
      },
      status: 'active',
      firstSeenChapterId: 1,
      firstSeenPosition: 0,
      lastChangedChapterId: 1,
      lastChangedPosition: 0,
      evidenceChapterIds: [1],
    };
    const compact = compactState(state);
    expect(compact).toContain('knownCharacterCount');
    expect(compact).toContain('characterRoster');
    expect(compact).toContain('林岚');
    expect(compact).toContain('小岚');
  });
});
