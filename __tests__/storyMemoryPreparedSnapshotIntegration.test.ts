/**
 * SPEC §10 — Real production wiring integration tests for V2.5.13.
 *
 * Covers the full chain that V2.5.12 unit tests treated as pure functions:
 *   prepareStoryMemoryForGeneration() → buildContext() →
 *   renderPreparedStoryMemoryContext() → resolveStoryStateForRetrieval()
 *
 * The V2.5.13 fix guarantees that a single `buildContext()` call uses the
 * SAME prepared Checkpoint snapshot for coverage, entity state, Renderer
 * text and trace — never a second DB read after prepare().
 */

import type { Chapter } from '../src/types/novel';
import { createEmptyStoryMemory } from '../src/services/storyMemory/storyMemoryDefaults';

// --- Mocks for database / macroReplace (same pattern as storyMemoryPrepare.test.ts) ---

const mockGetChapters = jest.fn();
const mockGetMemory = jest.fn();
const mockEnsure = jest.fn();
let getMemoryCallCount = 0;
let ensureCallCount = 0;

jest.mock('../src/services/database', () => ({
  getChaptersByProject: (...args: any[]) => mockGetChapters(...args),
  getProjectStoryMemory: (...args: any[]) => {
    getMemoryCallCount += 1;
    return mockGetMemory(...args);
  },
  ensureProjectStoryMemoryRow: (...args: any[]) => {
    ensureCallCount += 1;
    return mockEnsure(...args);
  },
  getCharactersByProject: jest.fn(async () => []),
  getWorldbookEntriesByProject: jest.fn(async () => []),
  getNotesByProject: jest.fn(async () => []),
  getNotesContentByIds: jest.fn(async () => ({})),
  getProjectNoteConfig: jest.fn(async () => null),
}));

jest.mock('../src/services/macroReplace', () => ({
  processMacros: jest.fn(async (text: string) => text),
}));

import { prepareStoryMemoryForGeneration } from '../src/services/storyMemory/storyMemoryPrepare';
import {
  buildContext,
  renderPreparedStoryMemoryContext,
  resolveStoryStateForRetrieval,
} from '../src/services/contextBuilder';
import type { ProjectStoryMemoryRecord } from '../src/data/repositories/storyMemoryRepository';

function makeChapter(
  id: number,
  position: number,
  content = '',
  summary = '',
  title = `第${position + 1}章`,
): Chapter {
  return {
    id,
    project_id: 1,
    position,
    title,
    synopsis: '',
    content,
    status: 'final',
    summary_json: null,
    memory_summary: summary,
    memory_summary_tokens: 0,
    finalized_at: null,
    created_at: '',
    updated_at: '',
  };
}

function smallCleanState(through: number) {
  const state = createEmptyStoryMemory(1);
  state.throughChapterPosition = through;
  state.throughChapterId = through + 1;
  state.metadata.status = 'clean';
  state.characters.char_lan = {
    id: 'char_lan',
    canonicalName: '林岚',
    aliases: ['小岚'],
    role: '调查员',
    immutableProfile: { identity: '', stableTraits: [], affiliations: [] },
    currentState: {
      location: '钟楼',
      physicalState: '正常',
      emotionalState: '警惕',
      currentGoal: '查案',
      knowledge: [],
      possessions: ['银钥匙'],
      secrets: [],
    },
    status: 'active',
    firstSeenChapterId: 1,
    firstSeenPosition: 0,
    lastChangedChapterId: through + 1,
    lastChangedPosition: through,
    evidenceChapterIds: [1],
  };
  return state;
}

function cleanRecord(through: number): ProjectStoryMemoryRecord {
  return {
    state: smallCleanState(through),
    status: 'clean',
    dirtyFromPosition: null,
    lastError: '',
    updatedAt: '',
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  getMemoryCallCount = 0;
  ensureCallCount = 0;
});

describe('SPEC §10.1 — prepareStoryMemoryForGeneration integration', () => {
  it('returns usable checkpoint and complete coverage when clean & through<target', async () => {
    const chapters = [
      makeChapter(1, 0, '正文一', '摘要一'),
      makeChapter(2, 1, '正文二', '摘要二'),
      makeChapter(3, 2, '正文三', '摘要三'),
      makeChapter(4, 3, '正文四', '摘要四'),
    ];
    mockGetChapters.mockResolvedValue(chapters);
    mockGetMemory.mockResolvedValue(cleanRecord(1));

    const prepared = await prepareStoryMemoryForGeneration(
      1,
      chapters[3],
      { slidingWindowSize: 4000 } as any,
      { mode: 'preview' },
    );

    expect(prepared.blocked).toBe(false);
    expect(prepared.checkpoint).not.toBeNull();
    expect(prepared.checkpoint?.status).toBe('clean');
    expect(prepared.coverage.checkpointThroughPosition).toBe(1);
    expect(prepared.coverage.uncoveredChapterIds).toEqual([]);
  });

  it('coverage insufficient in preview mode blocks generation with explicit reason', async () => {
    const huge = '超长正文'.repeat(800);
    const chapters = [
      makeChapter(1, 0, huge, ''),
      makeChapter(2, 1, huge, ''),
      makeChapter(3, 2, '当前正文'),
    ];
    mockGetChapters.mockResolvedValue(chapters);
    mockGetMemory.mockResolvedValue({
      state: { throughChapterPosition: -1, throughChapterId: null },
      status: 'empty',
      dirtyFromPosition: null,
      lastError: '',
      updatedAt: '',
    });

    const prepared = await prepareStoryMemoryForGeneration(
      1,
      chapters[2],
      { slidingWindowSize: 10 } as any,
      { mode: 'preview' },
    );

    expect(prepared.blocked).toBe(true);
    expect(prepared.blockReason).toContain('覆盖不足');
    // Coverage-insufficient preview must NOT silently fall back to future state.
    expect(prepared.checkpoint).toBeNull();
  });
});

describe('SPEC §10.2 — future / same-position Checkpoint assertions', () => {
  it('future checkpoint: prepared.checkpoint === null and downstream all collapse', async () => {
    const chapters = [
      makeChapter(1, 0, '正文一', '摘要一'),
      makeChapter(2, 1, '正文二', '摘要二'),
      makeChapter(3, 2, '正文三', '摘要三'),
      makeChapter(4, 3, '正文四', '摘要四'),
    ];
    // DB says clean through 5 — but target position is 3 → future/same.
    mockGetChapters.mockResolvedValue(chapters);
    mockGetMemory.mockResolvedValue(cleanRecord(5));

    const prepared = await prepareStoryMemoryForGeneration(
      1,
      chapters[3], // target position = 3
      { slidingWindowSize: 4000 } as any,
      { mode: 'preview' },
    );

    expect(prepared.checkpoint).toBeNull();
    expect(prepared.coverage.checkpointThroughPosition).toBe(-1);
    expect(resolveStoryStateForRetrieval(prepared)).toBeNull();

    // Renderer must NOT inject any Story Memory text for a future checkpoint.
    const rendered = renderPreparedStoryMemoryContext(
      1,
      chapters[3],
      prepared.checkpoint,
      8000,
      { retrievalUserPrompt: '林岚继续调查' },
    );
    expect(rendered.text).toBe('');
  });

  it('preview never triggers LLM (prepare does not spend tokens on catch-up)', async () => {
    const chapters = [
      makeChapter(1, 0, '正文一', '摘要一'),
      makeChapter(2, 1, '正文二', '摘要二'),
      makeChapter(3, 2, '当前正文'),
    ];
    mockGetChapters.mockResolvedValue(chapters);
    mockGetMemory.mockResolvedValue(cleanRecord(1));

    const beforeEnsure = ensureCallCount;
    const beforeMemory = getMemoryCallCount;
    await prepareStoryMemoryForGeneration(
      1,
      chapters[2],
      { slidingWindowSize: 4000 } as any,
      { mode: 'preview' },
    );
    // Preview path never calls ensure (no LLM batch rebuild).
    expect(ensureCallCount).toBe(beforeEnsure);
    // prepare reads the checkpoint row once.
    expect(getMemoryCallCount).toBeGreaterThan(beforeMemory);
  });
});

describe('SPEC §10.3 — single snapshot invariant (one buildContext call)', () => {
  it('Scenario A: prepare returns clean → DB marked dirty afterwards → Renderer still uses prepared clean snapshot', async () => {
    const chapters = [
      makeChapter(1, 0, '正文一', '摘要一：林岚发现暗门。'),
      makeChapter(2, 1, '正文二', '摘要二：周恪承诺保密。'),
      makeChapter(3, 2, '当前正文', '', '当前'),
    ];

    // First call (prepare) returns clean; any subsequent DB read returns dirty.
    let memoryCallIndex = 0;
    mockGetMemory.mockImplementation(() => {
      memoryCallIndex += 1;
      if (memoryCallIndex === 1) {
        return Promise.resolve(cleanRecord(1));
      }
      // If the main buildContext path re-reads, it would see dirty and skip injection.
      return Promise.resolve({
        state: smallCleanState(1),
        status: 'dirty',
        dirtyFromPosition: 0,
        lastError: 'race',
        updatedAt: '',
      } as ProjectStoryMemoryRecord);
    });
    mockGetChapters.mockResolvedValue(chapters);
    mockEnsure.mockResolvedValue(cleanRecord(1));

    const beforeMemory = getMemoryCallCount;
    const result = await buildContext(
      chapters[2],
      {
        strategy: 'sliding',
        slidingWindowSize: 4000,
        customRangeStart: 0,
        customRangeEnd: -1,
        includeResources: false,
        resourceBudget: 0,
        summaryBudgetTokens: 2000,
        episodicMemoryBudgetTokens: 1000,
        storyStateBudgetTokens: 4000,
      },
      1,
      undefined,
      { storyMemoryMode: 'preview', retrievalUserPrompt: '林岚继续' },
    );

    // Single buildContext call: prepare reads once, Renderer MUST NOT re-read.
    const memoryReadsThisCall = getMemoryCallCount - beforeMemory;
    expect(memoryReadsThisCall).toBe(1);

    // The clean checkpoint (through=1, < target position=2) must be injected.
    expect(result.messages.some(m => m.content.includes('林岚'))).toBe(true);
    const traceStory = result.trace.find(t => t.kind === 'story_memory');
    expect(traceStory).toBeDefined();
    expect(traceStory?.reason).toContain('第 2 章');
    expect(traceStory?.included).toBe(true);
  });

  it('Scenario B: prepare returns null → DB turns clean afterwards → main path still does NOT inject', async () => {
    const chapters = [
      makeChapter(1, 0, '正文一', '摘要一'),
      makeChapter(2, 1, '正文二', '摘要二'),
      makeChapter(3, 2, '当前', '', '当前'),
    ];

    // prepare returns a future checkpoint (target=2, through=5) → unusable.
    let memoryCallIndex = 0;
    mockGetMemory.mockImplementation(() => {
      memoryCallIndex += 1;
      if (memoryCallIndex === 1) {
        return Promise.resolve(cleanRecord(5));
      }
      // If anything re-reads, it would appear usable — but main path must not re-read.
      return Promise.resolve(cleanRecord(1));
    });
    mockGetChapters.mockResolvedValue(chapters);
    mockEnsure.mockResolvedValue(cleanRecord(5));

    const beforeMemory = getMemoryCallCount;
    const result = await buildContext(
      chapters[2],
      {
        strategy: 'sliding',
        slidingWindowSize: 4000,
        customRangeStart: 0,
        customRangeEnd: -1,
        includeResources: false,
        resourceBudget: 0,
        summaryBudgetTokens: 2000,
        episodicMemoryBudgetTokens: 1000,
        storyStateBudgetTokens: 4000,
      },
      1,
      undefined,
      { storyMemoryMode: 'preview', retrievalUserPrompt: '林岚' },
    );

    // Only one read total — prepare's. Never re-read inside buildContext.
    expect(getMemoryCallCount - beforeMemory).toBe(1);

    // Even though second-read would have been clean & usable, the prepared
    // snapshot was null → no Story Memory injection. The phrase
    // "【故事全局状态｜截至...】" only appears in an injected Story Memory block.
    const storyMessages = result.messages.filter(m =>
      m.content.includes('【故事全局状态'),
    );
    expect(storyMessages.length).toBe(0);
    const traceStory = result.trace.find(t => t.kind === 'story_memory');
    // Future-checkpoint path adds a trace entry marking it unusable.
    if (traceStory) {
      expect(traceStory.included).toBe(false);
    }
  });

  it('Scenario C: future checkpoint → no injection + entity state null + preview does not call LLM', async () => {
    const chapters = [
      makeChapter(1, 0, '正文一', '摘要一'),
      makeChapter(2, 1, '正文二', '摘要二'),
      makeChapter(3, 2, '正文三', '摘要三'),
      makeChapter(4, 3, '当前', '', '当前'),
    ];
    // DB clean through 10, target position 3 → future.
    mockGetChapters.mockResolvedValue(chapters);
    mockGetMemory.mockResolvedValue(cleanRecord(10));

    const beforeMemory = getMemoryCallCount;
    const beforeEnsure = ensureCallCount;
    const result = await buildContext(
      chapters[3],
      {
        strategy: 'sliding',
        slidingWindowSize: 4000,
        customRangeStart: 0,
        customRangeEnd: -1,
        includeResources: false,
        resourceBudget: 0,
        summaryBudgetTokens: 2000,
        episodicMemoryBudgetTokens: 1000,
        storyStateBudgetTokens: 4000,
      },
      1,
      undefined,
      { storyMemoryMode: 'preview', retrievalUserPrompt: '林岚继续调查' },
    );

    // Preview mode + future checkpoint → no ensure (no LLM).
    expect(ensureCallCount - beforeEnsure).toBe(0);
    // Only prepare's single read.
    expect(getMemoryCallCount - beforeMemory).toBe(1);

    // No future entity state leaks into messages. "【故事全局状态" only appears
    // in an injected Story Memory block, so its absence proves non-injection.
    const futureStoryMessage = result.messages.find(m =>
      m.content.includes('【故事全局状态'),
    );
    expect(futureStoryMessage).toBeUndefined();

    // Trace shows the future-checkpoint non-injection. Coverage branch records
    // `尚无检查点` because checkpointThroughPosition=-1 after eligibility drops
    // the future snapshot; `included: false` is the contract.
    const traceStory = result.trace.find(t => t.kind === 'story_memory');
    expect(traceStory).toBeDefined();
    expect(traceStory?.included).toBe(false);
    expect(traceStory?.reason).toMatch(/尚无检查点|不注入|检查点不可用/);
  });
});

describe('SPEC §10.4 — renderPreparedStoryMemoryContext is a pure function', () => {
  it('never accesses the DB — uses only the supplied snapshot', async () => {
    const beforeMemory = getMemoryCallCount;
    const beforeEnsure = ensureCallCount;
    const chapter = makeChapter(2, 1, '', '', '当前');
    const result = renderPreparedStoryMemoryContext(
      1,
      chapter,
      cleanRecord(0),
      4000,
      { retrievalUserPrompt: '林岚继续' },
    );
    expect(getMemoryCallCount).toBe(beforeMemory);
    expect(ensureCallCount).toBe(beforeEnsure);
    // Clean checkpoint through 0 < target 1 → injected.
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.traceItems[0]?.included).toBe(true);
  });

  it('null checkpoint yields empty text and empty traceItems', () => {
    const chapter = makeChapter(2, 1, '', '', '当前');
    const result = renderPreparedStoryMemoryContext(
      1,
      chapter,
      null,
      4000,
      { retrievalUserPrompt: '林岚继续' },
    );
    expect(result.text).toBe('');
    expect(result.traceItems).toEqual([]);
  });
});

describe('SPEC §10.5 — resolveStoryStateForRetrieval contract', () => {
  it('returns null for null prepared and for non-clean checkpoint', () => {
    expect(resolveStoryStateForRetrieval(null)).toBeNull();
    const state = smallCleanState(1);
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
            pendingChapters: [],
            seamChapter: null,
            rawChapterIds: [],
            episodicFallbackChapterIds: [],
            uncoveredChapterIds: [],
            estimatedRawTokens: 0,
            hardDue: false,
            reason: '',
          },
          checkpointUpdated: false,
          blocked: false,
          blockReason: '',
        }),
      ).toBeNull();
    }
  });

  it('returns the clean state when checkpoint is clean', () => {
    const state = smallCleanState(1);
    const result = resolveStoryStateForRetrieval({
      checkpoint: {
        state,
        status: 'clean',
        dirtyFromPosition: null,
        lastError: '',
        updatedAt: '',
      },
      coverage: {
        checkpointThroughPosition: 1,
        pendingChapters: [],
        seamChapter: null,
        rawChapterIds: [],
        episodicFallbackChapterIds: [],
        uncoveredChapterIds: [],
        estimatedRawTokens: 0,
        hardDue: false,
        reason: '',
      },
      checkpointUpdated: false,
      blocked: false,
      blockReason: '',
    });
    expect(result).toBe(state);
  });
});
