/**
 * V2.11.38 repair plan P1 §6.2 — checkpoint empty-response recovery.
 *
 * The coordinator must route `emptyReason`-classified empty responses into
 * bounded recovery instead of the old "模型没有返回检查点补丁" immediate throw:
 *   - reasoning_only → fresh retry with thinking disabled
 *   - length → raise budget within model caps
 *   - all attempts empty → actionable MEMORY_CHECKPOINT_EMPTY_RESPONSE
 *   - truncated output at budget cap → split batch (3 → 1+2) and succeed
 */

import type { Chapter } from '../src/types/novel';

const mockCallLLMResult = jest.fn();
const mockSaveBatch = jest.fn();
const mockGetActiveLLMConfig = jest.fn();
const mockGetContextConfig = jest.fn();

jest.mock('../src/services/llm', () => ({
  callLLMResult: (...args: unknown[]) => mockCallLLMResult(...args),
}));

jest.mock('../src/utils/idfCache', () => ({
  invalidateIdf: jest.fn(),
}));

jest.mock('../src/services/database', () => ({
  getContextConfig: (...args: unknown[]) => mockGetContextConfig(...args),
  getActiveLLMConfig: (...args: unknown[]) => mockGetActiveLLMConfig(...args),
  saveStoryMemoryBatchUpdate: (...args: unknown[]) => mockSaveBatch(...args),
}));

jest.mock(
  '../src/services/continuation/chapterNumbering/continuationChapterNumbering',
  () => ({
    getContinuationChapterNumbering: jest.fn(async () => ({
      getDisplayNumber: (position: number) => position + 1,
    })),
  }),
);

jest.mock(
  '../src/services/storyMemory/storyMemoryPolicy',
  () => jest.requireActual('../src/services/storyMemory/storyMemoryPolicy'),
);
jest.mock(
  '../src/services/storyMemory/storyMemoryMerger',
  () => jest.requireActual('../src/services/storyMemory/storyMemoryMerger'),
);
jest.mock(
  '../src/services/storyMemory/storyMemoryCheckpointService',
  () =>
    jest.requireActual(
      '../src/services/storyMemory/storyMemoryCheckpointService',
    ),
);

import { runStoryMemoryCheckpointBatch } from '../src/services/storyMemory/storyMemoryCheckpointService';
import { createEmptyStoryMemory } from '../src/services/storyMemory/storyMemoryDefaults';

function chapter(position: number): Chapter {
  return {
    id: position + 1,
    project_id: 1,
    position,
    title: `第 ${position + 1} 章`,
    synopsis: '',
    content: `第 ${position + 1} 章正文内容。`,
    status: 'final',
    summary_json: null,
    memory_summary: '',
    created_at: '',
    updated_at: '',
  };
}

function validBatchPatchJson(batchChapters: Chapter[]): string {
  const first = batchChapters[0];
  const last = batchChapters[batchChapters.length - 1];
  return JSON.stringify({
    schemaVersion: 2,
    rangeRef: {
      fromChapterId: first.id,
      fromPosition: first.position,
      throughChapterId: last.id,
      throughPosition: last.position,
    },
    chapterSummaries: batchChapters.map(c => ({
      chapterId: c.id,
      chapterPosition: c.position,
      brief: `第 ${c.position + 1} 章摘要。`,
      keywords: ['关键词'],
      events: [`第 ${c.position + 1} 章事件`],
      characterChanges: [],
      relationshipChanges: [],
      mainlineChanges: [],
      newThreads: [],
      resolvedThreads: [],
    })),
    newCharacters: [],
    characterUpdates: [],
    newRelationships: [],
    relationshipUpdates: [],
    mainlinePatch: {
      assessment: { result: 'unchanged', reason: '本章无持续主线变化' },
      currentArcUpdate: { action: 'none', arcRef: '', name: '', summary: '', evidence: [] },
      conflictUpserts: [],
      conflictResolutions: [],
      threadOpens: [],
      threadUpdates: [],
      threadResolutions: [],
      foreshadowingUpserts: [],
      timelineAnchors: [],
      completedBeats: [],
    },
  });
}

function emptyResult(emptyReason: string, finishReason: string | null) {
  return {
    text: null,
    inputTokens: 10,
    outputTokens: 0,
    totalTokens: 10,
    emptyReason,
    finishReason,
  };
}

function makeState() {
  const state = createEmptyStoryMemory(1);
  return state;
}

describe('repair plan P1 — checkpoint empty-response recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCallLLMResult.mockReset();
    mockGetContextConfig.mockResolvedValue({ memoryPatchMaxTokens: 1200 });
    mockGetActiveLLMConfig.mockResolvedValue({
      id: 1,
      context_window: 32768,
      max_output_tokens: 8192,
    });
    mockSaveBatch.mockResolvedValue(undefined);
  });

  it('reasoning_only → fresh retry with thinking disabled → success persisted', async () => {
    const batch = [chapter(0), chapter(1), chapter(2)];
    mockCallLLMResult
      .mockResolvedValueOnce(emptyResult('reasoning_only', 'stop'))
      .mockResolvedValueOnce({
        text: validBatchPatchJson(batch),
        inputTokens: 10,
        outputTokens: 10,
        totalTokens: 20,
        finishReason: 'stop',
      });

    const result = await runStoryMemoryCheckpointBatch({
      projectId: 1,
      chapters: batch,
      previousState: makeState(),
    });

    expect(mockCallLLMResult).toHaveBeenCalledTimes(2);
    const firstCall = mockCallLLMResult.mock.calls[0];
    expect(firstCall[2]?.thinking).toEqual({ type: 'disabled' });
    expect(firstCall[2]?.responseFormat).toBe('json_object');
    // Second request must carry thinking: disabled.
    const secondCall = mockCallLLMResult.mock.calls[1];
    expect(secondCall[2]?.thinking).toEqual({ type: 'disabled' });
    expect(result.state.throughChapterPosition).toBe(2);
    expect(mockSaveBatch).toHaveBeenCalledTimes(1);
  });

  it('length at the V5 reservation → split child batches → success', async () => {
    const batch = [chapter(0), chapter(1)];
    mockGetActiveLLMConfig.mockResolvedValue({
      id: 1,
      model_name: 'v5-model',
      context_window: 32768,
      max_output_tokens: 8192,
    });
    mockCallLLMResult
      .mockResolvedValueOnce(emptyResult('length', 'length'))
      .mockResolvedValueOnce({
        text: validBatchPatchJson([chapter(0)]),
        inputTokens: 10,
        outputTokens: 10,
        totalTokens: 20,
        finishReason: 'stop',
      })
      .mockResolvedValueOnce({
        text: validBatchPatchJson([chapter(1)]),
        inputTokens: 10,
        outputTokens: 10,
        totalTokens: 20,
        finishReason: 'stop',
      });

    const result = await runStoryMemoryCheckpointBatch({
      projectId: 1,
      chapters: batch,
      previousState: makeState(),
    });

    expect(mockCallLLMResult).toHaveBeenCalledTimes(3);
    const firstMaxTokens = mockCallLLMResult.mock.calls[0][1] as number;
    const secondMaxTokens = mockCallLLMResult.mock.calls[1][1] as number;
    expect(secondMaxTokens).toBe(firstMaxTokens);
    expect(result.state.throughChapterPosition).toBe(1);
  });

  it('three consecutive empty responses fail with MEMORY_CHECKPOINT_EMPTY_RESPONSE', async () => {
    const batch = [chapter(0)];
    mockCallLLMResult.mockResolvedValue(emptyResult('empty', 'stop'));

    await expect(
      runStoryMemoryCheckpointBatch({
        projectId: 1,
        chapters: batch,
        previousState: makeState(),
      }),
    ).rejects.toMatchObject({
      code: 'MEMORY_CHECKPOINT_EMPTY_RESPONSE',
    });
    expect(mockCallLLMResult).toHaveBeenCalledTimes(3);
    // Nothing persisted.
    expect(mockSaveBatch).not.toHaveBeenCalled();
  });

  it('content_filter fails immediately without retries', async () => {
    const batch = [chapter(0)];
    mockCallLLMResult.mockResolvedValue(
      emptyResult('content_filter', 'content_filter'),
    );

    await expect(
      runStoryMemoryCheckpointBatch({
        projectId: 1,
        chapters: batch,
        previousState: makeState(),
      }),
    ).rejects.toMatchObject({
      code: 'MEMORY_CHECKPOINT_EMPTY_RESPONSE',
    });
    expect(mockCallLLMResult).toHaveBeenCalledTimes(1);
  });

  it('truncated output at the model cap splits a 3-chapter batch (3 → 1+2) and succeeds', async () => {
    const batch = [chapter(0), chapter(1), chapter(2)];
    // Model cap: max_output_tokens=2000 → budget cannot grow after the first
    // truncated reply, so the coordinator signals BATCH_TOO_LARGE.
    mockGetActiveLLMConfig.mockResolvedValue({
      id: 1,
      context_window: 32768,
      max_output_tokens: 2000,
    });
    const truncated = validBatchPatchJson(batch).slice(0, 80);
    mockCallLLMResult
      // Batch of 3 → truncated at cap → split.
      .mockResolvedValueOnce({
        text: truncated,
        inputTokens: 10,
        outputTokens: 2000,
        totalTokens: 2010,
        finishReason: 'length',
      })
      // Sub-batch 1 (chapters 0..1) → success.
      .mockResolvedValueOnce({
        text: validBatchPatchJson([chapter(0), chapter(1)]),
        inputTokens: 10,
        outputTokens: 10,
        totalTokens: 20,
        finishReason: 'stop',
      })
      // Sub-batch 2 (chapter 2) → success.
      .mockResolvedValueOnce({
        text: validBatchPatchJson([chapter(2)]),
        inputTokens: 10,
        outputTokens: 10,
        totalTokens: 20,
        finishReason: 'stop',
      });

    const result = await runStoryMemoryCheckpointBatch({
      projectId: 1,
      chapters: batch,
      previousState: makeState(),
    });

    expect(mockCallLLMResult).toHaveBeenCalledTimes(3);
    expect(result.state.throughChapterPosition).toBe(2);
    // Both sub-batches persisted (partial-success safe).
    expect(mockSaveBatch).toHaveBeenCalledTimes(2);
    expect(result.chapterSummaryTexts).toHaveLength(3);
  });
});
