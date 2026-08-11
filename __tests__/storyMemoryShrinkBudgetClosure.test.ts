/**
 * 代码审查修复二/三/四（P1/P2）：
 *
 * - 修复二：多章组合提示无上下文余量（预算 0）时必须自动拆分，不能直接失败。
 *   只有单章也无法容纳时才返回可操作的模型能力错误，且不发送注定失败的请求。
 * - 修复三：每一次重试（含扩容）都必须受同一个 safeOutputMaxForModel 硬上限
 *   （context_window - input - safetyMargin）约束；无法扩容时多章拆批、单章给提示。
 * - 修复四：空响应且 finishReason=length、预算到顶时，多章批次进入拆分流程；
 *   单章返回可操作错误；空输出绝不构造 `assistant: ''` 修复对话。
 */

import type { Chapter } from '../src/types/novel';
import { estimateCheckpointInputTokens } from '../src/services/storyMemory/storyMemoryBudget';
import { createEmptyStoryMemory } from '../src/services/storyMemory/storyMemoryDefaults';

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

function chapter(position: number, content = `第 ${position + 1} 章正文内容。`): Chapter {
  return {
    id: position + 1,
    project_id: 1,
    position,
    title: `第 ${position + 1} 章`,
    synopsis: '',
    content,
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
  return createEmptyStoryMemory(1);
}

describe('Protocol V2: multi-chapter batches auto-split before an undersized request', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetContextConfig.mockResolvedValue({ memoryPatchMaxTokens: 1200 });
    mockSaveBatch.mockResolvedValue(undefined);
  });

  it('3-chapter batch with zero headroom splits to sub-batches that each fit and succeeds', async () => {
    // Protocol V2 的 3 章最低输出能力为 12288；该模型上限为 8192，
    // 因此 3 章在发送前拆为 2+1，而子批次仍然可容纳。
    const longContent = '故事正文内容。'.repeat(40); // ~200 字/章
    const batch = [chapter(0, longContent), chapter(1, longContent), chapter(2, longContent)];
    // 3 章的 V2 最低输出能力超过模型上限，拆散后子批次拥有可用预算。
    const contextWindow = 32768;
    mockGetActiveLLMConfig.mockResolvedValue({
      id: 1,
      model_name: 'v5-model',
      context_window: contextWindow,
      max_output_tokens: 8192,
    });

    mockCallLLMResult.mockImplementation(
      async (messages: Array<{ role: string; content: string }>) => {
        const user = messages.map(m => m.content).join('\n');
        const positions = user.match(/position (\d+)～(\d+)/);
        const from = positions ? Number(positions[1]) : 0;
        const to = positions ? Number(positions[2]) : 0;
        return {
          text: validBatchPatchJson(batch.slice(from, to + 1)),
          inputTokens: 10,
          outputTokens: 10,
          totalTokens: 20,
          finishReason: 'stop',
        };
      },
    );

    const result = await runStoryMemoryCheckpointBatch({
      projectId: 1,
      chapters: batch,
      previousState: makeState(),
    });

    // 原批次自动拆分；每个子批次重新生成提示并重新估算输入（N < 3）。
    expect(mockCallLLMResult.mock.calls.length).toBeGreaterThan(1);
    const sizes: number[] = [];
    for (const call of mockCallLLMResult.mock.calls) {
      const user = (call[0] as Array<{ role: string; content: string }>)
        .map(m => m.content)
        .join('\n');
      const match = user.match(/【本批次范围】(?:共 )?(\d+) 章/);
      expect(match).not.toBeNull();
      sizes.push(Number(match![1]));
    }
    expect(sizes.every(size => size < 3)).toBe(true);
    expect(sizes).toContain(1);
    expect(result.state.throughChapterPosition).toBe(2);
    // 每个子批次都持久化一次。
    expect(mockSaveBatch).toHaveBeenCalledTimes(mockCallLLMResult.mock.calls.length);
  });

  it('single chapter that still cannot fit fails WITHOUT sending a doomed LLM request', async () => {
    const batch = [chapter(0, '故事正文内容。'.repeat(200))]; // ~1000 字
    mockGetActiveLLMConfig.mockResolvedValue({
      id: 1,
      model_name: 'v5-model',
      context_window: 4500,
      max_output_tokens: 8192,
    });

    await expect(
      runStoryMemoryCheckpointBatch({
        projectId: 1,
        chapters: batch,
        previousState: makeState(),
      }),
    ).rejects.toMatchObject({
      code: 'MEMORY_CHECKPOINT_FAILED',
    });

    // 不发送注定失败的请求。
    expect(mockCallLLMResult).not.toHaveBeenCalled();
    expect(mockSaveBatch).not.toHaveBeenCalled();
    // 错误信息给出可操作的模型能力提示。
    await expect(
      runStoryMemoryCheckpointBatch({
        projectId: 1,
        chapters: batch,
        previousState: makeState(),
      }),
    ).rejects.toThrow(/context_window/);
  });
});

describe('P1 fix 3: every retry stays under the context_window hard cap', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetContextConfig.mockResolvedValue({ memoryPatchMaxTokens: 1200 });
    mockSaveBatch.mockResolvedValue(undefined);
    mockGetActiveLLMConfig.mockResolvedValue({
      id: 1,
      model_name: 'v5-model',
      context_window: 5000,
      max_output_tokens: 100000,
    });
  });

  it('length retry never exceeds context_window - input - safetyMargin; multi-chapter splits when stuck', async () => {
    const longContent = '故事正文内容。'.repeat(40); // ~200 字/章
    const batch = [chapter(0, longContent), chapter(1, longContent), chapter(2, longContent)];
    // 3 章的 V2 输出 reservation 为 20480，超过窗口可用容量，
    // 先拆成 [2 章, 1 章]；2 章空 length 后到达 cap，再拆成单章成功。
    const contextWindow = 20000;
    mockGetActiveLLMConfig.mockResolvedValue({
      id: 1,
      model_name: 'v5-model',
      context_window: contextWindow,
      max_output_tokens: 100000,
    });
    mockCallLLMResult.mockImplementation(
      async (messages: Array<{ role: string; content: string }>) => {
        const user = messages.map(m => m.content).join('\n');
        const positions = user.match(/position (\d+)～(\d+)/);
        const from = positions ? Number(positions[1]) : 0;
        const to = positions ? Number(positions[2]) : 0;
        const size = to - from + 1;
        if (size > 1) {
          return emptyResult('length', 'length');
        }
        return {
          text: validBatchPatchJson(batch.slice(from, to + 1)),
          inputTokens: 10,
          outputTokens: 10,
          totalTokens: 20,
          finishReason: 'stop',
        };
      },
    );

    const result = await runStoryMemoryCheckpointBatch({
      projectId: 1,
      chapters: batch,
      previousState: makeState(),
    });

    expect(result.state.throughChapterPosition).toBe(2);
    // 每个物理请求的 maxTokens 都不超过 context_window 剩余空间。
    for (const call of mockCallLLMResult.mock.calls) {
      const maxTokens = call[1] as number;
      const messages = call[0] as Array<{ role: string; content: string }>;
      const input = estimateCheckpointInputTokens(messages);
      const safetyMargin = Math.min(
        1024,
        Math.max(256, Math.floor(contextWindow * 0.02)),
      );
      expect(maxTokens).toBeLessThanOrEqual(
        contextWindow - input - safetyMargin,
      );
    }
  });
});

describe('P1 fix 4: empty length response at budget cap splits multi-chapter batches', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetContextConfig.mockResolvedValue({ memoryPatchMaxTokens: 1200 });
    mockSaveBatch.mockResolvedValue(undefined);
    mockGetActiveLLMConfig.mockResolvedValue({
      id: 1,
      model_name: 'v5-model',
      context_window: 32768,
      // V2 3 章 reservation=20480；正好让初始 3 章请求到达 cap，
      // 然后沿用既有 3→2→1 split 语义。
      max_output_tokens: 20480,
    });
  });

  it('multi-chapter batch: empty length at the cap → split → sub-batches succeed', async () => {
    const batch = [chapter(0), chapter(1), chapter(2)];
    mockCallLLMResult
      // 3 章：空 length，V2 reservation=20480 到顶 → 拆分。
      .mockResolvedValueOnce(emptyResult('length', 'length'))
      // 子批次 1（2 章）→ 成功。
      .mockResolvedValueOnce({
        text: validBatchPatchJson([chapter(0), chapter(1)]),
        inputTokens: 10,
        outputTokens: 10,
        totalTokens: 20,
        finishReason: 'stop',
      })
      // 子批次 2（1 章）→ 成功。
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
    expect(mockSaveBatch).toHaveBeenCalledTimes(2);
  });

  it('empty length responses never construct an assistant:"" repair dialogue', async () => {
    const batch = [chapter(0), chapter(1), chapter(2)];
    mockCallLLMResult
      .mockResolvedValueOnce(emptyResult('length', 'length'))
      .mockResolvedValueOnce({
        text: validBatchPatchJson([chapter(0), chapter(1)]),
        inputTokens: 10,
        outputTokens: 10,
        totalTokens: 20,
        finishReason: 'stop',
      })
      .mockResolvedValueOnce({
        text: validBatchPatchJson([chapter(2)]),
        inputTokens: 10,
        outputTokens: 10,
        totalTokens: 20,
        finishReason: 'stop',
      });

    await runStoryMemoryCheckpointBatch({
      projectId: 1,
      chapters: batch,
      previousState: makeState(),
    });

    // 任何物理请求的消息序列都不允许出现 assistant 角色（空回显修复）。
    for (const call of mockCallLLMResult.mock.calls) {
      const messages = call[0] as Array<{ role: string; content: string }>;
      expect(messages.some(m => m.role === 'assistant')).toBe(false);
    }
  });

  it('single chapter with empty length at the cap returns an actionable model-capability error', async () => {
    const batch = [chapter(0)];
    mockCallLLMResult.mockResolvedValue(emptyResult('length', 'length'));

    await expect(
      runStoryMemoryCheckpointBatch({
        projectId: 1,
        chapters: batch,
        previousState: makeState(),
      }),
    ).rejects.toMatchObject({
      code: 'MEMORY_CHECKPOINT_EMPTY_RESPONSE',
    });
    const message = await runStoryMemoryCheckpointBatch({
      projectId: 1,
      chapters: batch,
      previousState: makeState(),
    }).then(
      () => 'unexpected success',
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    expect(message).toMatch(/max_output_tokens|context_window/);
  });
});
