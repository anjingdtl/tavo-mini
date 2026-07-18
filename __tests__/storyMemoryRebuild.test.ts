const mockDb = {
  getChaptersByProject: jest.fn(),
  ensureProjectStoryMemoryRow: jest.fn(),
  getNearestStoryMemorySnapshot: jest.fn(),
  getContextConfig: jest.fn(),
  setStoryMemoryBuildStatus: jest.fn(),
  getChapterMemoryPatch: jest.fn(),
  saveStoryMemoryUpdate: jest.fn(),
};
const mockCallLLMResult = jest.fn();

jest.mock('../src/services/database', () => ({
  getChaptersByProject: (...args: unknown[]) =>
    mockDb.getChaptersByProject(...args),
  ensureProjectStoryMemoryRow: (...args: unknown[]) =>
    mockDb.ensureProjectStoryMemoryRow(...args),
  getNearestStoryMemorySnapshot: (...args: unknown[]) =>
    mockDb.getNearestStoryMemorySnapshot(...args),
  getContextConfig: (...args: unknown[]) => mockDb.getContextConfig(...args),
  setStoryMemoryBuildStatus: (...args: unknown[]) =>
    mockDb.setStoryMemoryBuildStatus(...args),
  getChapterMemoryPatch: (...args: unknown[]) =>
    mockDb.getChapterMemoryPatch(...args),
  saveStoryMemoryUpdate: (...args: unknown[]) =>
    mockDb.saveStoryMemoryUpdate(...args),
}));
jest.mock('../src/services/llm', () => ({
  callLLMResult: (...args: unknown[]) => mockCallLLMResult(...args),
}));

import {
  createEmptyChapterMemoryPatch,
  createEmptyStoryMemory,
} from '../src/services/storyMemory/storyMemoryDefaults';
import {
  canonicalStringify,
  fingerprintChapterSource,
  fingerprintStoryMemoryState,
} from '../src/services/storyMemory/storyMemoryFingerprint';
import { applyStoryMemoryPatch } from '../src/services/storyMemory/storyMemoryMerger';
import {
  ensureStoryMemoryReady,
  rebuildStoryMemory,
} from '../src/services/storyMemory/storyMemoryRebuild';

function chapter(position: number, memorySummary = '') {
  return {
    id: position + 1,
    project_id: 7,
    position,
    title: `第 ${position + 1} 章`,
    synopsis: `概要 ${position + 1}`,
    content: `第 ${position + 1} 章正文明确事件。`,
    status: 'final' as const,
    summary_json: null,
    memory_summary: memorySummary,
    created_at: '',
    updated_at: '',
  };
}

function outputForCall(messages: Array<{ content: string }>) {
  const user = messages.at(-1)?.content || '';
  const id = Number(user.match(/ID：(\d+)/)?.[1]);
  const position = Number(user.match(/位置：(\d+)/)?.[1]);
  const title = user.match(/标题：([^\n]+)/)?.[1] || '';
  return JSON.stringify(
    createEmptyChapterMemoryPatch({
      chapterId: id,
      chapterPosition: position,
      title,
    }),
  );
}

describe('story memory rebuild', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-18T00:00:00.000Z'));
    jest.clearAllMocks();
    const state = createEmptyStoryMemory(7);
    mockDb.getChaptersByProject.mockResolvedValue([chapter(0), chapter(1), chapter(2)]);
    mockDb.ensureProjectStoryMemoryRow.mockResolvedValue({
      state,
      status: 'empty',
      dirtyFromPosition: 0,
    });
    mockDb.getNearestStoryMemorySnapshot.mockResolvedValue(null);
    mockDb.getContextConfig.mockResolvedValue({ memoryPatchMaxTokens: 1200 });
    mockDb.setStoryMemoryBuildStatus.mockResolvedValue(undefined);
    mockDb.getChapterMemoryPatch.mockResolvedValue(null);
    mockDb.saveStoryMemoryUpdate.mockResolvedValue(undefined);
    mockCallLLMResult.mockImplementation(
      async (messages: Array<{ content: string }>) => ({
        text: outputForCall(messages),
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      }),
    );
  });

  afterEach(() => jest.useRealTimers());

  it('rebuilds from empty state in chapter position order with checkpoints', async () => {
    const progress = jest.fn();
    const result = await rebuildStoryMemory(7, {
      mode: 'full',
      onProgress: progress,
    });
    expect(result).toEqual(expect.objectContaining({
      completedChapters: 3,
      reusedPatches: 0,
      regeneratedPatches: 3,
    }));
    expect(result.state.throughChapterPosition).toBe(2);
    expect(mockDb.saveStoryMemoryUpdate).toHaveBeenCalledTimes(3);
    expect(progress).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'completed', completedChapters: 3 }),
    );
  });

  it('starts after the nearest snapshot and reuses a base-compatible patch', async () => {
    const firstChapter = chapter(0);
    const firstDraft = createEmptyChapterMemoryPatch({
      chapterId: 1,
      chapterPosition: 0,
      title: firstChapter.title,
    });
    const snapshot = applyStoryMemoryPatch(
      createEmptyStoryMemory(7),
      firstDraft,
      {
        projectId: 7,
        chapterId: 1,
        chapterPosition: 0,
        sourceFingerprint: fingerprintChapterSource(firstChapter),
        now: '2026-07-18T00:00:00.000Z',
      },
    ).state;
    const secondChapter = chapter(1);
    const secondDraft = createEmptyChapterMemoryPatch({
      chapterId: 2,
      chapterPosition: 1,
      title: secondChapter.title,
    });
    const stored = applyStoryMemoryPatch(snapshot, secondDraft, {
      projectId: 7,
      chapterId: 2,
      chapterPosition: 1,
      sourceFingerprint: fingerprintChapterSource(secondChapter),
      baseMemoryFingerprint: fingerprintStoryMemoryState(snapshot),
      now: '2026-07-18T00:00:00.000Z',
    }).resolvedPatch;
    mockDb.getChaptersByProject.mockResolvedValue([firstChapter, secondChapter]);
    mockDb.ensureProjectStoryMemoryRow.mockResolvedValue({
      state: { ...snapshot, metadata: { ...snapshot.metadata, status: 'dirty', dirtyFromPosition: 1 } },
      status: 'dirty',
      dirtyFromPosition: 1,
    });
    mockDb.getNearestStoryMemorySnapshot.mockResolvedValue({ state: snapshot });
    mockDb.getChapterMemoryPatch.mockResolvedValue({
      status: 'generated',
      patch: stored,
    });
    const result = await rebuildStoryMemory(7, { mode: 'auto' });
    expect(result.reusedPatches).toBe(1);
    expect(result.regeneratedPatches).toBe(0);
    expect(mockCallLLMResult).not.toHaveBeenCalled();
  });

  it('stops at the failed chapter and records a retry position', async () => {
    mockCallLLMResult
      .mockImplementationOnce(async messages => ({
        text: outputForCall(messages), inputTokens: 1, outputTokens: 1, totalTokens: 2,
      }))
      .mockResolvedValue({ text: '{bad', inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    await expect(rebuildStoryMemory(7, { mode: 'full' })).rejects.toThrow(
      '第 2 章故事记忆重建失败',
    );
    expect(mockDb.saveStoryMemoryUpdate).toHaveBeenCalledTimes(1);
    expect(mockDb.setStoryMemoryBuildStatus).toHaveBeenLastCalledWith(
      7,
      'failed',
      1,
      expect.any(String),
    );
  });

  it('cancels before the next chapter and preserves the checkpoint', async () => {
    const controller = new AbortController();
    mockDb.saveStoryMemoryUpdate.mockImplementationOnce(async () => {
      controller.abort();
    });
    await expect(
      rebuildStoryMemory(7, { mode: 'full', signal: controller.signal }),
    ).rejects.toThrow('已取消');
    expect(mockDb.saveStoryMemoryUpdate).toHaveBeenCalledTimes(1);
    expect(mockDb.setStoryMemoryBuildStatus).toHaveBeenLastCalledWith(
      7,
      'dirty',
      1,
      '',
    );
  });

  it('uses legacy summaries without reading full chapter bodies', async () => {
    mockDb.getChaptersByProject.mockResolvedValue([
      chapter(0, '旧事件摘要：钟楼暗门被打开。'),
    ]);
    await rebuildStoryMemory(7, { mode: 'legacy_bootstrap' });
    const messages = mockCallLLMResult.mock.calls[0][0];
    expect(messages.at(-1).content).toContain('旧事件摘要：钟楼暗门被打开');
    expect(mockCallLLMResult.mock.calls[0][2]).toEqual(
      expect.objectContaining({ scenario: 'story_memory_legacy_bootstrap' }),
    );
  });

  it('replays 100 chapters deterministically and ensure returns a clean ready state', async () => {
    const chapters = Array.from({ length: 100 }, (_, index) => chapter(index));
    mockDb.getChaptersByProject.mockResolvedValue(chapters);
    const first = await rebuildStoryMemory(7, { mode: 'full' });
    mockDb.saveStoryMemoryUpdate.mockClear();
    const second = await rebuildStoryMemory(7, { mode: 'full' });
    expect(canonicalStringify(second.state)).toBe(canonicalStringify(first.state));
    expect(second.completedChapters).toBe(100);

    mockDb.ensureProjectStoryMemoryRow.mockResolvedValue({
      state: second.state,
      status: 'clean',
      dirtyFromPosition: null,
    });
    await expect(ensureStoryMemoryReady(7, 99)).resolves.toBe(second.state);
  });
});
