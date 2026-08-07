import type { Chapter } from '../src/types/novel';
import { createEmptyStoryMemory } from '../src/services/storyMemory/storyMemoryDefaults';
import {
  resolveUsableCheckpointForTarget,
} from '../src/services/storyMemory/storyMemoryCheckpointEligibility';

const mockCallLLMResult = jest.fn();
const mockGetChapters = jest.fn();
const mockEnsureRow = jest.fn();
const mockEnsurePolicy = jest.fn();
const mockSetBuildStatus = jest.fn();
const mockGetContextConfig = jest.fn();
const mockSaveBatch = jest.fn();
const mockMarkDirty = jest.fn();

jest.mock('../src/services/llm', () => ({
  callLLMResult: (...args: unknown[]) => mockCallLLMResult(...args),
}));

jest.mock('../src/services/database', () => ({
  getChaptersByProject: (...args: unknown[]) => mockGetChapters(...args),
  ensureProjectStoryMemoryRow: (...args: unknown[]) => mockEnsureRow(...args),
  ensureStoryMemoryPolicy: (...args: unknown[]) => mockEnsurePolicy(...args),
  setStoryMemoryBuildStatus: (...args: unknown[]) => mockSetBuildStatus(...args),
  getContextConfig: (...args: unknown[]) => mockGetContextConfig(...args),
  saveStoryMemoryBatchUpdate: (...args: unknown[]) => mockSaveBatch(...args),
  markStoryMemoryDirty: (...args: unknown[]) => mockMarkDirty(...args),
  getProjectStoryMemory: jest.fn(),
}));

// 被测代码用动态 import() 加载 storyMemoryPolicy；Jest 无
// --experimental-vm-modules 时原生动态 import 不可用，这里注册
// jest.mock 工厂（返回真实实现）让动态 import 命中模块注册表。
jest.mock(
  '../src/services/storyMemory/storyMemoryPolicy',
  () =>
    jest.requireActual('../src/services/storyMemory/storyMemoryPolicy'),
);

import { advanceStoryMemoryCheckpointsUnlocked } from '../src/services/storyMemory/storyMemoryCheckpointService';
import type { StoryMemoryState } from '../src/services/storyMemory/storyMemoryTypes';

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

function cleanRecordThrough(
  projectId: number,
  through: number,
): { status: string; dirtyFromPosition: null; state: StoryMemoryState } {
  const state = createEmptyStoryMemory(projectId);
  state.throughChapterPosition = through;
  state.throughChapterId = through + 1;
  return { status: 'clean', dirtyFromPosition: null, state };
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
      keywords: [],
      events: [],
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
      assessment: {
        result: 'unchanged',
        reason: '本章无持续主线变化',
      },
      currentArcUpdate: {
        action: 'none',
        arcRef: '',
        name: '',
        summary: '',
        evidence: [],
      },
      currentObjective: undefined,
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

describe('advance checkpoint failure vs old checkpoint validity (H3)', () => {
  const chapters = Array.from({ length: 51 }, (_, i) => chapter(i));
  const record = cleanRecordThrough(1, 20);

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetChapters.mockResolvedValue(chapters);
    mockEnsureRow.mockResolvedValue(record);
    mockEnsurePolicy.mockResolvedValue(
      createEmptyStoryMemory(1) && {
        projectId: 1,
        mode: 'smart',
        intervalChapters: 10,
        pendingTokenSoftLimit: 12000,
        updateOnKeyChapter: true,
        updatedAt: new Date().toISOString(),
      },
    );
    mockGetContextConfig.mockResolvedValue({ memoryPatchMaxTokens: 1200 });
  });

  it('T9a: failed first batch keeps previous status clean (old checkpoint stays usable)', async () => {
    mockCallLLMResult.mockRejectedValue(new Error('mock LLM 故障'));
    await expect(
      advanceStoryMemoryCheckpointsUnlocked({ projectId: 1 }),
    ).rejects.toThrow('mock LLM 故障');
    expect(mockSetBuildStatus).toHaveBeenCalledTimes(1);
    const [projectId, status, dirtyFromPosition, lastError] =
      mockSetBuildStatus.mock.calls[0];
    expect(projectId).toBe(1);
    expect(status).toBe('clean');
    expect(dirtyFromPosition).toBeNull();
    expect(String(lastError)).toContain('mock LLM 故障');
    expect(resolveUsableCheckpointForTarget(record as any, 50).usable).toBe(
      true,
    );
  });

  it('T7c: interval=10 still uses LLM batch size 3 (decoupled)', async () => {
    mockCallLLMResult.mockRejectedValue(new Error('mock LLM 故障'));
    await expect(
      advanceStoryMemoryCheckpointsUnlocked({ projectId: 1 }),
    ).rejects.toThrow('mock LLM 故障');
    expect(mockCallLLMResult).toHaveBeenCalledTimes(1);
    const messages = mockCallLLMResult.mock.calls[0][0] as Array<{
      role: string;
      content: string;
    }>;
    const userContent = messages.map(m => m.content).join('\n');
    expect(userContent).toContain('【本批次范围】共 3 章');
    expect(userContent).toContain('position 21～23');
    expect(userContent).not.toContain('共 10 章');
  });

  it('T9b: batch1 succeeds then batch2 fails — batch1 saved, resume continues after it', async () => {
    const firstBatch = chapters.slice(21, 24);
    mockCallLLMResult
      .mockResolvedValueOnce({
        text: validBatchPatchJson(firstBatch),
        inputTokens: 10,
        outputTokens: 10,
        totalTokens: 20,
      })
      .mockRejectedValueOnce(new Error('mock LLM 故障'));
    await expect(
      advanceStoryMemoryCheckpointsUnlocked({ projectId: 1 }),
    ).rejects.toThrow('mock LLM 故障');
    expect(mockSaveBatch).toHaveBeenCalledTimes(1);
    const saved = mockSaveBatch.mock.calls[0][0] as {
      state: StoryMemoryState;
    };
    expect(saved.state.throughChapterPosition).toBe(23);
    expect(mockCallLLMResult).toHaveBeenCalledTimes(2);
    const secondMessages = mockCallLLMResult.mock.calls[1][0] as Array<{
      role: string;
      content: string;
    }>;
    const secondUserContent = secondMessages.map(m => m.content).join('\n');
    expect(secondUserContent).toContain('position 24～26');
    const [projectId, status] = mockSetBuildStatus.mock.calls[0];
    expect(projectId).toBe(1);
    expect(status).toBe('clean');
  });
});
