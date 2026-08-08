/**
 * 代码审查修复一（P1）：拆分批次的部分成功不能被旧状态覆盖。
 *
 * 场景：一批 3 章因模型能力上限被拆成 [2 章, 1 章]。
 * - 第一半（2 章）生成并成功持久化（clean、through=1、新 fingerprint）；
 * - 第二半（1 章）生成失败；
 * - 递归拆分必须把第一半的最新 state 带回外层：
 *   * advance 流程的失败回写必须以数据库最新成功状态为准（clean，不得回到 empty/failed）；
 *   * lastError 记录第二半失败；
 *   * 下一次重试从第一半终点继续，不重做第一半（fingerprint/CAS 语义不破坏）。
 *
 * rebuild 路径同场景：completedChapters 必须反映第一半成功章数，
 * 不得因「本批次 completedChapters=0」把整个项目标记为 failed。
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
} from '../src/data/repositories/storyMemoryRepository';
import { resolveUsableCheckpointForTarget } from '../src/services/storyMemory/storyMemoryCheckpointEligibility';
import type { Chapter } from '../src/types/novel';

const mockCallLLMResult = jest.fn();
const mockGetActiveLLMConfig = jest.fn();

jest.mock('../src/services/llm', () => ({
  callLLMResult: (...args: unknown[]) => mockCallLLMResult(...args),
}));

// 真实 SQLite + 仅覆写活动模型能力（触发拆分需要小 max_output_tokens）。
jest.mock('../src/services/database', () => ({
  ...jest.requireActual('../src/services/database'),
  getActiveLLMConfig: (...args: unknown[]) => mockGetActiveLLMConfig(...args),
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
    jest.requireActual(
      '../src/services/storyMemory/storyMemoryCheckpointService',
    ),
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

describe('P1 fix: split-batch partial success must survive second-half failure', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // 小 max_output_tokens：3 章组合输出被截断后预算无法扩容 → 触发拆分。
    mockGetActiveLLMConfig.mockResolvedValue({
      id: 1,
      context_window: 32768,
      max_output_tokens: 2000,
    });
  });

  it('advance: first half persisted, second half fails — DB keeps clean/through/fingerprint, lastError records failure', async () => {
    await resetDb();
    await seedProjectWithChapters(6);
    const chapters = await chaptersOfProject();
    const firstHalf = chapters.slice(0, 2); // positions 0-1
    const truncated = validBatchPatchJson(chapters.slice(0, 3)).slice(0, 80);
    mockCallLLMResult
      .mockResolvedValueOnce({
        text: truncated,
        inputTokens: 10,
        outputTokens: 2000,
        totalTokens: 2010,
        finishReason: 'length',
      })
      .mockResolvedValueOnce({
        text: validBatchPatchJson(firstHalf),
        inputTokens: 10,
        outputTokens: 10,
        totalTokens: 20,
        finishReason: 'stop',
      })
      .mockRejectedValueOnce(new Error('第二半 mock LLM 故障'));

    await expect(
      advanceStoryMemoryCheckpointsUnlocked({ projectId: 1 }),
    ).rejects.toThrow('第二半 mock LLM 故障');

    // 数据库必须保留第一半的最新成功状态，不得被旧 empty 状态覆盖。
    const record = await getProjectStoryMemory(1);
    expect(record).not.toBeNull();
    expect(record!.status).toBe('clean');
    expect(record!.state.throughChapterPosition).toBe(1);
    expect(record!.state.metadata.status).toBe('clean');
    // lastError 记录第二半失败。
    expect(record!.lastError).toContain('第二半 mock LLM 故障');
    // 第一半 checkpoint 仍可用于后续注入。
    const eligibility = resolveUsableCheckpointForTarget(record, 2);
    expect(eligibility.usable).toBe(true);
    expect(eligibility.checkpointThroughPosition).toBe(1);
  });

  it('advance: retry after split partial failure resumes after the first half without re-calling its LLM', async () => {
    await resetDb();
    await seedProjectWithChapters(6);
    const chapters = await chaptersOfProject();
    const firstHalf = chapters.slice(0, 2);
    const truncated = validBatchPatchJson(chapters.slice(0, 3)).slice(0, 80);
    mockCallLLMResult
      .mockResolvedValueOnce({
        text: truncated,
        inputTokens: 10,
        outputTokens: 2000,
        totalTokens: 2010,
        finishReason: 'length',
      })
      .mockResolvedValueOnce({
        text: validBatchPatchJson(firstHalf),
        inputTokens: 10,
        outputTokens: 10,
        totalTokens: 20,
        finishReason: 'stop',
      })
      .mockRejectedValueOnce(new Error('第二半 mock LLM 故障'));

    await expect(
      advanceStoryMemoryCheckpointsUnlocked({ projectId: 1 }),
    ).rejects.toThrow('第二半 mock LLM 故障');

    mockCallLLMResult.mockClear();
    mockCallLLMResult.mockImplementation(
      async (messages: Array<{ role: string; content: string }>) => {
        const user = messages.map(m => m.content).join('\n');
        const positions = user.match(/position (\d+)～(\d+)/);
        const from = positions ? Number(positions[1]) : 0;
        const to = positions ? Number(positions[2]) : 0;
        return {
          text: validBatchPatchJson(chapters.slice(from, to + 1)),
          inputTokens: 10,
          outputTokens: 10,
          totalTokens: 20,
          finishReason: 'stop',
        };
      },
    );

    const retry = await advanceStoryMemoryCheckpointsUnlocked({ projectId: 1 });
    // 不重做第一半：只处理 position 2..5 的待覆盖章节。
    expect(retry.state.throughChapterPosition).toBe(5);
    const record = await getProjectStoryMemory(1);
    expect(record!.status).toBe('clean');
    expect(record!.state.throughChapterPosition).toBe(5);
  });

  it('rebuild: split partial success inside a batch keeps clean status instead of marking the project failed', async () => {
    await resetDb();
    await seedProjectWithChapters(6);
    const chapters = await chaptersOfProject();
    const firstHalf = chapters.slice(0, 2);
    const truncated = validBatchPatchJson(chapters.slice(0, 3)).slice(0, 80);
    mockCallLLMResult
      .mockResolvedValueOnce({
        text: truncated,
        inputTokens: 10,
        outputTokens: 2000,
        totalTokens: 2010,
        finishReason: 'length',
      })
      .mockResolvedValueOnce({
        text: validBatchPatchJson(firstHalf),
        inputTokens: 10,
        outputTokens: 10,
        totalTokens: 20,
        finishReason: 'stop',
      })
      .mockRejectedValueOnce(new Error('第二半 mock LLM 故障'));

    await expect(
      rebuildStoryMemoryUnlocked(1, { mode: 'full' }),
    ).rejects.toThrow('第二半 mock LLM 故障');

    // 不得标记 failed：第一半已成功，保留 clean 状态与最新 fingerprint。
    const record = await getProjectStoryMemory(1);
    expect(record!.status).toBe('clean');
    expect(record!.state.throughChapterPosition).toBe(1);
    expect(record!.state.metadata.status).toBe('clean');
    expect(record!.lastError).toContain('第二半 mock LLM 故障');
    const eligibility = resolveUsableCheckpointForTarget(record, 2);
    expect(eligibility.usable).toBe(true);
  });
});
