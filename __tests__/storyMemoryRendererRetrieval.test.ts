import { createEmptyStoryMemory } from '../src/services/storyMemory/storyMemoryDefaults';
import {
  characterLabel,
  renderStoryMemoryForContext,
  resolveRelevantCharacterIds,
  buildStoryMemoryScanText,
} from '../src/services/storyMemory/storyMemoryRenderer';
import { estimateTokens } from '../src/utils/tokenEstimator';

function populatedState() {
  const state = createEmptyStoryMemory(7);
  state.throughChapterId = 2;
  state.throughChapterPosition = 1;
  state.characters.char_lan = {
    id: 'char_lan',
    canonicalName: '林岚',
    aliases: ['小岚'],
    role: '调查员',
    immutableProfile: {
      identity: '守夜人',
      stableTraits: ['冷静'],
      affiliations: [],
    },
    currentState: {
      location: '钟楼',
      physicalState: '受伤',
      emotionalState: '警惕',
      currentGoal: '找到暗门',
      knowledge: ['暗门存在'],
      possessions: ['银钥匙'],
      secrets: [],
    },
    status: 'active',
    firstSeenChapterId: 1,
    firstSeenPosition: 0,
    lastChangedChapterId: 2,
    lastChangedPosition: 1,
    evidenceChapterIds: [1, 2],
  };
  state.characters.char_other = {
    ...state.characters.char_lan,
    id: 'char_other',
    canonicalName: '周恪',
    aliases: [],
    currentState: {
      ...state.characters.char_lan.currentState,
      location: '报社',
    },
    lastChangedPosition: 0,
  };
  state.characters.char_bai = {
    ...state.characters.char_lan,
    id: 'char_bai',
    canonicalName: '白薇',
    aliases: [],
    lastChangedPosition: 0,
  };
  state.relationships.rel_1 = {
    id: 'rel_1',
    fromCharacterId: 'char_lan',
    toCharacterId: 'char_other',
    direction: 'bidirectional',
    relationType: '盟友',
    currentState: '暂时合作',
    trustLevel: 'medium',
    publicStatus: '同事',
    hiddenStatus: '',
    reason: '共同调查',
    firstSeenChapterId: 1,
    lastChangedChapterId: 2,
    lastChangedPosition: 1,
    evidenceChapterIds: [1, 2],
  };
  state.relationships.rel_old = {
    id: 'rel_old',
    fromCharacterId: 'char_bai',
    toCharacterId: 'char_other',
    direction: 'directed',
    relationType: '对手',
    currentState: '疏远',
    trustLevel: 'low',
    publicStatus: '',
    hiddenStatus: '',
    reason: '旧怨',
    firstSeenChapterId: 1,
    lastChangedChapterId: 1,
    lastChangedPosition: 5,
    evidenceChapterIds: [1],
  };
  return state;
}

describe('story memory relationship retrieval rendering', () => {
  it('renders character name with internal id', () => {
    const state = populatedState();
    expect(characterLabel(state, 'char_lan')).toBe('林岚[char_lan]');
    expect(characterLabel(state, 'char_other')).toBe('周恪[char_other]');
    expect(characterLabel(state, 'missing_id')).toBe('missing_id');

    const result = renderStoryMemoryForContext(state, {
      currentChapter: {
        id: 3,
        project_id: 7,
        position: 2,
        title: '林岚重返钟楼',
        synopsis: '寻找暗门',
        content: '',
        status: 'draft',
        summary_json: null,
        memory_summary: '',
        memory_summary_tokens: 0,
        finalized_at: null,
        created_at: '',
        updated_at: '',
      },
      budgetTokens: 4000,
    });

    expect(result.text).toContain('林岚[char_lan]');
    expect(result.text).toContain('周恪[char_other]');
    expect(result.text).toMatch(/林岚\[char_lan\].*↔.*周恪\[char_other\]/);
  });

  it('prioritizes relationships involving currently mentioned characters', () => {
    const state = populatedState();
    const result = renderStoryMemoryForContext(state, {
      currentChapter: {
        id: 3,
        project_id: 7,
        position: 2,
        title: '林岚的选择',
        synopsis: '林岚独自行动',
        content: '林岚走入夜色。',
        status: 'draft',
        summary_json: null,
        memory_summary: '',
        memory_summary_tokens: 0,
        finalized_at: null,
        created_at: '',
        updated_at: '',
      },
      budgetTokens: 4000,
    });

    const relSection = result.text.split('二、人物关系')[1].split('三、故事主线')[0];
    const lanIndex = relSection.indexOf('rel_1');
    const oldIndex = relSection.indexOf('rel_old');
    expect(lanIndex).toBeGreaterThanOrEqual(0);
    expect(oldIndex).toBeGreaterThanOrEqual(0);
    // Current-character relationship should appear before the unrelated higher-position one.
    expect(lanIndex).toBeLessThan(oldIndex);
  });

  it('never exceeds budgetTokens for 1/10/50/100 and large open sets', () => {
    const state = populatedState();
    for (let i = 0; i < 40; i += 1) {
      state.mainline.openThreads[`thread_${i}`] = {
        id: `thread_${i}`,
        title: `开放线索${i}号关于银钥匙与暗门的长描述`,
        description: `详细描述线索${i}的来龙去脉与未解之谜。`.repeat(3),
        ownerCharacterIds: ['char_lan'],
        priority: i % 2 === 0 ? 'high' : 'normal',
        openedChapterId: 1,
        lastChangedChapterId: 1,
        deadlineOrTrigger: '',
        evidenceChapterIds: [1],
      };
      state.mainline.activeConflicts[`conflict_${i}`] = {
        id: `conflict_${i}`,
        title: `冲突${i}`,
        parties: ['char_lan', 'char_other'],
        state: `冲突状态描述${i}`.repeat(2),
        stakes: `代价${i}`,
        openedChapterId: 1,
        lastChangedChapterId: 1,
        evidenceChapterIds: [1],
      };
      state.mainline.foreshadowing[`fs_${i}`] = {
        id: `fs_${i}`,
        setup: `伏笔铺垫${i}`,
        expectedPayoff: `预期回收${i}`,
        status: 'open',
        openedChapterId: 1,
        lastChangedChapterId: 1,
        evidenceChapterIds: [1],
      };
      state.characters[`char_extra_${i}`] = {
        ...state.characters.char_lan,
        id: `char_extra_${i}`,
        canonicalName: `路人${i}`,
        aliases: [],
        lastChangedPosition: i,
      };
    }

    const chapter = {
      id: 3,
      project_id: 7,
      position: 2,
      title: '第30章',
      synopsis: '',
      content: '',
      status: 'draft' as const,
      summary_json: null,
      memory_summary: '',
      memory_summary_tokens: 0,
      finalized_at: null,
      created_at: '',
      updated_at: '',
    };

    for (const budget of [1, 10, 50, 100, 400, 2000]) {
      const result = renderStoryMemoryForContext(state, {
        currentChapter: chapter,
        budgetTokens: budget,
        retrievalUserPrompt: '写林岚向周恪追问银钥匙',
      });
      expect(estimateTokens(result.text)).toBeLessThanOrEqual(budget);
      expect(result.estimatedTokens).toBeLessThanOrEqual(budget);
    }
  });

  it('prioritizes 林岚/周恪 cards and their relationship from retrievalUserPrompt alone', () => {
    const state = populatedState();
    // Flood with many unrelated characters so they would consume budget if selected first.
    for (let i = 0; i < 25; i += 1) {
      state.characters[`char_noise_${i}`] = {
        ...state.characters.char_lan,
        id: `char_noise_${i}`,
        canonicalName: `路人甲${i}`,
        aliases: [],
        lastChangedPosition: 100 + i,
      };
    }
    const result = renderStoryMemoryForContext(state, {
      currentChapter: {
        id: 30,
        project_id: 7,
        position: 29,
        title: '第30章',
        synopsis: '',
        content: '',
        status: 'draft',
        summary_json: null,
        memory_summary: '',
        memory_summary_tokens: 0,
        finalized_at: null,
        created_at: '',
        updated_at: '',
      },
      budgetTokens: 900,
      retrievalUserPrompt: '写林岚向周恪追问银钥匙',
    });

    expect(estimateTokens(result.text)).toBeLessThanOrEqual(900);
    expect(result.includedCharacterIds).toContain('char_lan');
    expect(result.includedCharacterIds).toContain('char_other');
    // Relevant characters should appear before flood of noise when both fit.
    const firstNoise = result.includedCharacterIds.find(id =>
      id.startsWith('char_noise_'),
    );
    if (firstNoise) {
      expect(result.includedCharacterIds.indexOf('char_lan')).toBeLessThan(
        result.includedCharacterIds.indexOf(firstNoise),
      );
    }
    expect(result.includedRelationshipIds[0]).toBe('rel_1');
    expect(result.text).toContain('林岚[char_lan]');
    expect(result.text).toContain('周恪[char_other]');
    expect(result.text).toMatch(/林岚\[char_lan\].*↔.*周恪\[char_other\]/);
  });

  it('does not boost unrelated characters via ambiguous shared titles', () => {
    const state = populatedState();
    state.characters.char_lan.aliases = ['队长'];
    state.characters.char_other.aliases = ['队长'];
    state.characters.char_bai.aliases = ['小薇'];
    const chapter = {
      id: 3,
      project_id: 7,
      position: 2,
      title: '第30章',
      synopsis: '',
      content: '',
      status: 'draft' as const,
      summary_json: null,
      memory_summary: '',
      memory_summary_tokens: 0,
      finalized_at: null,
      created_at: '',
      updated_at: '',
    };
    const scan = buildStoryMemoryScanText(chapter, '写队长下令调查');
    const relevant = resolveRelevantCharacterIds(state, scan);
    // Ambiguous 队长 must not activate 林岚/周恪.
    expect(relevant.has('char_lan')).toBe(false);
    expect(relevant.has('char_other')).toBe(false);
    expect(relevant.has('char_bai')).toBe(false);

    const withUnique = resolveRelevantCharacterIds(
      state,
      buildStoryMemoryScanText(chapter, '写小薇调查'),
    );
    expect(withUnique.has('char_bai')).toBe(true);
    expect(withUnique.has('char_lan')).toBe(false);
  });
});
