import { planStoryMemoryCoverage } from '../src/services/storyMemory/storyMemoryCoverage';
import type { Chapter } from '../src/types/novel';

const mockGetChapters = jest.fn();
const mockGetMemory = jest.fn();
const mockEnsure = jest.fn();

jest.mock('../src/services/database', () => ({
  getChaptersByProject: (...args: any[]) => mockGetChapters(...args),
  getProjectStoryMemory: (...args: any[]) => mockGetMemory(...args),
  ensureProjectStoryMemoryRow: (...args: any[]) => mockEnsure(...args),
}));

import { prepareStoryMemoryForGeneration } from '../src/services/storyMemory/storyMemoryPrepare';

function chapter(position: number, content = '正文'): Chapter {
  return {
    id: position + 1,
    project_id: 1,
    position,
    title: `第 ${position + 1} 章`,
    synopsis: '',
    content,
    status: 'final',
    summary_json: null,
    memory_summary: `摘要${position + 1}`,
    created_at: '',
    updated_at: '',
  };
}

describe('prepareStoryMemoryForGeneration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns coverage without LLM when checkpoint is clean and complete', async () => {
    const chapters = [chapter(0), chapter(1), chapter(2)];
    mockGetChapters.mockResolvedValue(chapters);
    mockGetMemory.mockResolvedValue({
      status: 'clean',
      dirtyFromPosition: null,
      state: { throughChapterPosition: 0, throughChapterId: 1 },
    });
    const result = await prepareStoryMemoryForGeneration(
      1,
      chapters[2],
      { slidingWindowSize: 4000 } as any,
      { mode: 'preview' },
    );
    expect(result.blocked).toBe(false);
    expect(result.checkpointUpdated).toBe(false);
    expect(result.coverage.uncoveredChapterIds).toEqual([]);
    expect(result.coverage.pendingChapters.map(c => c.position)).toEqual([1]);
  });

  it('does not inject dirty checkpoint and plans from empty base', async () => {
    const chapters = [chapter(0), chapter(1)];
    mockGetChapters.mockResolvedValue(chapters);
    mockGetMemory.mockResolvedValue({
      status: 'dirty',
      dirtyFromPosition: 0,
      state: { throughChapterPosition: 0, throughChapterId: 1 },
    });
    const result = await prepareStoryMemoryForGeneration(
      1,
      chapters[1],
      { slidingWindowSize: 4000 } as any,
      { mode: 'preview' },
    );
    expect(result.checkpoint).toBeNull();
    expect(result.coverage.checkpointThroughPosition).toBe(-1);
  });

  it('preview hard-due with uncovered chapters fails closed without calling LLM', async () => {
    const huge = '超长'.repeat(500);
    const chapters = [
      chapter(0, huge),
      chapter(1, huge),
      chapter(2, '当前'),
    ];
    // strip summaries to force uncovered
    chapters[0].memory_summary = '';
    chapters[1].memory_summary = '';
    mockGetChapters.mockResolvedValue(chapters);
    mockGetMemory.mockResolvedValue({
      status: 'empty',
      dirtyFromPosition: null,
      state: { throughChapterPosition: -1, throughChapterId: null },
    });
    const plan = planStoryMemoryCoverage({
      currentChapter: chapters[2],
      chapters,
      checkpointThroughPosition: -1,
      slidingBudgetTokens: 10,
    });
    expect(plan.hardDue).toBe(true);

    const result = await prepareStoryMemoryForGeneration(
      1,
      chapters[2],
      { slidingWindowSize: 10 } as any,
      { mode: 'preview' },
    );
    expect(result.blocked).toBe(true);
    expect(result.fatal).toBe(true);
    expect(result.hardGap).toBe(true);
    expect(result.degraded).toBe(false);
    expect(result.checkpointUpdated).toBe(false);
    expect(result.blockReason).toContain('暂不能安全生成');
    expect(result.coverage.uncoveredChapterIds.length).toBeGreaterThan(0);
  });

  // V2.5.14: checkpointEligibility is carried out of prepare() so trace can
  // explain WHY a checkpoint was unusable without re-reading the DB.
  it('carries checkpointEligibility reason=usable for clean through<target', async () => {
    const chapters = [chapter(0), chapter(1), chapter(2)];
    mockGetChapters.mockResolvedValue(chapters);
    mockGetMemory.mockResolvedValue({
      status: 'clean',
      dirtyFromPosition: null,
      state: { throughChapterPosition: 0, throughChapterId: 1 },
    });
    const result = await prepareStoryMemoryForGeneration(
      1,
      chapters[2],
      { slidingWindowSize: 4000 } as any,
      { mode: 'preview' },
    );
    expect(result.checkpointEligibility).toBeDefined();
    expect(result.checkpointEligibility.reason).toBe('usable');
    expect(result.checkpointEligibility.originalStatus).toBe('clean');
    expect(result.checkpointEligibility.originalThroughPosition).toBe(0);
    expect(result.checkpointEligibility.targetChapterPosition).toBe(2);
  });

  it('carries checkpointEligibility reason=not_clean for dirty checkpoint', async () => {
    const chapters = [chapter(0), chapter(1)];
    mockGetChapters.mockResolvedValue(chapters);
    mockGetMemory.mockResolvedValue({
      status: 'dirty',
      dirtyFromPosition: 0,
      state: { throughChapterPosition: 0, throughChapterId: 1 },
    });
    const result = await prepareStoryMemoryForGeneration(
      1,
      chapters[1],
      { slidingWindowSize: 4000 } as any,
      { mode: 'preview' },
    );
    expect(result.checkpointEligibility.reason).toBe('not_clean');
    expect(result.checkpointEligibility.originalStatus).toBe('dirty');
    expect(result.checkpoint).toBeNull();
  });

  it('carries checkpointEligibility reason=future_or_same_position for future snapshot', async () => {
    const chapters = [chapter(0), chapter(1)];
    mockGetChapters.mockResolvedValue(chapters);
    mockGetMemory.mockResolvedValue({
      status: 'clean',
      dirtyFromPosition: null,
      state: { throughChapterPosition: 5, throughChapterId: 6 },
    });
    const result = await prepareStoryMemoryForGeneration(
      1,
      chapters[1], // target position 1
      { slidingWindowSize: 4000 } as any,
      { mode: 'preview' },
    );
    expect(result.checkpointEligibility.reason).toBe('future_or_same_position');
    expect(result.checkpointEligibility.originalThroughPosition).toBe(5);
    expect(result.checkpointEligibility.targetChapterPosition).toBe(1);
    expect(result.checkpoint).toBeNull();
  });

  it('carries checkpointEligibility reason=missing when DB returns null', async () => {
    const chapters = [chapter(0), chapter(1)];
    mockGetChapters.mockResolvedValue(chapters);
    mockGetMemory.mockResolvedValue(null);
    const result = await prepareStoryMemoryForGeneration(
      1,
      chapters[1],
      { slidingWindowSize: 4000 } as any,
      { mode: 'preview' },
    );
    expect(result.checkpointEligibility.reason).toBe('missing');
    expect(result.checkpointEligibility.originalStatus).toBeNull();
  });
});
