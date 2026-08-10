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
  resolveDirtyRebuildThroughPosition,
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
    jest.useFakeTimers();
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

  afterEach(() => {
    jest.useRealTimers();
  });

  it('finalizes the chapter locally and queues memory work without waiting for LLM', async () => {
    const result = await finalizeChapterMemory(1);
    expect(result.chapterFinalized).toBe(true);
    expect(result.maintenanceQueued).toBe(true);
    expect(result.checkpointAttempted).toBe(false);
    expect(result.checkpointUpdated).toBe(false);
    expect(result.episodicMemoryText).toBe('');
    expect(mockDb.finalizeChapterLocally).toHaveBeenCalledWith(
      1,
      expect.any(String),
    );
    expect(mockDb.saveStoryMemoryUpdate).not.toHaveBeenCalled();
    expect(mockCallLLMResult).not.toHaveBeenCalled();
  });

  it('does not synchronously invoke the provider even when the background result would fail', async () => {
    mockCallLLMResult.mockRejectedValue(new Error('mock LLM 故障'));
    await expect(finalizeChapterMemory(1)).resolves.toEqual(
      expect.objectContaining({
        chapterFinalized: true,
        checkpointAttempted: false,
        maintenanceQueued: true,
      }),
    );
    expect(mockCallLLMResult).not.toHaveBeenCalled();
    expect(mockDb.markStoryMemoryDirty).not.toHaveBeenCalled();
  });

  it('returns the locally persisted chapter summary while maintenance is pending', async () => {
    const chapterWithSynopsis = {
      ...chapter,
      synopsis: '林岚在雨夜发现钟楼暗门。',
      memory_summary: '本地已有摘要',
    };
    mockDb.getChapterById.mockResolvedValue(chapterWithSynopsis);

    const result = await finalizeChapterMemory(1);

    expect(result.episodicMemoryText).toBe('本地已有摘要');
    expect(mockCallLLMResult).not.toHaveBeenCalled();
  });

  it('keeps the saved body when a future maintenance attempt would fail', async () => {
    mockCallLLMResult.mockResolvedValue({
      text: '{bad',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
    await expect(finalizeChapterMemory(1)).resolves.toEqual(
      expect.objectContaining({ chapterFinalized: true }),
    );
    expect(mockDb.saveStoryMemoryUpdate).not.toHaveBeenCalled();
    expect(mockDb.markStoryMemoryDirty).not.toHaveBeenCalled();
  });

  it('omits empty episodic sections', () => {
    expect(
      renderEpisodicMemoryText({
        brief: '',
        keywords: [],
        events: [],
        characterChanges: [],
        relationshipChanges: [],
        mainlineChanges: [],
        newThreads: [],
        resolvedThreads: [],
      }),
    ).toBe('');
  });

  it('keeps later covered chapters in scope when an older chapter becomes dirty', () => {
    expect(resolveDirtyRebuildThroughPosition(4, 2, null)).toBe(4);
    expect(resolveDirtyRebuildThroughPosition(4, 5, 5)).toBe(5);
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
