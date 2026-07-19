const mockDb = {
  getChapterById: jest.fn(),
  getChapterMemoryPatch: jest.fn(),
  ensureProjectStoryMemoryRow: jest.fn(),
  getContextConfig: jest.fn(),
  saveStoryMemoryUpdate: jest.fn(),
  markStoryMemoryDirty: jest.fn(),
  updateChapter: jest.fn(),
  finalizeChapterLocally: jest.fn(),
  getStoryMemoryCheckpointSchedulerEnabled: jest.fn(async () => false),
  getStructuredStoryMemoryEnabled: jest.fn(async () => true),
};
const mockCallLLMResult = jest.fn();

jest.mock('../src/services/database', () => ({
  getChapterById: (...args: unknown[]) => mockDb.getChapterById(...args),
  getChapterMemoryPatch: (...args: unknown[]) =>
    mockDb.getChapterMemoryPatch(...args),
  ensureProjectStoryMemoryRow: (...args: unknown[]) =>
    mockDb.ensureProjectStoryMemoryRow(...args),
  getContextConfig: (...args: unknown[]) => mockDb.getContextConfig(...args),
  saveStoryMemoryUpdate: (...args: unknown[]) =>
    mockDb.saveStoryMemoryUpdate(...args),
  markStoryMemoryDirty: (...args: unknown[]) =>
    mockDb.markStoryMemoryDirty(...args),
  updateChapter: (...args: unknown[]) => mockDb.updateChapter(...args),
  finalizeChapterLocally: (...args: any[]) =>
    mockDb.finalizeChapterLocally(...args),
  getStoryMemoryCheckpointSchedulerEnabled: () =>
    mockDb.getStoryMemoryCheckpointSchedulerEnabled(),
  getStructuredStoryMemoryEnabled: () =>
    mockDb.getStructuredStoryMemoryEnabled(),
}));
jest.mock('../src/services/llm', () => ({
  callLLMResult: (...args: unknown[]) => mockCallLLMResult(...args),
}));

import {
  createEmptyChapterMemoryPatch,
  createEmptyStoryMemory,
} from '../src/services/storyMemory/storyMemoryDefaults';
import {
  finalizeChapterMemory,
  renderEpisodicMemoryText,
} from '../src/services/storyMemory/storyMemoryService';

const chapter = {
  id: 1,
  project_id: 7,
  position: 0,
  title: '第一章',
  synopsis: '',
  content: '雨夜里，林岚推开钟楼暗门。',
  status: 'draft' as const,
  summary_json: null,
  created_at: '',
  updated_at: '',
};

describe('chapter structured-memory finalization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const state = createEmptyStoryMemory(7);
    mockDb.getChapterById.mockResolvedValue(chapter);
    mockDb.getChapterMemoryPatch.mockResolvedValue(null);
    mockDb.ensureProjectStoryMemoryRow.mockResolvedValue({
      state,
      status: 'empty',
      dirtyFromPosition: null,
    });
    mockDb.getContextConfig.mockResolvedValue({ memoryPatchMaxTokens: 1200 });
    mockDb.saveStoryMemoryUpdate.mockResolvedValue(undefined);
    mockDb.markStoryMemoryDirty.mockResolvedValue(undefined);
    mockDb.updateChapter.mockResolvedValue(undefined);
    const patch = createEmptyChapterMemoryPatch({
      chapterId: 1,
      chapterPosition: 0,
      title: '第一章',
    });
    patch.episodicSummary = {
      brief: '林岚发现暗门',
      keywords: ['钟楼', '暗门'],
      events: ['暗门被打开'],
      characterChanges: [],
      relationshipChanges: [],
      mainlineChanges: ['调查开始'],
      newThreads: ['暗门通向何处'],
      resolvedThreads: [],
    };
    mockCallLLMResult.mockResolvedValue({
      text: JSON.stringify(patch),
      inputTokens: 10,
      outputTokens: 10,
      totalTokens: 20,
    });
  });

  it('renders deterministic episodic text and saves one atomic update', async () => {
    const result = await finalizeChapterMemory(1);
    expect(result.episodicMemoryText).toBe(
      '核心事件：林岚发现暗门；暗门被打开\n主线变化：调查开始\n新增悬念：暗门通向何处\n关键词：钟楼；暗门',
    );
    expect(mockDb.saveStoryMemoryUpdate).toHaveBeenCalledTimes(1);
    expect(mockDb.saveStoryMemoryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        episodicMemoryText: result.episodicMemoryText,
        state: expect.objectContaining({ throughChapterPosition: 0 }),
      }),
    );
  });

  it('does not duplicate an already applied patch', async () => {
    const first = await finalizeChapterMemory(1);
    const state = createEmptyStoryMemory(7);
    state.throughChapterId = 1;
    state.throughChapterPosition = 0;
    state.metadata.lastAppliedPatchId = first.patchId;
    mockDb.ensureProjectStoryMemoryRow.mockResolvedValue({
      state,
      status: 'clean',
      dirtyFromPosition: null,
    });
    mockDb.getChapterMemoryPatch.mockResolvedValue({
      status: 'applied',
      patch: {
        patchId: first.patchId,
        sourceFingerprint: first.patchId.split('_')[2],
        episodicSummary: createEmptyChapterMemoryPatch({
          chapterId: 1,
          chapterPosition: 0,
          title: '第一章',
        }).episodicSummary,
      },
    });
    mockDb.saveStoryMemoryUpdate.mockClear();
    const second = await finalizeChapterMemory(1);
    expect(second.reused).toBe(true);
    expect(mockDb.saveStoryMemoryUpdate).not.toHaveBeenCalled();
    expect(mockDb.updateChapter).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        memory_summary: expect.stringContaining('雨夜里，林岚推开钟楼暗门'),
        memory_summary_tokens: expect.any(Number),
      }),
    );
  });

  it('persists a deterministic synopsis fallback when provider summary is empty', async () => {
    const chapterWithSynopsis = {
      ...chapter,
      synopsis: '林岚在雨夜发现钟楼暗门。',
    };
    mockDb.getChapterById.mockResolvedValue(chapterWithSynopsis);
    const patch = createEmptyChapterMemoryPatch({
      chapterId: 1,
      chapterPosition: 0,
      title: '第一章',
    });
    mockCallLLMResult.mockResolvedValue({
      text: JSON.stringify(patch),
      inputTokens: 10,
      outputTokens: 10,
      totalTokens: 20,
    });

    const result = await finalizeChapterMemory(1);

    expect(result.episodicMemoryText).toBe(
      '核心事件：林岚在雨夜发现钟楼暗门。',
    );
    expect(mockDb.saveStoryMemoryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        episodicMemoryText: result.episodicMemoryText,
      }),
    );
  });

  it('keeps saved body and marks dirty when both model attempts fail', async () => {
    mockCallLLMResult.mockResolvedValue({
      text: '{bad',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
    await expect(finalizeChapterMemory(1)).rejects.toThrow();
    expect(mockDb.saveStoryMemoryUpdate).not.toHaveBeenCalled();
    expect(mockDb.markStoryMemoryDirty).toHaveBeenCalledWith(
      7,
      0,
      expect.any(String),
    );
  });

  it('omits empty episodic sections', () => {
    expect(
      renderEpisodicMemoryText({
        brief: '', keywords: [], events: [], characterChanges: [],
        relationshipChanges: [], mainlineChanges: [], newThreads: [],
        resolvedThreads: [],
      }),
    ).toBe('');
  });

  it('falls back to chapter content after removing a markdown heading', () => {
    expect(
      renderEpisodicMemoryText(
        createEmptyChapterMemoryPatch({
          chapterId: 2,
          chapterPosition: 1,
          title: '第二章',
        }).episodicSummary,
        { synopsis: '', content: '# 第二章\n\n石璐和世恒走出公司。' },
      ),
    ).toBe('核心事件：石璐和世恒走出公司。');
  });
});
