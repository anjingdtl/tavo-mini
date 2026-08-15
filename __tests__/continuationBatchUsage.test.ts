import { __resetForTest, __setDatabaseForTest } from '../src/data/connection/openDatabase';
import {
  createBatch,
  createBatchItem,
  getBatchById,
  updateBatchItem,
} from '../src/data/repositories/multiChapterBatchRepository';
import {
  computeContinuationBatchUsage,
  setBatchUsageFromContinuationRuns,
} from '../src/services/multiChapterBatch/continuationBatchUsage';
import {
  createCanonInMemoryDb,
  type InMemorySqliteDb,
} from './helpers/canonInMemoryDb';

async function insertRun(
  db: InMemorySqliteDb,
  params: { id: string; chapterId: number; position?: number },
) {
  const now = new Date().toISOString();
  await db.executeSql(
    `INSERT INTO continuation_generation_runs (
       id, project_id, chapter_id, target_position, source_snapshot_json,
       canon_revision, story_memory_fingerprint, story_memory_through_position,
       input_revision_hash, user_instruction, settings_snapshot_json,
       state, stage, created_at, updated_at
     ) VALUES (?, 1, ?, ?, '{}', 1, 'memory', -1, 'revision', 'goal', '{}', 'failed', 'awaiting_user', ?, ?)`,
    [params.id, params.chapterId, params.position ?? 0, now, now],
  );
}

async function insertStage(
  db: InMemorySqliteDb,
  params: { id: string; runId: string; input: number; output: number; calls: number },
) {
  const now = new Date().toISOString();
  await db.executeSql(
    `INSERT INTO continuation_generation_stage_results (
       id, run_id, stage, status, request_reserved, request_count,
       input_tokens, output_tokens, created_at, updated_at
     ) VALUES (?, ?, 'draft_writer', 'failed', 1, ?, ?, ?, ?, ?)`,
    [params.id, params.runId, params.calls, params.input, params.output, now, now],
  );
}

describe('continuation batch usage aggregation', () => {
  let db: InMemorySqliteDb;

  beforeEach(async () => {
    db = await createCanonInMemoryDb();
    __setDatabaseForTest(db as any);
    await db.executeSql(
      `INSERT INTO projects (id, name, mode, created_at, updated_at)
       VALUES (1, '续写预算测试', 'continuation', 0, 0)`,
    );
    await db.executeSql(
      `INSERT INTO chapters (id, project_id, position, title, synopsis, content, status, created_at, updated_at)
       VALUES (101, 1, 0, '批次章节', 's', '', 'planned', 0, 0),
              (202, 1, 1, '其他章节', 's', '', 'planned', 0, 0)`,
    );
    await createBatch({
      id: 'batch_usage',
      projectId: 1,
      sourcePrompt: 'goal',
      chapterCount: 1,
      targetWordsPerChapter: 3000,
      pipelineMode: 'full',
      writingMode: 'continuation',
      budget: { maxLlmCalls: 12 },
    });
    await createBatchItem({
      batchId: 'batch_usage',
      ordinal: 1,
      title: '批次章节',
      synopsis: 's',
      keyBeatsJson: '[]',
      targetWords: 3000,
    });
    await updateBatchItem('batch_usage', 1, { chapterId: 101 });
  });

  afterEach(() => {
    __resetForTest();
    db.close();
  });

  it('keeps failed-run spend when an explicit retry replaces the active binding', async () => {
    await insertRun(db, { id: 'ct_old_failed', chapterId: 101 });
    await insertStage(db, {
      id: 'stage_old',
      runId: 'ct_old_failed',
      calls: 1,
      input: 100,
      output: 0,
    });
    await insertRun(db, { id: 'ct_new_failed', chapterId: 101, position: 1 });
    await insertStage(db, {
      id: 'stage_new',
      runId: 'ct_new_failed',
      calls: 1,
      input: 200,
      output: 50,
    });

    const usage = await computeContinuationBatchUsage([
      { activeContinuationRunId: 'ct_new_failed', chapterId: 101 },
    ]);

    expect(usage).toEqual({ llmCalls: 2, inputTokens: 300, outputTokens: 50 });
  });

  it('writes historical usage to the batch header and excludes other chapters', async () => {
    await insertRun(db, { id: 'ct_batch', chapterId: 101 });
    await insertStage(db, {
      id: 'stage_batch',
      runId: 'ct_batch',
      calls: 1,
      input: 300,
      output: 75,
    });
    await insertRun(db, { id: 'ct_other', chapterId: 202 });
    await insertStage(db, {
      id: 'stage_other',
      runId: 'ct_other',
      calls: 1,
      input: 999,
      output: 999,
    });

    await setBatchUsageFromContinuationRuns('batch_usage', [
      { activeContinuationRunId: null, chapterId: 101 },
    ]);
    const batch = await getBatchById('batch_usage');

    expect(batch?.usedLlmCalls).toBe(1);
    expect(batch?.usedInputTokens).toBe(300);
    expect(batch?.usedOutputTokens).toBe(75);
  });
});
