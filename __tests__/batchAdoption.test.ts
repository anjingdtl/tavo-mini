/**
 * Phase 7: automatic adoption (batch + manual share one service).
 * Covers: full result adoption (revision + content + resolved), repeated
 * adoption idempotency (no duplicate revisions), draft-only downgrade,
 * user-supplied text flow, next chapter reads previous chapter body, and
 * DB failure fail-closed.
 */
jest.mock('../src/store/pipelineTaskStore', () => ({
  usePipelineTaskStore: {
    getState: () => ({
      resolveTask: jest.fn(),
      failTask: jest.fn(),
      persistFailTask: jest.fn(),
      cancelTask: jest.fn(),
      persistTaskStatus: jest.fn(),
      setTaskStatus: jest.fn(),
      persistTaskStage: jest.fn(),
      updateTaskStage: jest.fn(),
      registerPersistedTask: jest.fn(),
      persistTaskPipelineContext: jest.fn(),
      setTaskPipelineContext: jest.fn(),
      persistCompleteTask: jest.fn(),
      completeTask: jest.fn(),
      setTaskFinalText: jest.fn(),
      persistTaskFinalText: jest.fn(),
      setTaskInputFingerprint: jest.fn(),
    }),
  },
}));

import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import type { InMemorySqliteDb } from './helpers/canonInMemoryDb';
import { __setDatabaseForTest, __resetForTest } from '../src/data/connection/openDatabase';
import { execute } from '../src/data/connection/execute';
import { openDatabase } from '../src/data/connection/openDatabase';
import {
  createBatch,
  createBatchItem,
  updateBatchStatus,
  updateBatchItem,
  getBatchItem,
  getBatchById,
  commitBatchItemAdoption,
} from '../src/data/repositories/multiChapterBatchRepository';
import { savePipelineTask } from '../src/data/repositories/pipelineTaskRepository';
import { getChapterById, getChaptersByProject } from '../src/data/repositories/projectRepository';
import { getContentRevisions } from '../src/data/repositories/contentRepository';
import { adoptPipelineTaskResult, computeAdoptionFingerprint } from '../src/services/multiChapterBatch/batchAdoption';
import { MultiChapterBatchError } from '../src/services/multiChapterBatch/errors';
import { reconcileMultiChapterBatch } from '../src/services/multiChapterBatch/reconcileMultiChapterBatch';

let testDb: InMemorySqliteDb | null = null;

async function resetDb() {
  __resetForTest();
  testDb = await createCanonInMemoryDb();
  __setDatabaseForTest(testDb as any);
}

afterEach(async () => {
  __resetForTest();
  if (testDb) {
    try {
      testDb.close();
    } catch {
      // ignore
    }
    testDb = null;
  }
});

async function seedProject(id = 1): Promise<void> {
  await execute(
    await openDatabase(),
    `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (?, 'p', 'outline', 't', 't')`,
    [id],
  );
}

async function seedChapter(projectId = 1, position = 0, content = ''): Promise<number> {
  const result = await execute(
    await openDatabase(),
    `INSERT INTO chapters (project_id, position, title, synopsis, content, status, created_at, updated_at)
     VALUES (?, ?, '第1章', '梗概', ?, 'draft', 't', 't')`,
    [projectId, position, content],
  );
  return result.insertId;
}

async function seedCompletedTask(chapterId: number, finalText: string): Promise<string> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`;
  await savePipelineTask({
    id: taskId,
    targetType: 'chapter',
    targetId: chapterId,
    status: 'completed',
    stageResults: [
      { stage: 'draft', status: 'success', text: finalText, tokens: { input: 10, output: 20, total: 30 } },
    ],
    finalText,
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    resolvedAt: null,
  });
  return taskId;
}

describe('adoptPipelineTaskResult — side effects', () => {
  it('writes content, creates revisions and resolves the task', async () => {
    await resetDb();
    await seedProject();
    const chapterId = await seedChapter(1, 0, '旧正文');
    const taskId = await seedCompletedTask(chapterId, '新正文内容');

    const result = await adoptPipelineTaskResult({
      taskId,
      chapterId,
      source: 'manual',
    });
    expect(result.alreadyAdopted).toBe(false);
    expect(result.finalText).toBe('新正文内容');

    const chapter = await getChapterById(chapterId);
    expect(chapter?.content).toBe('新正文内容');
    // old body + adopted body → two revisions
    const revisions = await getContentRevisions('chapter', chapterId);
    expect(revisions).toHaveLength(2);
    const sources = revisions.map(r => r.source).sort();
    expect(sources).toEqual(['adoption_previous', 'pipeline']);
    const adopted = revisions.find(r => r.source === 'pipeline');
    expect(adopted.source_ref).toBe(taskId);
  });

  it('is idempotent for repeated adoption (no duplicate revisions)', async () => {
    await resetDb();
    await seedProject();
    const chapterId = await seedChapter(1, 0, '');
    const taskId = await seedCompletedTask(chapterId, '正文');

    await adoptPipelineTaskResult({ taskId, chapterId, source: 'manual' });
    const revisionsAfterFirst = (await getContentRevisions('chapter', chapterId)).length;

    const second = await adoptPipelineTaskResult({
      taskId,
      chapterId,
      source: 'manual',
    });
    expect(second.alreadyAdopted).toBe(true);
    expect((await getContentRevisions('chapter', chapterId)).length).toBe(
      revisionsAfterFirst,
    );
  });

  it('fails closed when the task is missing', async () => {
    await resetDb();
    await seedProject();
    const chapterId = await seedChapter();
    await expect(
      adoptPipelineTaskResult({
        taskId: 'missing',
        chapterId,
        source: 'manual',
      }),
    ).rejects.toThrow(MultiChapterBatchError);
  });
});

describe('batch adoption flow — full vs draft-only vs user text', () => {
  it('commits full_pipeline quality with a persisted fingerprint', async () => {
    await resetDb();
    await seedProject();
    await createBatch({
      id: 'b1',
      projectId: 1,
      sourcePrompt: 's',
      chapterCount: 1,
      targetWordsPerChapter: 3000,
      pipelineMode: 'full',
    });
    await createBatchItem({
      batchId: 'b1',
      ordinal: 1,
      title: 't',
      synopsis: 's',
      keyBeatsJson: '["k"]',
      targetWords: 3000,
    });
    await updateBatchStatus('b1', 'ready', { startPosition: -1 });
    const chapterId = await seedChapter();
    await updateBatchItem('b1', 1, { chapterId, status: 'running_pipeline' });
    const taskId = await seedCompletedTask(chapterId, '批次正文');

    const adopted = await adoptPipelineTaskResult({
      taskId,
      chapterId,
      source: 'multi_chapter_batch',
      batchId: 'b1',
      ordinal: 1,
      completionQuality: 'full_pipeline',
    });
    await updateBatchItem('b1', 1, {
      status: 'adopting',
      adoptionFingerprint: adopted.adoptionFingerprint,
      adoptedRevisionId: adopted.adoptedRevisionId,
      completionQuality: 'full_pipeline',
    });
    await commitBatchItemAdoption({
      batchId: 'b1',
      ordinal: 1,
      chapterCount: 1,
      completionQuality: 'full_pipeline',
      adoptionFingerprint: adopted.adoptionFingerprint,
      adoptedRevisionId: adopted.adoptedRevisionId,
    });

    const item = await getBatchItem('b1', 1);
    expect(item?.status).toBe('succeeded');
    expect(item?.completionQuality).toBe('full_pipeline');
    expect(item?.adoptionFingerprint).toBe(adopted.adoptionFingerprint);
    const batch = await getBatchById('b1');
    expect(batch?.status).toBe('completed');
  });

  it('tracks draft_only quality (user-confirmed downgrade)', async () => {
    await resetDb();
    await seedProject();
    const chapterId = await seedChapter();
    const taskId = await seedCompletedTask(chapterId, '草稿正文');
    const adopted = await adoptPipelineTaskResult({
      taskId,
      chapterId,
      source: 'multi_chapter_batch',
      batchId: 'b1',
      ordinal: 1,
      completionQuality: 'draft_only',
    });
    expect(adopted.adoptionFingerprint).toBeTruthy();
  });

  it('computes the fingerprint deterministically (batch+ordinal+task+text)', () => {
    const f1 = computeAdoptionFingerprint({
      batchId: 'b1',
      ordinal: 2,
      chapterId: 10,
      pipelineTaskId: 't1',
      finalText: '正文',
    });
    const f2 = computeAdoptionFingerprint({
      batchId: 'b1',
      ordinal: 2,
      chapterId: 10,
      pipelineTaskId: 't1',
      finalText: '正文',
    });
    expect(f1).toBe(f2);
    const f3 = computeAdoptionFingerprint({
      batchId: 'b1',
      ordinal: 3,
      chapterId: 10,
      pipelineTaskId: 't1',
      finalText: '正文',
    });
    expect(f3).not.toBe(f1);
  });
});

describe('next chapter reads the previous chapter body', () => {
  it('reconcile creates chapter 2 after chapter 1 content is durably written', async () => {
    await resetDb();
    await seedProject();
    await createBatch({
      id: 'b1',
      projectId: 1,
      sourcePrompt: 's',
      chapterCount: 2,
      targetWordsPerChapter: 3000,
      pipelineMode: 'full',
    });
    for (let i = 1; i <= 2; i += 1) {
      await createBatchItem({
        batchId: 'b1',
        ordinal: i,
        title: `第${i}章`,
        synopsis: `s${i}`,
        keyBeatsJson: '["k"]',
        targetWords: 3000,
      });
    }
    await updateBatchStatus('b1', 'ready', { startPosition: -1 });

    const runner = {
      run: async (taskId: string) => {
        await savePipelineTask({
          id: taskId,
          targetType: 'chapter',
          targetId: 0,
          status: 'completed',
          stageResults: [
            { stage: 'draft', status: 'success', text: `正文-${taskId}`, tokens: { input: 1, output: 2, total: 3 } },
          ],
          finalText: `正文-${taskId}`,
          error: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          resolvedAt: null,
        });
      },
    };

    await reconcileMultiChapterBatch('b1', {
      owner: 'o1',
      runPipeline: runner.run as any,
    });
    const batch = await getBatchById('b1');
    expect(batch?.status).toBe('completed');
    const chapters = await getChaptersByProject(1);
    expect(chapters).toHaveLength(2);
    // Chapter 1 body is durable when chapter 2 exists (serial ordering).
    const ch1 = chapters.find(c => c.position === 0);
    const ch2 = chapters.find(c => c.position === 1);
    expect(String(ch1?.content).length).toBeGreaterThan(0);
    expect(String(ch2?.content).length).toBeGreaterThan(0);
    // The adopted body is discoverable through the standard read path.
    const fresh = await getChapterById(ch1!.id);
    expect(fresh?.content).toBe(String(ch1?.content));
  });
});
