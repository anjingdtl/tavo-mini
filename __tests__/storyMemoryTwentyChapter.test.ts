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
  createEmptyStoryMemory,
} from '../src/services/storyMemory/storyMemoryDefaults';
import { finalizeChapterMemory } from '../src/services/storyMemory/storyMemoryService';
import type {
  StoredChapterMemoryPatch,
  StoryMemoryState,
} from '../src/services/storyMemory/storyMemoryTypes';
import type { Chapter } from '../src/types/novel';

describe('twenty-chapter story memory lifecycle', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('finalizes 20 chapters in order and survives repeated truncated JSON', async () => {
    const chapters = new Map<number, Chapter>();
    for (let position = 0; position < 20; position++) {
      const id = position + 1;
      chapters.set(id, {
        id,
        project_id: 77,
        position,
        title: `第 ${id} 章`,
        synopsis: `第 ${id} 章事件推进。`,
        content: `第 ${id} 章里，石璐和世恒继续调查档案。`,
        status: 'draft',
        summary_json: null,
        created_at: '',
        updated_at: '',
      });
    }

    let state: StoryMemoryState = createEmptyStoryMemory(77);
    const patches = new Map<number, StoredChapterMemoryPatch>();
    const attempts = new Map<number, number>();

    mockDb.getChapterById.mockImplementation(async (id: number) =>
      chapters.get(id),
    );
    mockDb.getChapterMemoryPatch.mockImplementation(async (id: number) => {
      const patch = patches.get(id);
      return patch ? { status: 'applied', patch } : null;
    });
    mockDb.ensureProjectStoryMemoryRow.mockImplementation(async () => ({
      state,
      status: state.metadata.status,
      dirtyFromPosition: state.metadata.dirtyFromPosition,
    }));
    mockDb.getContextConfig.mockResolvedValue({ memoryPatchMaxTokens: 3200 });
    mockDb.markStoryMemoryDirty.mockResolvedValue(undefined);
    mockDb.saveStoryMemoryUpdate.mockImplementation(async input => {
      state = input.state;
      patches.set(input.patch.chapterId, input.patch);
      const chapter = chapters.get(input.patch.chapterId)!;
      chapters.set(input.patch.chapterId, {
        ...chapter,
        status: 'final',
        memory_summary: input.episodicMemoryText,
      });
    });
    let lastId = 0;
    mockCallLLMResult.mockImplementation(async messages => {
      const userText = messages
        .filter((message: { role: string }) => message.role === 'user')
        .map((message: { content: string }) => message.content)
        .join('\n');
      const position = userText.match(/position=(\d+)/)?.[1];
      const id = position == null ? lastId : Number(position) + 1;
      lastId = id;
      const attempt = (attempts.get(id) || 0) + 1;
      attempts.set(id, attempt);
      if (id % 3 === 0 && attempt < 3) {
        return {
          text: '{"chapters":[',
          inputTokens: 100,
          outputTokens: 3200,
          totalTokens: 3300,
          finishReason: 'length',
        };
      }
      const chapter = chapters.get(id)!;
      const observation = {
        chapters: [
          {
            chapter: 'CH01',
            brief: chapter.synopsis,
            keywords: [],
            events: [],
            observations: [],
          },
        ],
      };
      return {
        text: JSON.stringify(observation),
        inputTokens: 100,
        outputTokens: 200,
        totalTokens: 300,
        finishReason: 'stop',
      };
    });

    const results = [];
    for (let id = 1; id <= 20; id++) {
      results.push(await finalizeChapterMemory(id));
      // The user-facing finalize call returns first. Run the queued legacy
      // maintenance worker explicitly so this lifecycle test can inspect the
      // eventual durable memory state without making the writing path wait.
      await jest.runOnlyPendingTimersAsync();
    }

    expect(results).toHaveLength(20);
    expect(results.every(result => result.chapterFinalized)).toBe(true);
    expect(results.every(result => result.maintenanceQueued)).toBe(true);
    expect(results.every(result => result.checkpointAttempted === false)).toBe(
      true,
    );
    expect(state.throughChapterPosition).toBe(19);
    expect(patches).toHaveProperty('size', 20);
    expect(
      [...chapters.values()].every(chapter => chapter.status === 'final'),
    ).toBe(true);
    expect(
      [...chapters.values()].every(
        chapter => (chapter.memory_summary ?? '').length > 0,
      ),
    ).toBe(true);
    expect(attempts.get(3)).toBe(3);
    expect(attempts.get(18)).toBe(3);
    expect(mockDb.markStoryMemoryDirty).not.toHaveBeenCalled();
  });
});
