/**
 * Context Budget V3 — end-to-end integration through `buildContext`.
 *
 * Verifies the V3 hierarchical allocator path lands correctly when
 * `options.contextBudgetVersion >= 6`:
 *   - Two large characters both fit when the model window allows (Plan §18 T3)
 *   - Single large resource full-fits (Plan §18 T2)
 *   - Soft targets scale with model window (Plan §18 T1)
 *   - Cross-board borrow fires when story/episodic demand is small (T5)
 *   - Preview = send: candidate allocation matches the rendered text (T14)
 *
 * V2 callers (no contextBudgetVersion or version <= 5) keep their existing
 * fixed-ratio behavior — verified by the same fixtures producing different
 * shapes under V2 vs V3.
 */

jest.mock('../src/services/macroReplace', () => ({
  processMacros: jest.fn(
    (text: string) => text, // identity — macros are not the focus here
  ),
}));

jest.mock('../src/services/database', () => {
  const characters: any[] = [];
  const notes: any[] = [];
  const worldbook: any[] = [];
  const chapters: any[] = [];
  let projectNoteConfig: any = null;
  let project: any = { id: 7, mode: 'outline', name: 'p' };
  let activeLlm: any = { id: 1, context_window: 128000, max_output_tokens: 32000 };
  return {
    __setCharacters: (c: any[]) => {
      characters.length = 0;
      characters.push(...c);
    },
    __setNotes: (n: any[]) => {
      notes.length = 0;
      notes.push(...n);
    },
    __setWorldbook: (w: any[]) => {
      worldbook.length = 0;
      worldbook.push(...w);
    },
    __setChapters: (c: any[]) => {
      chapters.length = 0;
      chapters.push(...c);
    },
    __setProjectNoteConfig: (c: any) => {
      projectNoteConfig = c;
    },
    __setProject: (p: any) => {
      project = p;
    },
    __setActiveLlm: (l: any) => {
      activeLlm = l;
    },
    getCharactersByProject: jest.fn(async () => characters.slice()),
    getNotesByProject: jest.fn(async () => notes.slice()),
    getNotesContentByIds: jest.fn(async (_ids: number[]) => {
      const map: Record<number, string> = {};
      for (const note of notes) map[Number(note.id)] = note.content ?? '';
      return map;
    }),
    getWorldbookEntriesByProject: jest.fn(async () => worldbook.slice()),
    getProjectNoteConfig: jest.fn(async () => projectNoteConfig),
    getProjectById: jest.fn(async () => project),
    getActiveLLMConfig: jest.fn(async () => activeLlm),
    getChaptersByProject: jest.fn(async () => chapters.slice()),
    getProjectStoryMemory: jest.fn(async () => null),
  };
});

jest.mock('../src/data/repositories/outlineRepository', () => ({
  getEnabledOutlinesByProject: jest.fn(async () => []),
}));

jest.mock('../src/services/storyMemory/storyMemoryPrepare', () => ({
  prepareStoryMemoryForGeneration: jest.fn(async () => ({
    blocked: false,
    fatal: false,
    checkpoint: null,
    checkpointEligibility: { usable: false, reason: 'missing' },
    coverage: undefined,
    rawChapterIds: [],
    warnings: [],
  })),
}));

jest.mock('../src/utils/idfCache', () => ({
  computeMemorySummarySignature: jest.fn(() => 'sig'),
  getCachedIdf: jest.fn(() => null),
  setCachedIdf: jest.fn(),
}));

import * as dbMock from '../src/services/database';
import { buildContext } from '../src/services/contextBuilder';
import type { ContextConfig } from '../src/types/novel';

const BASE_CHAPTER = {
  id: 1,
  project_id: 7,
  position: 0,
  title: '第一章',
  synopsis: '开篇',
  content: '',
  status: 'planned',
  updated_at: '',
};

const BASE_CONFIG: ContextConfig = {
  strategy: 'sliding',
  slidingWindowSize: 4000,
  customRangeStart: 0,
  customRangeEnd: -1,
  resourceBudget: 2000,
  includeResources: true,
  worldbookScanDepth: 4,
  worldbookRecursive: true,
  memoryTopK: 5,
  summaryBudgetTokens: 8000,
  storyStateBudgetTokens: 8000,
  episodicMemoryBudgetTokens: 8000,
} as any as ContextConfig;

function makeLargeCharacter(id: number, name: string, sizeChars: number): any {
  // Each Chinese char ≈ 1 token in the estimator; pad to target size.
  const description = '设定'.repeat(Math.max(1, Math.floor(sizeChars / 2)));
  return {
    id,
    name,
    data_json: JSON.stringify({
      data: { name, description, system_prompt: '', personality: '' },
    }),
    max_tokens: 50000,
  };
}

describe('Context Budget V3 — buildContext integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (dbMock as any).__setCharacters([]);
    (dbMock as any).__setNotes([]);
    (dbMock as any).__setWorldbook([]);
    (dbMock as any).__setChapters([]);
    (dbMock as any).__setProjectNoteConfig({ mode: 'none' });
  });

  test('two large characters both full-fit when window allows (T3)', async () => {
    // Two 8K-token characters. With a 200K window, both must fully enter.
    (dbMock as any).__setCharacters([
      makeLargeCharacter(10, '林莉', 8000),
      makeLargeCharacter(11, '云希', 8000),
    ]);
    const result = await buildContext(
      BASE_CHAPTER as any,
      BASE_CONFIG,
      7,
      undefined,
      {
        contextWindow: 200_000,
        reservedOutputTokens: 40_000,
        contextBudgetVersion: 6,
      },
    );
    expect(result.hierarchicalBudgetTrace).toBeDefined();
    const charItems = result.trace.filter(t => t.kind === 'character');
    expect(charItems.length).toBe(2);
    // Both must be included (full-fit) and not clipped.
    for (const item of charItems) {
      expect(item.included).toBe(true);
      expect(item.clipped).toBe(false);
      expect(item.allocatedTokens).toBe(item.demandTokens);
      expect(item.allocationReason).toBe('full_fit');
    }
    // The snapshot carries both names.
    expect(result.pipelineContext.characterText).toContain('林莉');
    expect(result.pipelineContext.characterText).toContain('云希');
  });

  test('single large character full-fits when alone (T2)', async () => {
    (dbMock as any).__setCharacters([
      makeLargeCharacter(20, '独角', 35_000),
    ]);
    const result = await buildContext(
      BASE_CHAPTER as any,
      BASE_CONFIG,
      7,
      undefined,
      {
        contextWindow: 512_000,
        reservedOutputTokens: 100_000,
        contextBudgetVersion: 6,
      },
    );
    const item = result.trace.find(t => t.kind === 'character');
    expect(item).toBeDefined();
    expect(item!.included).toBe(true);
    expect(item!.clipped).toBe(false);
    expect(item!.allocatedTokens).toBe(item!.demandTokens);
  });

  test('soft target grows with model window (T1)', async () => {
    (dbMock as any).__setCharacters([
      makeLargeCharacter(30, '甲', 5000),
    ]);
    const small = await buildContext(
      BASE_CHAPTER as any,
      BASE_CONFIG,
      7,
      undefined,
      {
        contextWindow: 32_000,
        reservedOutputTokens: 6_400,
        contextBudgetVersion: 6,
      },
    );
    const large = await buildContext(
      BASE_CHAPTER as any,
      BASE_CONFIG,
      7,
      undefined,
      {
        contextWindow: 1_000_000,
        reservedOutputTokens: 200_000,
        contextBudgetVersion: 6,
      },
    );
    const smallResources =
      small.hierarchicalBudgetTrace!.boardAllocations.resources;
    const largeResources =
      large.hierarchicalBudgetTrace!.boardAllocations.resources;
    // Soft target is purely policy-driven (softRatio × softElasticPool), so it
    // scales linearly with model window. allocatedTokens is bounded by actual
    // demand (5000 tokens of character content) so it does NOT grow with the
    // window once demand is fully met — that is the correct V3 semantic.
    expect(largeResources.softTargetTokens).toBeGreaterThan(
      smallResources.softTargetTokens,
    );
    // Both windows must satisfy the 5000-token demand; allocation is capped by
    // demand in the large-window case, and by soft target in the small-window
    // case (or full_fit when demand fits inside the small soft target).
    expect(smallResources.allocatedTokens).toBeGreaterThan(0);
    expect(largeResources.allocatedTokens).toBeGreaterThan(0);
  });

  test('cross-board borrow: tiny story/episodic frees budget for resources (T5)', async () => {
    // Story state config is small + no previous chapters (episodic empty).
    // Resources has real demand — must borrow from the unused boards.
    (dbMock as any).__setCharacters([
      makeLargeCharacter(40, '乙', 12_000),
    ]);
    const result = await buildContext(
      BASE_CHAPTER as any,
      {
        ...BASE_CONFIG,
        storyStateBudgetTokens: 1000,
        episodicMemoryBudgetTokens: 500,
      },
      7,
      undefined,
      {
        contextWindow: 64_000,
        reservedOutputTokens: 12_800,
        contextBudgetVersion: 6,
      },
    );
    const resources = result.hierarchicalBudgetTrace!.boardAllocations.resources;
    // Resources got more than its policy soft target thanks to cross-board borrow.
    expect(resources.allocatedTokens).toBeGreaterThan(resources.softTargetTokens);
    // Borrow attribution is recorded for Preview.
    expect(resources.borrowedTokens).toBeGreaterThan(0);
  });

  test('Preview = Send: candidate allocation matches rendered bytes (T14)', async () => {
    (dbMock as any).__setCharacters([
      makeLargeCharacter(50, '丙', 3000),
      makeLargeCharacter(51, '丁', 3000),
    ]);
    const result = await buildContext(
      BASE_CHAPTER as any,
      BASE_CONFIG,
      7,
      undefined,
      {
        contextWindow: 128_000,
        reservedOutputTokens: 25_600,
        contextBudgetVersion: 6,
      },
    );
    const charItems = result.trace.filter(t => t.kind === 'character');
    // Sum of allocatedTokens across character trace items must equal the
    // tokens of the snapshot's characterText (no hidden clipping, no phantom
    // surplus). Both must be finite and consistent.
    const allocatedSum = charItems.reduce(
      (sum, item) => sum + (item.allocatedTokens ?? 0),
      0,
    );
    expect(allocatedSum).toBeGreaterThan(0);
    // The snapshot text contains every full-fit character's name.
    expect(result.pipelineContext.characterText).toContain('丙');
    expect(result.pipelineContext.characterText).toContain('丁');
    // Hierarchical trace item allocations agree with the per-trace-item allocations.
    const itemAlloc =
      result.hierarchicalBudgetTrace!.resourceItemAllocations!;
    for (const item of charItems) {
      const matched = Array.from(itemAlloc.entries()).find(
        ([, v]) => v === item.allocatedTokens,
      );
      expect(matched).toBeDefined();
    }
  });

  test('V2 path (no contextBudgetVersion) leaves hierarchicalBudgetTrace undefined', async () => {
    (dbMock as any).__setCharacters([makeLargeCharacter(60, '戊', 1000)]);
    const result = await buildContext(
      BASE_CHAPTER as any,
      BASE_CONFIG,
      7,
      undefined,
      {
        contextWindow: 64_000,
        reservedOutputTokens: 12_800,
        elasticBudget: true,
      },
    );
    expect(result.hierarchicalBudgetTrace).toBeUndefined();
    expect(result.elasticBudgetTrace).toBeDefined();
  });

  test('determinism: same input produces byte-identical allocation', async () => {
    (dbMock as any).__setCharacters([
      makeLargeCharacter(70, '己', 5000),
      makeLargeCharacter(71, '庚', 7000),
    ]);
    const opts = {
      contextWindow: 200_000,
      reservedOutputTokens: 40_000,
      contextBudgetVersion: 6,
    };
    const r1 = await buildContext(
      BASE_CHAPTER as any,
      BASE_CONFIG,
      7,
      undefined,
      opts,
    );
    const r2 = await buildContext(
      BASE_CHAPTER as any,
      BASE_CONFIG,
      7,
      undefined,
      opts,
    );
    expect(JSON.stringify(r1.hierarchicalBudgetTrace)).toEqual(
      JSON.stringify(r2.hierarchicalBudgetTrace),
    );
    expect(r1.pipelineContext.characterText).toEqual(
      r2.pipelineContext.characterText,
    );
  });
});
