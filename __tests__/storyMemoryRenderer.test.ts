import { createEmptyStoryMemory } from '../src/services/storyMemory/storyMemoryDefaults';
import { renderStoryMemoryForContext } from '../src/services/storyMemory/storyMemoryRenderer';

const currentChapter = {
  id: 3, project_id: 7, position: 2, title: '林岚重返钟楼',
  synopsis: '寻找暗门', content: '', status: 'draft' as const,
  summary_json: null, created_at: '', updated_at: '',
};

function populatedState() {
  const state = createEmptyStoryMemory(7);
  state.throughChapterId = 2;
  state.throughChapterPosition = 1;
  state.characters.char_lan = {
    id: 'char_lan', canonicalName: '林岚', aliases: ['小岚'], role: '调查员',
    immutableProfile: { identity: '守夜人', stableTraits: ['冷静'], affiliations: [] },
    currentState: { location: '钟楼', physicalState: '受伤', emotionalState: '警惕', currentGoal: '找到暗门', knowledge: ['暗门存在'], possessions: ['银钥匙'], secrets: [] },
    status: 'active', firstSeenChapterId: 1, firstSeenPosition: 0,
    lastChangedChapterId: 2, lastChangedPosition: 1, evidenceChapterIds: [1, 2],
  };
  state.characters.char_other = {
    ...state.characters.char_lan,
    id: 'char_other', canonicalName: '周恪', aliases: [],
    currentState: { ...state.characters.char_lan.currentState, location: '报社' },
    lastChangedPosition: 0,
  };
  state.relationships.rel_1 = {
    id: 'rel_1', fromCharacterId: 'char_lan', toCharacterId: 'char_other',
    direction: 'bidirectional', relationType: '盟友', currentState: '暂时合作',
    trustLevel: 'medium', publicStatus: '同事', hiddenStatus: '', reason: '共同调查',
    firstSeenChapterId: 1, lastChangedChapterId: 2, lastChangedPosition: 1,
    evidenceChapterIds: [1, 2],
  };
  state.mainline.currentObjective = '查清钟楼暗门';
  state.mainline.openThreads.thread_door = {
    id: 'thread_door', title: '暗门通向何处', description: '寻找地下档案室',
    ownerCharacterIds: ['char_lan'], priority: 'critical', openedChapterId: 1,
    lastChangedChapterId: 2, deadlineOrTrigger: '', evidenceChapterIds: [1],
  };
  return state;
}

describe('story memory context renderer', () => {
  it('always renders the fixed character, relationship, and mainline sections', () => {
    const result = renderStoryMemoryForContext(populatedState(), {
      currentChapter,
      budgetTokens: 4000,
    });
    expect(result.text).toContain('一、登场人物');
    expect(result.text).toContain('二、人物关系');
    expect(result.text).toContain('三、故事主线');
    expect(result.text).toContain('暗门通向何处');
    expect(result.text).toContain('长期故事状态');
  });

  it('prioritizes a currently mentioned character when the budget clips details', () => {
    const full = renderStoryMemoryForContext(populatedState(), {
      currentChapter,
      budgetTokens: 4000,
    });
    const clipped = renderStoryMemoryForContext(populatedState(), {
      currentChapter,
      budgetTokens: Math.max(1, full.estimatedTokens - 50),
    });
    expect(clipped.clipped).toBe(true);
    expect(clipped.includedCharacterIds[0]).toBe('char_lan');
    // Character + relationship stay ahead of mainline under tight budget.
    expect(clipped.text).toContain('林岚');
    expect(clipped.text).toContain('rel_1');
    // Hard cap: never exceed the reduced budget.
    expect(clipped.estimatedTokens).toBeLessThanOrEqual(
      Math.max(1, full.estimatedTokens - 50),
    );
  });

  it('keeps open threads when budget is sufficient', () => {
    const result = renderStoryMemoryForContext(populatedState(), {
      currentChapter,
      budgetTokens: 4000,
    });
    expect(result.text).toContain('暗门通向何处');
    expect(result.clipped).toBe(false);
  });
});
