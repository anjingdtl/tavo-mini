/**
 * SQLite low-memory contract for the durable writing hot paths.
 *
 * The guard below models Android's CursorWindow failure: a wide SELECT that
 * materializes one of the large JSON/TEXT columns is rejected, while
 * metadata + bounded substr() reads remain available.
 */
import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import type { InMemorySqliteDb } from './helpers/canonInMemoryDb';
import {
  __resetForTest,
  __setDatabaseForTest,
  openDatabase,
} from '../src/data/connection/openDatabase';
import {
  getRunById,
  getLatestArtifactForStage,
  getStageResult,
  enqueueOutbox,
  getOutboxByDedupe,
  listPendingOutbox,
} from '../src/services/continuation/generation/generationRepository';
import {
  createBatch,
  createBatchItem,
  createItemRun,
  getBatchById,
  getBatchItems,
  getItemRuns,
} from '../src/data/repositories/multiChapterBatchRepository';
import { getTaskAttempts } from '../src/data/repositories/pipelineStageAttemptRepository';
import { createPipelineTaskWithCheckpoints } from '../src/data/repositories/pipelineTaskRepository';
import { createStageAttempt } from '../src/data/repositories/pipelineStageAttemptRepository';
import { sha256Hex } from '../src/services/continuation/hashUtils';

const PROJECT_ID = 9811;
const CHAPTER_ID = 9812;
const RUN_ID = 'ct_large_payload_projection';
const TASK_ID = 'task_large_payload_projection';
const BATCH_ID = 'batch_large_payload_projection';
const OUTBOX_DEDUPE_KEY = 'large-payload-projection-outbox';
const now = new Date().toISOString();
const LARGE_TEXT = '大字段'.repeat(380_000);

async function sql(sqlText: string, params: any[] = []): Promise<any> {
  const db = await openDatabase();
  const [res] = await db.executeSql(sqlText, params);
  return res;
}

function installCursorWindowGuard(db: InMemorySqliteDb): InMemorySqliteDb {
  const widePayloadRead = (sqlText: string): boolean => {
    const normalized = sqlText.replace(/\s+/g, ' ').trim();
    if (/SELECT \* FROM (continuation_generation_artifacts|continuation_generation_stage_results|pipeline_stage_attempts|multi_chapter_batches|multi_chapter_batch_items|multi_chapter_batch_item_runs|continuation_state_proposals|continuation_state_events|continuation_state_sync_outbox)/i.test(normalized)) {
      return true;
    }
    if (/\b(source_snapshot_json|context_trace_json)\b/i.test(normalized)) {
      return !/\b(NULL AS|length\(|substr\(|json_extract\()/i.test(normalized);
    }
    return false;
  };
  return {
    ...db,
    executeSql(sqlText, params = []) {
      if (widePayloadRead(sqlText)) {
        return Promise.reject(
          new Error('SQLiteBlobTooBigException: CursorWindow payload exceeded'),
        );
      }
      return db.executeSql(sqlText, params);
    },
  } as InMemorySqliteDb;
}

describe('SQLite large-payload projection and on-demand loading', () => {
  let db: InMemorySqliteDb;

  beforeAll(async () => {
    db = await createCanonInMemoryDb();
    __setDatabaseForTest(db as any);
    await sql(
      `INSERT INTO projects (id, name, mode, created_at, updated_at)
       VALUES (?, 'large-payload', 'continuation', ?, ?)`,
      [PROJECT_ID, now, now],
    );
    await sql(
      `INSERT INTO chapters (id, project_id, position, title, content, status, created_at, updated_at)
       VALUES (?, ?, 9, '大字段章节', '', 'draft', ?, ?)`,
      [CHAPTER_ID, PROJECT_ID, now, now],
    );
    await sql(
      `INSERT INTO continuation_generation_runs (
         id, project_id, chapter_id, target_position, source_snapshot_json,
         canon_revision, story_memory_fingerprint, story_memory_through_position,
         input_revision_hash, user_instruction, settings_snapshot_json,
         context_snapshot_json, context_trace_json, token_usage_json,
         state, stage, created_at, updated_at
       ) VALUES (?, ?, ?, 9, ?, 1, '', -1, '', '', '{}', ?, ?, '{}',
         'awaiting_user', 'awaiting_user', ?, ?)`,
      [
        RUN_ID,
        PROJECT_ID,
        CHAPTER_ID,
        LARGE_TEXT,
        JSON.stringify({ workflowVersion: 5, padding: LARGE_TEXT }),
        LARGE_TEXT,
        now,
        now,
      ],
    );
    await sql(
      `INSERT INTO continuation_generation_artifacts (
         id, run_id, stage, repair_round, content, content_hash,
         eligibility_status, created_at
       ) VALUES ('ca_large_payload', ?, 'draft', 0, ?, ?, 'intermediate', ?)`,
      [RUN_ID, LARGE_TEXT, sha256Hex(LARGE_TEXT), now],
    );
    await sql(
      `INSERT INTO continuation_generation_stage_results (
         id, run_id, stage, status, request_reserved, request_count,
         input_tokens, output_tokens, output_json, created_at, updated_at
       ) VALUES ('csr_large_payload', ?, 'draft_writer', 'success', 1, 1,
         12, 34, ?, ?, ?)`,
      [
        RUN_ID,
        JSON.stringify({ envelope: { content: LARGE_TEXT } }),
        now,
        now,
      ],
    );
    await createPipelineTaskWithCheckpoints(
      {
        id: TASK_ID,
        targetType: 'chapter',
        targetId: CHAPTER_ID,
        status: 'running',
        stageResults: [],
        finalText: null,
        error: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        resolvedAt: null,
      } as any,
      ['draft'],
    );
    await createStageAttempt({
      id: 'att_large_payload',
      pipelineTaskId: TASK_ID,
      stage: 'draft',
      attemptNo: 1,
      requestFingerprint: 'large-payload-fp',
      frozenRequestJson: LARGE_TEXT,
      llmConfigSnapshotJson: '{}',
      clientRequestId: 'large-payload-client',
    });
    await createBatch({
      id: BATCH_ID,
      projectId: PROJECT_ID,
      sourcePrompt: LARGE_TEXT,
      chapterCount: 1,
      targetWordsPerChapter: 3000,
      pipelineMode: 'full',
    });
    await createBatchItem({
      batchId: BATCH_ID,
      ordinal: 1,
      title: '大字段批次条目',
      synopsis: LARGE_TEXT,
      keyBeatsJson: LARGE_TEXT,
      carryIn: LARGE_TEXT,
      carryOut: LARGE_TEXT,
      targetWords: 3000,
    });
    await createItemRun({
      batchId: BATCH_ID,
      ordinal: 1,
      runNo: 1,
      pipelineTaskId: TASK_ID,
      llmConfigSnapshotJson: LARGE_TEXT,
      reason: 'large payload projection',
    });
    await enqueueOutbox({
      projectId: PROJECT_ID,
      chapterId: CHAPTER_ID,
      operation: 'extract_state',
      payload: { padding: LARGE_TEXT },
      dedupeKey: OUTBOX_DEDUPE_KEY,
    });

    // Install only after seeding so the test exercises real SQLite rows and
    // the guard covers every repository read under test.
    __setDatabaseForTest(installCursorWindowGuard(db) as any);
  });

  afterAll(() => {
    __resetForTest();
    db?.close();
  });

  test('metadata and large body readers survive a CursorWindow-sized payload', async () => {
    const run = await getRunById(RUN_ID);
    expect(run).toMatchObject({
      id: RUN_ID,
      workflowVersion: 5,
      contextSnapshotJson: null,
    });

    await expect(getLatestArtifactForStage(RUN_ID, 'draft')).resolves.toMatchObject({
      content: LARGE_TEXT,
    });
    await expect(getStageResult(RUN_ID, 'draft_writer')).resolves.toMatchObject({
      outputJson: JSON.stringify({ envelope: { content: LARGE_TEXT } }),
    });
    await expect(getTaskAttempts(TASK_ID)).resolves.toEqual([
      expect.objectContaining({
        id: 'att_large_payload',
        frozenRequestJson: LARGE_TEXT,
      }),
    ]);
  });

  test('batch and state-sync hot paths project large payloads before loading them', async () => {
    await expect(getBatchById(BATCH_ID)).resolves.toMatchObject({
      id: BATCH_ID,
      sourcePrompt: LARGE_TEXT,
    });
    await expect(getBatchItems(BATCH_ID)).resolves.toEqual([
      expect.objectContaining({
        synopsis: LARGE_TEXT,
        keyBeatsJson: LARGE_TEXT,
        carryIn: LARGE_TEXT,
        carryOut: LARGE_TEXT,
      }),
    ]);
    await expect(getItemRuns(BATCH_ID, 1)).resolves.toEqual([
      expect.objectContaining({ llmConfigSnapshotJson: LARGE_TEXT }),
    ]);
    await expect(getOutboxByDedupe(OUTBOX_DEDUPE_KEY)).resolves.toEqual(
      expect.objectContaining({
        payloadJson: JSON.stringify({ padding: LARGE_TEXT }),
      }),
    );
    await expect(listPendingOutbox()).resolves.toEqual([
      expect.objectContaining({
        dedupeKey: OUTBOX_DEDUPE_KEY,
        payloadJson: JSON.stringify({ padding: LARGE_TEXT }),
      }),
    ]);
  });
});
