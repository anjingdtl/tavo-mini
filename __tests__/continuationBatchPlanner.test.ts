/**
 * Continuation batch planner tests (Round 2, doc §7 / §8 / §27 / §35.1).
 *
 * GO-2 gates:
 *   - Source bounded (materials only via continuationSourceReader);
 *   - Canon authority correct (CanonQueryService);
 *   - N strict (shared strict validation);
 *   - Protected overflow ⇒ 0 LLM calls;
 *   - Future Source Leakage = 0 (no future-chapter text in planner prompt);
 *   - P0 Future Plan Leakage = 0 (per-chapter instruction builder).
 */
jest.mock('../src/services/llm', () => {
  const actual = jest.requireActual('../src/services/llm');
  return {
    ...actual,
    callLLMResult: jest.fn(),
    resolveLLMRequestConfig: jest.fn(async () => ({ ...testLlmConfig })),
  };
});

jest.mock('../src/services/continuation/chapterNumbering/continuationChapterNumbering', () => ({
  getNextContinuationChapterPosition: jest.fn(async () => 1),
  getContinuationChapterNumbering: jest.fn(async () => ({
    boundaryChapterNumber: 2,
    getDisplayNumber: (position: number) => 3 + position,
    getDefaultTitle: (position: number) => `第 ${3 + position} 章`,
    getDisplayTitle: (chapter: { title: string }) => chapter.title,
  })),
}));

jest.mock('../src/services/continuation/continuationSourceReader', () => ({
  continuationSourceReader: {
    getSnapshot: jest.fn(),
    listBoundedSourceChapters: jest.fn(),
    listBoundedSourceChaptersForRange: jest.fn(),
    listBoundedSourceChapterMetas: jest.fn(),
  },
}));

jest.mock('../src/services/continuation/canon/canonQueryService', () => ({
  CanonQueryService: {
    getActiveSnapshot: jest.fn(),
    getContextBundle: jest.fn(),
  },
}));

jest.mock('../src/services/continuation/generation/continuationStateService', () => ({
  getEffectiveContinuationState: jest.fn(),
}));

jest.mock('../src/services/database', () => ({
  getChaptersByProject: jest.fn(async () => [
    { id: 21, position: 0, title: '第 4 章', synopsis: '已续写第一章概要' },
  ]),
  getProjectStoryMemory: jest.fn(async () => ({
    status: 'clean',
    state: {
      mainline: { summary: '主线摘要', goal: '主线目标' },
      characters: { a: { name: '林一', summary: '状态良好' } },
    },
  })),
}));

import { callLLMResult } from '../src/services/llm';
import { continuationSourceReader } from '../src/services/continuation/continuationSourceReader';
import { CanonQueryService } from '../src/services/continuation/canon/canonQueryService';
import { getEffectiveContinuationState } from '../src/services/continuation/generation/continuationStateService';
import {
  collectContinuationBatchPlannerMaterials,
  createContinuationBatchChapterPlan,
  ContinuationBatchPlannerError,
} from '../src/services/multiChapterBatch/continuationBatchPlanner';
import {
  compileContinuationBatchPlannerRequest,
  buildContinuationPlannerMessages,
} from '../src/services/multiChapterBatch/continuationBatchPlannerCompiler';
import { buildContinuationBatchChapterInstruction } from '../src/services/multiChapterBatch/continuationBatchInstruction';

const mockCall = callLLMResult as jest.Mock;
/** Mutable LLM config holder so tests can shrink the context window. */
const testLlmConfig = { id: 1, context_window: 128000 };
const mockGetSnapshot = continuationSourceReader.getSnapshot as jest.Mock;
const mockListMetas =
  continuationSourceReader.listBoundedSourceChapterMetas as jest.Mock;
const mockListRange =
  continuationSourceReader.listBoundedSourceChaptersForRange as jest.Mock;
const mockGetActiveSnapshot = CanonQueryService.getActiveSnapshot as jest.Mock;
const mockGetContextBundle = CanonQueryService.getContextBundle as jest.Mock;
const mockEffectiveState = getEffectiveContinuationState as jest.Mock;

const SNAPSHOT = {
  projectId: 1,
  sourceId: 7,
  sourceVersion: 3,
  normalizedSha256: 'sha-abc',
  parserVersion: 'p1',
  normalizationVersion: 'n1',
  boundary: { chapterId: 11, chapterPosition: 1, charOffsetExclusive: 500 },
};

/** Text that exists ONLY past the boundary — must never reach a prompt. */
const FUTURE_SOURCE_TEXT = 'FUTURE_LEAK_MARKER_未来章节的绝密伏笔';
const BOUNDARY_TAIL = '密室的大门在月光下缓缓打开，尘埃落定。';

function seedBoundedReader() {
  mockGetSnapshot.mockResolvedValue(SNAPSHOT);
  mockListMetas.mockResolvedValue([
    { position: 0, title: '旧宅夜话' },
    { position: 1, title: '月下密室' },
  ]);
  mockListRange.mockResolvedValue([
    { position: 1, title: '月下密室', content: `${BOUNDARY_TAIL}` },
  ]);
}

function seedCanon() {
  mockGetActiveSnapshot.mockResolvedValue({
    id: 'snap-1',
    revision: 8,
    status: 'ready',
    boundaryPosition: 1,
  });
  mockGetContextBundle.mockResolvedValue({
    snapshot: { id: 'snap-1', revision: 8 },
    worldRules: [
      {
        id: 1,
        constraintLevel: 'hard',
        title: '死亡不可逆',
        description: '已死亡角色不得复活',
      },
    ],
    characters: [
      { id: 5, canonicalName: '林一', description: '侦探', importance: 'main' },
    ],
    characterStates: [
      {
        characterId: 5,
        chapterPosition: 1,
        location: '旧宅',
        physicalState: null,
        emotionalState: '警惕',
        identityState: null,
        organizationState: null,
        currentGoal: '查清密室',
        possessionsJson: '[]',
        abilitiesStateJson: '[]',
        aliveState: 'alive',
        summary: '在旧宅调查密室',
      },
    ],
    relationships: [],
    experiences: [],
    knowledge: [],
    plotThreads: [
      {
        id: 9,
        title: '密室之谜',
        description: '密室的来历未明',
        level: 'main',
        status: 'active',
        importance: 5,
        startPosition: 0,
        lastAdvancedPosition: 1,
        resolvedPosition: null,
        establishedFactsJson: '[]',
        unresolvedQuestionsJson: '["密室是谁建造的？"]',
        expectedDirectionsJson: '[]',
      },
    ],
    timelineEvents: [],
    evidenceRefs: [],
    estimatedTokens: 100,
    omittedReasonCounts: {},
  });
  mockEffectiveState.mockResolvedValue({
    characterStates: [
      {
        ref: { refType: 'canon_character', id: 5 },
        summary: '续写层状态：持手电在密室内',
        fields: {},
        source: 'event',
      },
    ],
    relationships: [],
    plotThreads: [],
    knowledge: [],
    freshness: {
      canonReady: true,
      storyMemoryStatus: 'clean',
      pendingStateExtractionCount: 0,
      pendingMajorProposalCount: 0,
      dirtyFromPosition: null,
    },
  });
}

const VALID_PLAN_JSON = JSON.stringify({
  chapters: [
    {
      ordinal: 1,
      title: '夜访旧宅',
      synopsis: '主角深夜再访旧宅，寻找密室线索。',
      keyBeats: ['发现密室入口'],
      carryIn: '承接月下密室结尾',
      carryOut: '留下机关线索',
      targetWords: 3000,
    },
    {
      ordinal: 2,
      title: '机关之下',
      synopsis: '密室机关被触发，主角陷入危机。',
      keyBeats: ['机关触发'],
      carryIn: '承接机关线索',
      carryOut: '危机悬念',
      targetWords: 3000,
    },
  ],
});

describe('continuation batch planner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    seedBoundedReader();
    seedCanon();
    mockCall.mockReset();
  });

  describe('materials (doc §7.2 / §7.3)', () => {
    it('collects bounded source, canon, state, continuation and memory digests', async () => {
      const materials = await collectContinuationBatchPlannerMaterials(1);
      expect(mockGetSnapshot).toHaveBeenCalledWith(1);
      // Boundary read is exactly ONE chapter at the boundary position.
      expect(mockListRange).toHaveBeenCalledWith(SNAPSHOT, 1, 1);
      expect(materials.sourceBoundaryText).toContain(BOUNDARY_TAIL);
      expect(materials.sourceBoundaryText).toContain('原著第 2 章');
      expect(materials.canonHardFactsText).toContain('死亡不可逆');
      expect(materials.canonHardFactsText).toContain('在旧宅调查密室');
      expect(materials.continuationStateText).toContain('续写层状态');
      expect(materials.recentContinuationText).toContain('已续写第一章概要');
      expect(materials.storyMemoryText).toContain('主线摘要');
    });

    it('never lets future source text into the planner prompt (P0)', async () => {
      // Even if the underlying world contained future chapters, the reader is
      // the only path — and its range reads are boundary-bounded.
      const materials = await collectContinuationBatchPlannerMaterials(1);
      const messages = buildContinuationPlannerMessages({
        sourcePrompt: '本批目标',
        chapterCount: 2,
        targetWordsPerChapter: 3000,
        clippedMaterials: materials,
      });
      const prompt = messages.map(m => m.content).join('\n');
      expect(prompt).not.toContain(FUTURE_SOURCE_TEXT);
      expect(prompt).toContain(BOUNDARY_TAIL);
    });
  });

  describe('compiler (doc §27)', () => {
    it('blocks with 0 LLM calls when protected material overflows', () => {
      const result = compileContinuationBatchPlannerRequest({
        sourcePrompt: 'x'.repeat(200),
        chapterCount: 2,
        targetWordsPerChapter: 3000,
        materials: {
          sourceBoundaryText: 'y'.repeat(50_000),
          canonHardFactsText: 'z'.repeat(50_000),
          continuationStateText: '',
          recentContinuationText: '',
          storyMemoryText: '',
        },
        contextWindow: 1000,
        reservedOutputTokens: 4000,
      });
      expect(result.ready).toBe(false);
    });

    it('keeps goal + N + protocol + boundary + canon mandatory', () => {
      const result = compileContinuationBatchPlannerRequest({
        sourcePrompt: '本批目标文本',
        chapterCount: 3,
        targetWordsPerChapter: 2600,
        materials: {
          sourceBoundaryText: BOUNDARY_TAIL,
          canonHardFactsText: '死亡不可逆',
          continuationStateText: '',
          recentContinuationText: '',
          storyMemoryText: '',
        },
        contextWindow: 128000,
        reservedOutputTokens: 4000,
      });
      expect(result.ready).toBe(true);
      if (result.ready) {
        const prompt = result.messages.map(m => m.content).join('\n');
        expect(prompt).toContain('本批目标文本');
        expect(prompt).toContain('【章节数 N】3');
        expect(prompt).toContain('约 2600 字');
        expect(prompt).toContain(BOUNDARY_TAIL);
        expect(prompt).toContain('死亡不可逆');
        expect(prompt).toContain('chapters');
      }
    });
  });

  describe('createContinuationBatchChapterPlan', () => {
    it('accepts a strict N-match plan and returns hash + fingerprint', async () => {
      mockCall.mockResolvedValue({ text: VALID_PLAN_JSON });
      const result = await createContinuationBatchChapterPlan({
        projectId: 1,
        sourcePrompt: '本批目标',
        chapterCount: 2,
        targetWordsPerChapter: 3000,
        materials: await collectContinuationBatchPlannerMaterials(1),
      });
      expect(result.plan.chapters).toHaveLength(2);
      expect(result.plan.chapters[0].title).toBe('夜访旧宅');
      expect(result.plan.chapters[0].carryIn).toBe('承接月下密室结尾');
      expect(result.plan.chapters[0].targetWords).toBe(3000);
      expect(result.hash).toHaveLength(32);
      expect(mockCall).toHaveBeenCalledTimes(1);
    });

    it('repairs once on invalid structure then fails closed (N strict)', async () => {
      mockCall
        .mockResolvedValueOnce({ text: '{"chapters": []}' })
        .mockResolvedValueOnce({ text: '{"chapters": []}' });
      await expect(
        createContinuationBatchChapterPlan({
          projectId: 1,
          sourcePrompt: '本批目标',
          chapterCount: 2,
          targetWordsPerChapter: 3000,
          materials: await collectContinuationBatchPlannerMaterials(1),
        }),
      ).rejects.toThrow(ContinuationBatchPlannerError);
      expect(mockCall).toHaveBeenCalledTimes(2);
    });

    it('falls back to prose chapter parsing when no JSON is returned', async () => {
      mockCall.mockResolvedValue({
        text: '第 1 章 发现密室\n主角找到密室入口。\n第 2 章 机关之下\n机关被触发。',
      });
      const result = await createContinuationBatchChapterPlan({
        projectId: 1,
        sourcePrompt: '本批目标',
        chapterCount: 2,
        targetWordsPerChapter: 3000,
        materials: await collectContinuationBatchPlannerMaterials(1),
      });
      expect(result.plan.chapters).toHaveLength(2);
      expect(result.plan.chapters[0].keyBeats.length).toBeGreaterThan(0);
    });

    it('throws BATCH_CONTEXT_BUDGET_BLOCKED with 0 LLM calls on protected overflow', async () => {
      testLlmConfig.context_window = 2000;
      try {
        await expect(
          createContinuationBatchChapterPlan({
            projectId: 1,
            sourcePrompt: '本批目标',
            chapterCount: 2,
            targetWordsPerChapter: 3000,
            materials: {
              sourceBoundaryText: 'y'.repeat(60_000),
              canonHardFactsText: 'z'.repeat(60_000),
              continuationStateText: '',
              recentContinuationText: '',
              storyMemoryText: '',
            },
            reservedOutputTokens: 4000,
          }),
        ).rejects.toMatchObject({ code: 'BATCH_CONTEXT_BUDGET_BLOCKED' });
        expect(mockCall).not.toHaveBeenCalled();
      } finally {
        testLlmConfig.context_window = 128000;
      }
    });
  });
});

describe('buildContinuationBatchChapterInstruction (P0 Future Plan Leakage)', () => {
  const batch = { sourcePrompt: '找出真凶', writingMode: 'continuation' as const };

  it('includes ONLY the current chapter projection (doc §8 / §35.2)', () => {
    const item1 = {
      ordinal: 1,
      title: '发现密室',
      synopsis: 'Item1 梗概：进入密室',
      keyBeatsJson: JSON.stringify(['推开密室石门', '发现旧照片']),
      carryIn: '承接月下线索',
      carryOut: '指向凶手身份',
      targetWords: 3000,
    };
    const instruction = buildContinuationBatchChapterInstruction(batch, item1);
    expect(instruction).toContain('找出真凶');
    expect(instruction).toContain('发现密室');
    expect(instruction).toContain('Item1 梗概');
    expect(instruction).toContain('推开密室石门');
    expect(instruction).toContain('承接月下线索');
    expect(instruction).toContain('约 3000 字');
    // Future item details must not appear — the builder never receives them.
    expect(instruction).not.toContain('确认凶手是 A');
    expect(instruction).not.toContain('A 将伏击主角');
  });

  it('rejects malformed key beats JSON gracefully', () => {
    const instruction = buildContinuationBatchChapterInstruction(batch, {
      ordinal: 1,
      title: 't',
      synopsis: 's',
      keyBeatsJson: 'not-json',
      carryIn: null,
      carryOut: null,
      targetWords: 2000,
    });
    expect(instruction).not.toContain('not-json');
    expect(instruction).toContain('约 2000 字');
  });
});
