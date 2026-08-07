import type { Chapter } from '../src/types/novel';
import {
  buildPendingBridgeText,
  planStoryMemoryCoverage,
} from '../src/services/storyMemory/storyMemoryCoverage';
import {
  createDefaultStoryMemoryPolicy,
  evaluateStoryMemoryDue,
  splitCheckpointBatches,
  STORY_MEMORY_DEFAULT_BATCH_SIZE,
  STORY_MEMORY_DEFAULT_INTERVAL,
} from '../src/services/storyMemory/storyMemoryPolicy';
import {
  resolveUsableCheckpointForTarget,
} from '../src/services/storyMemory/storyMemoryCheckpointEligibility';
import { selectPreviousChapters } from '../src/services/contextBuilder';
import { createEmptyStoryMemory } from '../src/services/storyMemory/storyMemoryDefaults';
import type { StoryMemoryState } from '../src/services/storyMemory/storyMemoryTypes';

const mockGetChapters = jest.fn();
const mockGetMemory = jest.fn();
const mockEnsure = jest.fn();

jest.mock('../src/services/database', () => ({
  getChaptersByProject: (...args: unknown[]) => mockGetChapters(...args),
  getProjectStoryMemory: (...args: unknown[]) => mockGetMemory(...args),
  ensureProjectStoryMemoryRow: (...args: unknown[]) => mockEnsure(...args),
  getCharactersByProject: jest.fn(async () => []),
  getWorldbookEntriesByProject: jest.fn(async () => []),
  getNotesByProject: jest.fn(async () => []),
  getNotesContentByIds: jest.fn(async () => ({})),
  getProjectNoteConfig: jest.fn(async () => null),
}));

jest.mock('../src/services/macroReplace', () => ({
  processMacros: jest.fn(async (text: string) => text),
}));

import { buildContext } from '../src/services/contextBuilder';

function chapter(
  position: number,
  options: { content?: string; summary?: string; id?: number } = {},
): Chapter {
  return {
    id: options.id ?? position + 1,
    project_id: 1,
    position,
    title: `第 ${position + 1} 章`,
    synopsis: '',
    content: options.content ?? `第 ${position + 1} 章正文。`,
    memory_summary: options.summary,
    status: 'final',
    summary_json: null,
    created_at: '',
    updated_at: '',
  };
}

function manyChapters(from: number, to: number): Chapter[] {
  const chapters: Chapter[] = [];
  for (let position = from; position <= to; position += 1) {
    chapters.push(
      chapter(position, {
        content: `第 ${position + 1} 章正文。`.repeat(8),
        summary: `第 ${position + 1} 章事件摘要。`,
      }),
    );
  }
  return chapters;
}

describe('10-chapter hard boundary (sliding raw context)', () => {
  it('T5: pending bridge with 30 pending chapters caps raw text at the most recent 10', () => {
    const chapters = manyChapters(0, 51);
    const current = chapters[51];
    const plan = planStoryMemoryCoverage({
      currentChapter: current,
      chapters,
      checkpointThroughPosition: 20,
      slidingBudgetTokens: 1_000_000,
    });
    expect(plan.pendingChapters).toHaveLength(30);
    expect(plan.rawChapterIds).toHaveLength(10);
    const rawPositions = plan.rawChapterIds
      .map(id => chapters.find(c => c.id === id)!.position)
      .sort((a, b) => a - b);
    expect(rawPositions[0]).toBe(41);
    expect(rawPositions[9]).toBe(50);
    const episodicPositions = plan.episodicFallbackChapterIds
      .map(id => chapters.find(c => c.id === id)!.position)
      .sort((a, b) => a - b);
    expect(episodicPositions).toHaveLength(20);
    expect(episodicPositions[0]).toBe(21);
    expect(episodicPositions[19]).toBe(40);
    expect(plan.uncoveredChapterIds).toEqual([]);
    expect(plan.hardDue).toBe(false);
  });

  it('T5b: older pending chapters without summaries become uncovered, never raw', () => {
    const chapters = manyChapters(0, 51).map(c =>
      c.position <= 40 ? { ...c, memory_summary: '' } : c,
    );
    const current = chapters[51];
    const plan = planStoryMemoryCoverage({
      currentChapter: current,
      chapters,
      checkpointThroughPosition: 20,
      slidingBudgetTokens: 1_000_000,
    });
    expect(plan.rawChapterIds).toHaveLength(10);
    expect(plan.uncoveredChapterIds).toHaveLength(20);
    expect(plan.hardDue).toBe(true);
  });

  it('T5c: pending bridge text renders at most 10 raw sections with episodic fallback', () => {
    const chapters = manyChapters(0, 51);
    const current = chapters[51];
    const plan = planStoryMemoryCoverage({
      currentChapter: current,
      chapters,
      checkpointThroughPosition: 20,
      slidingBudgetTokens: 1_000_000,
    });
    const text = buildPendingBridgeText(
      plan,
      new Map(chapters.map(c => [c.id, c])),
    );
    const rawSections = text.match(/【第 \d+ 章｜/g) || [];
    const episodicSections = text.match(/【第 \d+ 章事件摘要｜/g) || [];
    expect(rawSections).toHaveLength(10);
    expect(episodicSections).toHaveLength(20);
    expect(text).toContain('【第 42 章｜');
    expect(text).toContain('【第 22 章事件摘要｜');
    expect(text).toContain('【第 41 章事件摘要｜');
  });

  it('T1: sliding window with 100 previous chapters and huge budget selects at most 10', () => {
    const chapters = manyChapters(0, 99);
    const current = chapter(100, { content: '当前章' });
    const selected = selectPreviousChapters(
      current,
      { strategy: 'sliding', recentChapterCount: 100, slidingWindowSize: 1_000_000 },
      chapters,
    );
    expect(selected).toHaveLength(10);
    expect(selected[0].position).toBe(90);
    expect(selected[9].position).toBe(99);
  });

  it('T2: historical/malicious recentChapterCount=100 is hard-clamped to 10', () => {
    const chapters = manyChapters(0, 49);
    const current = chapter(50, { content: '当前章' });
    const selected = selectPreviousChapters(
      current,
      { strategy: 'sliding', recentChapterCount: 100 },
      chapters,
    );
    expect(selected).toHaveLength(10);
  });

  it('T3: fewer than 10 previous chapters still work', () => {
    const chapters = manyChapters(0, 5);
    const current = chapter(6, { content: '当前章' });
    const selected = selectPreviousChapters(
      current,
      { strategy: 'sliding', recentChapterCount: 10 },
      chapters,
    );
    expect(selected).toHaveLength(6);
    expect(selected[0].position).toBe(0);
  });

  it('T4: token budget clips within the capped 10 chapters, never expands count', () => {
    const chapters = manyChapters(0, 99).map(c => ({
      ...c,
      content: c.content.repeat(30),
    }));
    const current = chapter(100, { content: '当前章' });
    const selected = selectPreviousChapters(
      current,
      { strategy: 'sliding', recentChapterCount: 100, slidingWindowSize: 2000 },
      chapters,
    );
    expect(selected).toHaveLength(10);
    const totalChars = selected.reduce((sum, c) => sum + c.content.length, 0);
    expect(totalChars).toBeGreaterThan(2000);
  });

  it('full/custom strategies are not affected by the sliding cap', () => {
    const chapters = manyChapters(0, 29);
    const current = chapter(30, { content: '当前章' });
    const full = selectPreviousChapters(
      current,
      { strategy: 'full', recentChapterCount: 100 },
      chapters,
    );
    expect(full).toHaveLength(30);
    const custom = selectPreviousChapters(
      current,
      { strategy: 'custom', customRangeStart: 5, customRangeEnd: 9 },
      chapters,
    );
    expect(custom.map(c => c.position)).toEqual([5, 6, 7, 8, 9]);
  });
});

describe('story memory policy: interval vs LLM batch decoupling', () => {
  it('T6: default checkpoint interval is 10 chapters', () => {
    expect(STORY_MEMORY_DEFAULT_INTERVAL).toBe(10);
    expect(createDefaultStoryMemoryPolicy(1).intervalChapters).toBe(10);
  });

  it('T7: default LLM batch size stays 3, independent of the interval', () => {
    expect(STORY_MEMORY_DEFAULT_BATCH_SIZE).toBe(3);
    const chapters = Array.from({ length: 10 }, (_, i) => chapter(i));
    const batches = splitCheckpointBatches(chapters);
    expect(batches.map(b => b.length)).toEqual([3, 3, 3, 1]);
  });

  it('T7b: interval 10 triggers due exactly at 10 pending chapters', () => {
    const policy = createDefaultStoryMemoryPolicy(1);
    expect(policy.intervalChapters).toBe(10);
    const nine = Array.from({ length: 9 }, (_, i) => chapter(i));
    expect(
      evaluateStoryMemoryDue({
        policy,
        checkpointThroughPosition: -1,
        pendingChapters: nine,
      }).due,
    ).toBe(false);
    const ten = Array.from({ length: 10 }, (_, i) => chapter(i));
    expect(
      evaluateStoryMemoryDue({
        policy,
        checkpointThroughPosition: -1,
        pendingChapters: ten,
      }),
    ).toEqual(
      expect.objectContaining({ due: true, reason: 'interval_reached' }),
    );
  });
});

describe('checkpoint append failure vs history-edit dirty semantics', () => {
  function cleanRecordThrough(
    projectId: number,
    through: number,
  ): { status: string; dirtyFromPosition: null; state: StoryMemoryState } {
    const state = createEmptyStoryMemory(projectId);
    state.throughChapterPosition = through;
    state.throughChapterId = through + 1;
    return { status: 'clean', dirtyFromPosition: null, state };
  }

  it('T10b: dirty (covered history edited) stays ineligible for injection', () => {
    const record = cleanRecordThrough(1, 30) as any;
    record.status = 'dirty';
    record.dirtyFromPosition = 15;
    const eligibility = resolveUsableCheckpointForTarget(record, 40);
    expect(eligibility.usable).toBe(false);
    expect(eligibility.reason).toBe('not_clean');
  });

  it('T10b2: a clean checkpoint before the target remains usable', () => {
    const record = cleanRecordThrough(1, 30);
    const eligibility = resolveUsableCheckpointForTarget(record as any, 40);
    expect(eligibility.usable).toBe(true);
    expect(eligibility.checkpointThroughPosition).toBe(30);
  });
});

describe('context preview vs draft share the compiled story memory (T11/T12)', () => {
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

  function recordWithStatus(
    through: number,
    status: 'clean' | 'failed',
    dirtyFromPosition: number | null = null,
  ): any {
    const state = createEmptyStoryMemory(1);
    state.throughChapterPosition = through;
    state.throughChapterId = through + 1;
    return { status, dirtyFromPosition, state, lastError: '' };
  }

  const chapters = [
    makeChapter(1, 0, '正文一', '摘要一'),
    makeChapter(2, 1, '正文二', '摘要二'),
    makeChapter(3, 2, '当前', '', '当前'),
  ];
  const contextConfig = {
    strategy: 'sliding' as const,
    slidingWindowSize: 4000,
    customRangeStart: 0,
    customRangeEnd: -1,
    includeResources: false,
    resourceBudget: 0,
    summaryBudgetTokens: 2000,
    episodicMemoryBudgetTokens: 1000,
    storyStateBudgetTokens: 4000,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetChapters.mockResolvedValue(chapters);
  });

  it('T11: clean usable checkpoint → preview trace included with tokens > 0', async () => {
    mockGetMemory.mockResolvedValue(recordWithStatus(1, 'clean'));
    mockEnsure.mockResolvedValue(recordWithStatus(1, 'clean'));
    const result = await buildContext(
      chapters[2],
      contextConfig as any,
      1,
      undefined,
      { storyMemoryMode: 'preview' },
    );
    const traceStory = result.trace.find(t => t.kind === 'story_memory');
    expect(traceStory).toBeDefined();
    expect(traceStory?.included).toBe(true);
    expect((traceStory?.estimatedTokens ?? 0)).toBeGreaterThan(0);
    expect(traceStory?.reason).toContain('第 2 章');
    expect(result.pipelineContext.storyMemoryText.length).toBeGreaterThan(0);
  });

  it('T12: truly failed/rebuild-broken checkpoint → trace excluded with 0 tokens', async () => {
    mockGetMemory.mockResolvedValue(recordWithStatus(1, 'failed', 1));
    mockEnsure.mockResolvedValue(recordWithStatus(1, 'failed', 1));
    const result = await buildContext(
      chapters[2],
      contextConfig as any,
      1,
      undefined,
      { storyMemoryMode: 'preview' },
    );
    const traceStory = result.trace.find(t => t.kind === 'story_memory');
    expect(traceStory).toBeDefined();
    expect(traceStory?.included).toBe(false);
    expect(traceStory?.estimatedTokens).toBe(0);
    expect(traceStory?.reason).toContain('failed');
    expect(result.pipelineContext.storyMemoryText).toBe('');
  });
});
