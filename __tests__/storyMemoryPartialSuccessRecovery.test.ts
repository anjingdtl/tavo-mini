/**
 * P1 最终收口冒烟/回归（真实 SQLite + 真实 repository/checkpoint 调用链）。
 *
 * 场景：initial empty → batch1 success（已持久化 clean checkpoint）→ batch2 failure。
 * 正确语义（Case A）：batch1 最新成功 checkpoint 保留（status=clean、through=batch1 终点、
 * lastError=batch2 错误、eligibility=usable），下次 retry 从 batch2 继续，不重做 batch1。
 *
 * 本文件同时覆盖：
 * - Case B：empty → 首个 batch 直接失败 → 不得出现虚假 clean checkpoint。
 * - Case D：covered history 编辑后 dirty rebuild 失败 → 仍 dirty、不可注入。
 * - Preview 收口：partial success 后重读 DB，真实 buildContext(preview) 必须包含
 *   story_memory（trace included + tokens > 0 + storyMemoryText 非空）。
 */
import {
  createEmptyInMemoryDb,
  type InMemorySqliteDb,
} from './helpers/canonInMemoryDb';
import {
  __resetForTest,
  __setDatabaseForTest,
  openDatabase,
} from '../src/data/connection/openDatabase';
import { createCurrentSchema } from '../src/data/schema/createCurrentSchema';
import { execute } from '../src/data/connection/execute';
import {
  getProjectStoryMemory,
  markStoryMemoryDirtyIfCovered,
} from '../src/data/repositories/storyMemoryRepository';
import { resolveUsableCheckpointForTarget } from '../src/services/storyMemory/storyMemoryCheckpointEligibility';
import type { Chapter } from '../src/types/novel';

const mockCallLLMResult = jest.fn();
jest.mock('../src/services/llm', () => ({
  callLLMResult: (...args: unknown[]) => mockCallLLMResult(...args),
}));

// 被测代码用动态 import() 加载协作模块；Jest 无
// --experimental-vm-modules 时原生动态 import 不可用，注册 mock 工厂
// （返回真实实现）让动态 import 命中模块注册表。
jest.mock(
  '../src/services/storyMemory/storyMemoryPolicy',
  () => jest.requireActual('../src/services/storyMemory/storyMemoryPolicy'),
);
jest.mock(
  '../src/services/storyMemory/storyMemoryCheckpointService',
  () =>
    jest.requireActual('../src/services/storyMemory/storyMemoryCheckpointService'),
);
jest.mock(
  '../src/services/storyMemory/storyMemoryRebuild',
  () => jest.requireActual('../src/services/storyMemory/storyMemoryRebuild'),
);
jest.mock(
  '../src/services/storyMemory/storyMemoryMerger',
  () => jest.requireActual('../src/services/storyMemory/storyMemoryMerger'),
);
jest.mock(
  '../src/services/storyMemory/storyMemoryService',
  () => jest.requireActual('../src/services/storyMemory/storyMemoryService'),
);
jest.mock(
  '../src/services/continuation/chapterNumbering/continuationChapterNumbering',
  () =>
    jest.requireActual(
      '../src/services/continuation/chapterNumbering/continuationChapterNumbering',
    ),
);

import { advanceStoryMemoryCheckpointsUnlocked } from '../src/services/storyMemory/storyMemoryCheckpointService';
import { rebuildStoryMemoryUnlocked } from '../src/services/storyMemory/storyMemoryRebuild';
import { buildContext } from '../src/services/contextBuilder';
import type { ContextConfig } from '../src/types/novel';

let testDb: InMemorySqliteDb | null = null;

async function resetDb(): Promise<void> {
  __resetForTest();
  testDb = await createEmptyInMemoryDb();
  __setDatabaseForTest(testDb as any);
  await createCurrentSchema(testDb as any);
}

afterEach(async () => {
  __resetForTest();
  if (testDb) {
    try {
      testDb.close();
    } catch {
      /* ignore */
    }
    testDb = null;
  }
});

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

async function seedProjectWithChapters(count: number): Promise<void> {
  const dbHandle = await openDatabase();
  await execute(
    dbHandle,
    `INSERT INTO projects (id, name, mode, created_at, updated_at)
     VALUES (1, '测试项目', 'outline', 't', 't')`,
  );
  for (let position = 0; position < count; position += 1) {
    await execute(
      dbHandle,
      `INSERT INTO chapters (id, project_id, position, title, synopsis, content,
        status, summary_json, memory_summary, created_at, updated_at)
       VALUES (${position + 1}, 1, ${position}, '第 ${position + 1} 章', '',
        '第 ${position + 1} 章正文内容。', 'final', NULL, '', 't', 't')`,
    );
  }
}

async function chaptersOfProject(): Promise<Chapter[]> {
  const { getChaptersByProject } = require('../src/services/database');
  return getChaptersByProject(1);
}

describe('P1: partial checkpoint success then failure (real SQLite)', () => {
  it('T13: empty → batch1 success → batch2 failure keeps batch1 clean checkpoint usable', async () => {
    await resetDb();
    await seedProjectWithChapters(6);
    const chapters = await chaptersOfProject();
    const firstBatch = chapters.slice(0, 3); // positions 0-2
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

    const record = await getProjectStoryMemory(1);
    expect(record).not.toBeNull();
    // batch1 的成功 checkpoint 必须保留
    expect(record!.status).toBe('clean');
    expect(record!.state.throughChapterPosition).toBe(2);
    expect(record!.state.metadata.status).toBe('clean');
    // lastError 记录 batch2 的失败
    expect(record!.lastError).toContain('mock LLM 故障');
    // eligibility = usable（注入时可用，不再 0 tokens / 未包含）
    const eligibility = resolveUsableCheckpointForTarget(record, 3);
    expect(eligibility.usable).toBe(true);
    expect(eligibility.checkpointThroughPosition).toBe(2);
  });

  it('T14: retry after partial failure resumes from batch2 without re-calling batch1 LLM', async () => {
    await resetDb();
    await seedProjectWithChapters(6);
    const chapters = await chaptersOfProject();
    const firstBatch = chapters.slice(0, 3);
    const secondBatch = chapters.slice(3, 6); // positions 3-5
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

    mockCallLLMResult.mockClear();
    mockCallLLMResult.mockResolvedValueOnce({
      text: validBatchPatchJson(secondBatch),
      inputTokens: 10,
      outputTokens: 10,
      totalTokens: 20,
    });

    const retry = await advanceStoryMemoryCheckpointsUnlocked({ projectId: 1 });
    // 只调用一次 LLM（batch2），batch1 不重复
    expect(mockCallLLMResult).toHaveBeenCalledTimes(1);
    const messages = mockCallLLMResult.mock.calls[0][0] as Array<{
      role: string;
      content: string;
    }>;
    expect(messages.map(m => m.content).join('\n')).toContain('position 3～5');
    expect(retry.batchesApplied).toBe(1);
    expect(retry.state.throughChapterPosition).toBe(5);
    const record = await getProjectStoryMemory(1);
    expect(record!.status).toBe('clean');
    expect(record!.state.throughChapterPosition).toBe(5);
  });

  it('T15: first batch failure never fabricates a clean checkpoint', async () => {
    await resetDb();
    await seedProjectWithChapters(6);
    mockCallLLMResult.mockRejectedValueOnce(new Error('mock LLM 故障'));

    await expect(
      advanceStoryMemoryCheckpointsUnlocked({ projectId: 1 }),
    ).rejects.toThrow('mock LLM 故障');

    const record = await getProjectStoryMemory(1);
    expect(record).not.toBeNull();
    expect(record!.status).toBe('empty');
    expect(record!.state.throughChapterPosition).toBe(-1);
    expect(record!.lastError).toContain('mock LLM 故障');
    const eligibility = resolveUsableCheckpointForTarget(record, 3);
    expect(eligibility.usable).toBe(false);
    expect(eligibility.reason).toBe('not_clean');
  });

  it('T16: dirty rebuild failure keeps dirty semantics — never injectable', async () => {
    await resetDb();
    await seedProjectWithChapters(6);
    const chapters = await chaptersOfProject();
    // 先成功建立 checkpoint（两批都成功，through=5）
    mockCallLLMResult.mockImplementation(async (_messages: unknown) => ({
      text: validBatchPatchJson(chapters.slice(0, 3)),
      inputTokens: 10,
      outputTokens: 10,
      totalTokens: 20,
    }));
    const first = await advanceStoryMemoryCheckpointsUnlocked({
      projectId: 1,
      throughPosition: 2,
    });
    expect(first.state.throughChapterPosition).toBe(2);
    mockCallLLMResult.mockClear();
    mockCallLLMResult.mockResolvedValueOnce({
      text: validBatchPatchJson(chapters.slice(3, 6)),
      inputTokens: 10,
      outputTokens: 10,
      totalTokens: 20,
    });
    const second = await advanceStoryMemoryCheckpointsUnlocked({ projectId: 1 });
    expect(second.state.throughChapterPosition).toBe(5);
    const cleanBefore = await getProjectStoryMemory(1);
    expect(cleanBefore!.status).toBe('clean');

    // 编辑已覆盖章节 → dirty
    await markStoryMemoryDirtyIfCovered(1, 2, '测试：已覆盖章节被编辑');
    const dirty = await getProjectStoryMemory(1);
    expect(dirty!.status).toBe('dirty');
    expect(dirty!.dirtyFromPosition).toBe(2);

    // dirty rebuild 失败（LLM 不可达）
    mockCallLLMResult.mockRejectedValue(new Error('mock LLM 故障'));
    await expect(
      rebuildStoryMemoryUnlocked(1, { mode: 'auto' }),
    ).rejects.toThrow();

    // 不得退化为 clean/empty：仍不可注入
    const after = await getProjectStoryMemory(1);
    expect(after!.status).not.toBe('clean');
    expect(after!.status).not.toBe('empty');
    const eligibility = resolveUsableCheckpointForTarget(after, 6);
    expect(eligibility.usable).toBe(false);
    expect(eligibility.reason).toBe('not_clean');
  });
});

describe('P1: context preview closure after partial success (real SQLite)', () => {
  it('T17: preview after batch1 success + batch2 failure still includes story memory', async () => {
    await resetDb();
    await seedProjectWithChapters(7);
    const chapters = await chaptersOfProject();
    const firstBatch = chapters.slice(0, 3);
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

    // 重读 DB：最新成功 checkpoint 仍存在
    const record = await getProjectStoryMemory(1);
    expect(record!.status).toBe('clean');
    expect(record!.state.throughChapterPosition).toBe(2);

    const target = chapters[6]; // position 6（第7章）
    const contextConfig: ContextConfig = {
      strategy: 'sliding',
      slidingWindowSize: 4000,
      customRangeStart: 0,
      customRangeEnd: -1,
      includeResources: false,
      resourceBudget: 0,
      summaryBudgetTokens: 2000,
      episodicMemoryBudgetTokens: 1000,
      storyStateBudgetTokens: 4000,
      recentChapterCount: 10,
      worldbookScanDepth: 4,
      memoryTopK: 20,
      memoryPatchMaxTokens: 1200,
      memoryPatchTokenBudgetScale: 1,
    } as ContextConfig;

    const result = await buildContext(target, contextConfig, 1, undefined, {
      storyMemoryMode: 'preview',
    });
    const traceStory = result.trace.find(t => t.kind === 'story_memory');
    expect(traceStory).toBeDefined();
    expect(traceStory?.included).toBe(true);
    expect((traceStory?.estimatedTokens ?? 0)).toBeGreaterThan(0);
    expect(result.pipelineContext.storyMemoryText.length).toBeGreaterThan(0);
  });
});
