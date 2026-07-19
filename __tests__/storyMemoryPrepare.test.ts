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

  it('preview hard-due with uncovered chapters blocks without calling LLM', async () => {
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
    expect(result.checkpointUpdated).toBe(false);
  });
});
