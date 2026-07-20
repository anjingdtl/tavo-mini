import { createEmptyStoryMemory } from '../src/services/storyMemory/storyMemoryDefaults';
import {
  characterLabel,
  renderStoryMemoryForContext,
} from '../src/services/storyMemory/storyMemoryRenderer';

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
});
