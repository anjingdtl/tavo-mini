/**
 * AE-04: finalizeChapterMemory returned state vs persisted DB state.
 *
 * Scenario: finalizeChapterMemory → batch1 success (persisted clean
 * checkpoint) → batch2 failure.
 *
 * The catch path must return the LATEST persisted state (batch1 endpoint),
 * not the function-entry snapshot (which may say through=-1 / status=empty).
 * Assertions:
 *   - returned.state.throughChapterPosition === latest persisted through
 *   - returned.patchId === latest persisted lastAppliedPatchId
 *   - returned.pendingCount === real remaining chapters after latest through
 *   - persisted DB row still clean with lastError of the failed batch
 */
import {
  createEmptyInMemoryDb,
  type InMemorySqliteDb,
} from './helpers/canonInMemoryDb';
import {
  __resetForTest,
  __setDatabaseForTest,
} from '../src/data/connection/openDatabase';
import { createCurrentSchema } from '../src/data/schema/createCurrentSchema';
import { execute } from '../src/data/connection/execute';
import { getProjectStoryMemory } from '../src/data/repositories/storyMemoryRepository';
import type { Chapter } from '../src/types/novel';

const mockCallLLMResult = jest.fn();
jest.mock('../src/services/llm', () => ({
  callLLMResult: (...args: unknown[]) => mockCallLLMResult(...args),
}));

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

import { finalizeChapterMemory } from '../src/services/storyMemory/storyMemoryService';

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
      assessment: { result: 'unchanged', reason: '无变化' },
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
  const { openDatabase } = require('../src/data/connection/openDatabase');
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

describe('AE-04: finalizeChapterMemory returned state vs persisted state', () => {
  it('batch1 success + batch2 failure returns the LATEST persisted state, not the entry snapshot', async () => {
    await resetDb();
    // 8 chapters → smart default interval 10 triggers due on finalize of the
    // last chapter with pendingCount 8 < 10? No: interval 10 needs 10 pending.
    // Use policy interval 3 so 8 pending chapters split into 3 batches
    // (3 + 3 + 2): batch1 success, batch2 failure.
    await seedProjectWithChapters(8);
    const chapters = await chaptersOfProject();
    const dbHandle = await require('../src/data/connection/openDatabase').openDatabase();
    await execute(
      dbHandle,
      `INSERT INTO project_story_memory_policy
        (project_id, mode, interval_chapters, pending_token_soft_limit,
         update_on_key_chapter, updated_at)
       VALUES (1, 'smart', 3, 12000, 1, 't')`,
    );
    const firstBatch = chapters.slice(0, 3);
    mockCallLLMResult
      .mockResolvedValueOnce({
        text: validBatchPatchJson(firstBatch),
        inputTokens: 10,
        outputTokens: 10,
        totalTokens: 20,
      })
      .mockRejectedValueOnce(new Error('mock LLM 故障'));

    const result = await finalizeChapterMemory(8);

    // Persisted DB row: clean with through = batch1 endpoint (position 2).
    const record = await getProjectStoryMemory(1);
    expect(record).not.toBeNull();
    expect(record!.status).toBe('clean');
    expect(record!.state.throughChapterPosition).toBe(2);
    expect(record!.lastError).toContain('mock LLM 故障');
    const persistedPatchId = record!.state.metadata.lastAppliedPatchId;

    // Returned state must match the LATEST persisted state, not the entry
    // snapshot (which would say through=-1 / status=empty).
    expect(result.state.throughChapterPosition).toBe(2);
    expect(result.state.metadata.status).toBe('clean');
    expect(result.patchId).toBe(persistedPatchId);
    expect(result.patchId.length).toBeGreaterThan(0);
    // Real remaining pending chapters after through=2: positions 3..7 = 5.
    expect(result.pendingCount).toBe(5);
    expect(result.checkpointUpdated).toBe(false);
    expect(result.chapterFinalized).toBe(true);
  });

  it('first batch failure keeps returned through at the entry position (no fabricated clean)', async () => {
    await resetDb();
    await seedProjectWithChapters(8);
    const dbHandle = await require('../src/data/connection/openDatabase').openDatabase();
    await execute(
      dbHandle,
      `INSERT INTO project_story_memory_policy
        (project_id, mode, interval_chapters, pending_token_soft_limit,
         update_on_key_chapter, updated_at)
       VALUES (1, 'smart', 3, 12000, 1, 't')`,
    );
    mockCallLLMResult.mockRejectedValueOnce(new Error('mock LLM 故障'));

    const result = await finalizeChapterMemory(8);

    const record = await getProjectStoryMemory(1);
    expect(record!.status).toBe('empty');
    expect(record!.state.throughChapterPosition).toBe(-1);
    expect(result.state.throughChapterPosition).toBe(-1);
    expect(result.patchId).toBe('');
    expect(result.pendingCount).toBe(8);
  });
});
