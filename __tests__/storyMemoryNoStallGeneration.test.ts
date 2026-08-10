import type { Chapter } from '../src/types/novel';

const mockGetChapters = jest.fn();
const mockGetMemory = jest.fn();
const mockGetPolicy = jest.fn();
const mockEnqueue = jest.fn();
const mockCallLLMResult = jest.fn();

jest.mock('../src/services/database', () => ({
  getChaptersByProject: (...args: unknown[]) => mockGetChapters(...args),
  getProjectStoryMemory: (...args: unknown[]) => mockGetMemory(...args),
  getStoryMemoryPolicy: (...args: unknown[]) => mockGetPolicy(...args),
}));

jest.mock('../src/services/storyMemory/storyMemoryService', () => ({
  enqueueStoryMemoryMaintenance: (...args: unknown[]) => mockEnqueue(...args),
}));

jest.mock('../src/services/llm', () => ({
  callLLMResult: (...args: unknown[]) => mockCallLLMResult(...args),
}));

import { prepareStoryMemoryForGeneration } from '../src/services/storyMemory/storyMemoryPrepare';

function chapter(position: number, summary = '可用的章节事件摘要。'): Chapter {
  return {
    id: position + 1,
    project_id: 1,
    position,
    title: `第 ${position + 1} 章`,
    synopsis: '',
    content: `第 ${position + 1} 章正文。`,
    status: 'final',
    summary_json: null,
    memory_summary: summary,
    created_at: '',
    updated_at: '',
  };
}

function cleanMemory() {
  return {
    status: 'clean',
    dirtyFromPosition: null,
    state: { throughChapterPosition: -1, throughChapterId: null },
  };
}

describe('Story Memory P1 no-stall generation readiness', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetMemory.mockResolvedValue(cleanMemory());
    mockGetPolicy.mockResolvedValue(undefined);
  });

  it('uses safe raw/episodic coverage and queues maintenance without calling LLM', async () => {
    const chapters = Array.from({ length: 23 }, (_, position) => chapter(position));
    mockGetChapters.mockResolvedValue(chapters);

    const result = await prepareStoryMemoryForGeneration(
      1,
      chapters[22],
      { slidingWindowSize: 4000 } as any,
      { mode: 'generation' },
    );

    expect(result.fatal).toBe(false);
    expect(result.blocked).toBe(false);
    expect(result.hardGap).toBe(false);
    expect(result.coverage.uncoveredChapterIds).toEqual([]);
    expect(result.coverage.rawChapterIds.length).toBeLessThanOrEqual(10);
    expect(result.coverage.episodicFallbackChapterIds.length).toBeGreaterThan(0);
    expect(result.maintenanceDue).toBe(true);
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 1,
        throughPosition: 21,
        priority: 'background',
      }),
    );
    expect(mockCallLLMResult).not.toHaveBeenCalled();
  });

  it('does not convert a historical hard gap into a safe warning', async () => {
    const chapters = Array.from({ length: 23 }, (_, position) =>
      chapter(position, position === 0 ? '' : undefined),
    );
    mockGetChapters.mockResolvedValue(chapters);

    const result = await prepareStoryMemoryForGeneration(
      1,
      chapters[22],
      { slidingWindowSize: 4000 } as any,
      { mode: 'generation' },
    );

    expect(result.fatal).toBe(true);
    expect(result.blocked).toBe(true);
    expect(result.hardGap).toBe(true);
    expect(result.blockReason).toContain('第 1 章');
    expect(result.maintenanceDue).toBe(true);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockCallLLMResult).not.toHaveBeenCalled();
  });
});
