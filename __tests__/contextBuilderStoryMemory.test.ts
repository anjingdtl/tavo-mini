import { createEmptyStoryMemory } from '../src/services/storyMemory/storyMemoryDefaults';
import {
  resolveStoryStateForRetrieval,
} from '../src/services/contextBuilder';
import {
  CHARACTER_NAME_BOOST,
  buildIdfFromTexts,
  scoreMemoryCandidates,
} from '../src/services/episodicMemoryRetriever';

const current = {
  id: 2, project_id: 7, position: 1, title: '第二章', synopsis: '重返钟楼',
  content: '', status: 'draft' as const, summary_json: null,
  created_at: '', updated_at: '',
};
const previous = {
  ...current, id: 1, position: 0, title: '第一章', content: '林岚发现暗门。',
  status: 'final' as const, memory_summary: '核心事件：林岚发现暗门',
};

function staleEntityState() {
  const state = createEmptyStoryMemory(7);
  state.characters.old = {
    id: 'old',
    canonicalName: '旧角色甲',
    aliases: ['旧称'],
    role: '',
    immutableProfile: { identity: '', stableTraits: [], affiliations: [] },
    currentState: {
      location: '',
      physicalState: '',
      emotionalState: '',
      currentGoal: '',
      knowledge: [],
      possessions: ['过期红钥匙'],
      secrets: [],
    },
    status: 'active',
    firstSeenChapterId: 1,
    firstSeenPosition: 0,
    lastChangedChapterId: 1,
    lastChangedPosition: 0,
    evidenceChapterIds: [1],
  };
  state.characters.old2 = {
    ...state.characters.old,
    id: 'old2',
    canonicalName: '旧角色乙',
    aliases: [],
    currentState: {
      ...state.characters.old.currentState,
      possessions: [],
    },
  };
  return state;
}

describe('context builder story memory integration', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('injects story state before resources and episodic Top-K memory', async () => {
    const state = createEmptyStoryMemory(7);
    state.throughChapterId = 1;
    state.throughChapterPosition = 0;
    state.metadata.status = 'clean';
    state.mainline.currentObjective = '找到钟楼暗门';
    jest.doMock('../src/services/database', () => ({
      getChaptersByProject: jest.fn(async () => [previous, current]),
      getProjectStoryMemory: jest.fn(async () => ({ state, status: 'clean', dirtyFromPosition: null })),
      getCharactersByProject: jest.fn(async () => [{ name: '林岚', max_tokens: 100, data_json: JSON.stringify({ data: { description: '守夜人' } }) }]),
      getWorldbookEntriesByProject: jest.fn(async () => []),
      getNotesByProject: jest.fn(async () => []),
    }));
    jest.doMock('../src/services/macroReplace', () => ({ processMacros: jest.fn(async (text: string) => text) }));
    const { buildContext } = require('../src/services/contextBuilder');
    const result = await buildContext(
      current,
      { strategy: 'sliding', slidingWindowSize: 1000, customRangeStart: 0, customRangeEnd: -1, includeResources: true, resourceBudget: 1000, storyStateBudgetTokens: 2000, episodicMemoryBudgetTokens: 1000 },
      7,
      undefined,
      { storyMemoryMode: 'preview' },
    );
    const contents = result.messages.map((item: { content: string }) => item.content);
    const storyIndex = contents.findIndex((text: string) => text.includes('故事全局状态'));
    const resourceIndex = contents.findIndex((text: string) => text.includes('设定资料'));
    const episodicIndex = contents.findIndex((text: string) => text.includes('相关历史章节事件'));
    expect(storyIndex).toBeGreaterThan(0);
    expect(storyIndex).toBeLessThan(resourceIndex);
    expect(resourceIndex).toBeLessThan(episodicIndex);
    expect(contents[episodicIndex]).toContain('林岚发现暗门');
  });

  it('does not inject a dirty state affecting the target chapter', async () => {
    const state = createEmptyStoryMemory(7);
    state.throughChapterPosition = 0;
    state.metadata.status = 'dirty';
    state.metadata.dirtyFromPosition = 0;
    jest.doMock('../src/services/database', () => ({
      getChaptersByProject: jest.fn(async () => [previous, current]),
      getProjectStoryMemory: jest.fn(async () => ({ state, status: 'dirty', dirtyFromPosition: 0, lastError: '旧章节已修改' })),
    }));
    jest.doMock('../src/services/macroReplace', () => ({ processMacros: jest.fn(async (text: string) => text) }));
    const { buildContext } = require('../src/services/contextBuilder');
    const result = await buildContext(
      current,
      { strategy: 'sliding', slidingWindowSize: 1000, customRangeStart: 0, customRangeEnd: -1, includeResources: false, resourceBudget: 0, summaryBudgetTokens: 1000 },
      7,
      undefined,
      { storyMemoryMode: 'preview' },
    );
    expect(result.messages.some((item: { content: string }) => item.content.includes('故事全局状态'))).toBe(false);
    expect(result.trace).toContainEqual(
      expect.objectContaining({
        kind: 'story_memory',
        included: false,
        reason: expect.stringMatching(/不注入|失效|检查点/),
      }),
    );
    // Dirty checkpoint is omitted; continuity comes from pending bridge / recent text.
    expect(
      result.messages.some(
        (item: { content: string }) =>
          item.content.includes('林岚发现暗门') ||
          item.content.includes('相关历史章节事件'),
      ),
    ).toBe(true);
  });

  it('resolveStoryStateForRetrieval rejects dirty/empty/failed/rebuilding', () => {
    const state = staleEntityState();
    for (const status of ['dirty', 'empty', 'failed', 'rebuilding'] as const) {
      expect(
        resolveStoryStateForRetrieval({
          checkpoint: {
            state,
            status,
            dirtyFromPosition: status === 'dirty' ? 0 : null,
            lastError: '',
            updatedAt: '',
          },
          coverage: {
            checkpointThroughPosition: -1,
            pendingChapterIds: [],
            rawChapterIds: [],
            uncoveredChapterIds: [],
            hardDue: false,
            softDue: false,
          } as any,
          checkpointUpdated: false,
          blocked: false,
          blockReason: '',
        }),
      ).toBeNull();
    }
    expect(
      resolveStoryStateForRetrieval({
        checkpoint: {
          state,
          status: 'clean',
          dirtyFromPosition: null,
          lastError: '',
          updatedAt: '',
        },
        coverage: {} as any,
        checkpointUpdated: false,
        blocked: false,
        blockReason: '',
      }),
    ).toBe(state);
    expect(resolveStoryStateForRetrieval(null)).toBeNull();
    expect(
      resolveStoryStateForRetrieval({
        checkpoint: null,
        coverage: {} as any,
        checkpointUpdated: false,
        blocked: false,
        blockReason: '',
      }),
    ).toBeNull();
  });

  it('does not apply stale dirty entities when storyState is null (TF-IDF fallback)', () => {
    const docs = [
      {
        chapter: {
          ...previous,
          id: 10,
          position: 0,
          memory_summary: '旧角色甲把过期红钥匙交给旧角色乙。',
        },
        text: '旧角色甲把过期红钥匙交给旧角色乙。',
      },
      {
        chapter: {
          ...previous,
          id: 11,
          position: 1,
          memory_summary: '林岚在钟楼发现新线索。',
        },
        text: '林岚在钟楼发现新线索。',
      },
    ];
    const query = '旧角色甲 过期红钥匙 旧角色乙';
    const idf = buildIdfFromTexts(docs.map(d => d.text).concat([query]));
    const withStale = scoreMemoryCandidates(
      docs,
      query,
      idf,
      staleEntityState(),
    );
    const without = scoreMemoryCandidates(docs, query, idf, null);
    // Usable state would inject name/object/pair boosts; null must not.
    expect(withStale[0].entityBoost).toBeGreaterThan(0);
    expect(without.every(item => item.entityBoost === 0)).toBe(true);
    expect(without.every(item => item.pairBoost === 0)).toBe(true);
    expect(without.every(item => item.matchedObjects.length === 0)).toBe(true);
    // CHARACTER_NAME_BOOST still defined for clean path
    expect(CHARACTER_NAME_BOOST).toBeGreaterThan(0);
  });
});
