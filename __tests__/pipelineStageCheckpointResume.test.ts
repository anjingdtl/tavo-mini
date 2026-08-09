/* eslint-env jest */

import { execute } from '../src/data/connection/execute';
import { openDatabase, __resetForTest, __setDatabaseForTest } from '../src/data/connection/openDatabase';
import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import type { InMemorySqliteDb } from './helpers/canonInMemoryDb';
import { resetFailedStageCheckpointsForResume } from '../src/data/repositories/pipelineStageCheckpointRepository';

let testDb: InMemorySqliteDb | null = null;

async function seedTask(statuses: Record<string, string>) {
  testDb = await createCanonInMemoryDb();
  __setDatabaseForTest(testDb as any);
  const db = await openDatabase();
  const now = Date.now();
  await execute(
    db,
    `INSERT INTO pipeline_tasks (
       id, target_type, target_id, status, stage_results,
       created_at, updated_at
     ) VALUES ('resume-test', 'chapter', 1, 'failed', '[]', ?, ?)`,
    [now, now],
  );
  for (const [stage, status] of Object.entries(statuses)) {
    await execute(
      db,
      `INSERT INTO pipeline_stage_checkpoints (
         task_id, stage, status, attempt_count, updated_at
       ) VALUES ('resume-test', ?, ?, 1, ?)`,
      [stage, status, now],
    );
  }
}

afterEach(() => {
  __resetForTest();
  testDb?.close();
  testDb = null;
});

describe('V3.1 parallel audit checkpoint resume', () => {
  test('review failure preserves a successful factCheck branch', async () => {
    await seedTask({
      draft: 'succeeded',
      review: 'failed',
      factCheck: 'succeeded',
      brief: 'succeeded',
      proof: 'failed',
    });

    await resetFailedStageCheckpointsForResume('resume-test');
    const rows = await (await openDatabase()).executeSql(
      `SELECT stage, status FROM pipeline_stage_checkpoints
       WHERE task_id = 'resume-test' ORDER BY stage`,
    );
    const statusByStage = Object.fromEntries(
      (rows[0] as any).rows.raw().map((row: any) => [row.stage, row.status]),
    );

    expect(statusByStage).toEqual({
      draft: 'succeeded',
      review: 'pending',
      factCheck: 'succeeded',
      brief: 'pending',
      proof: 'pending',
    });
  });

  test('factCheck failure preserves a successful review branch', async () => {
    await seedTask({
      draft: 'succeeded',
      review: 'succeeded',
      factCheck: 'failed',
      brief: 'succeeded',
      proof: 'failed',
    });

    await resetFailedStageCheckpointsForResume('resume-test');
    const rows = await (await openDatabase()).executeSql(
      `SELECT stage, status FROM pipeline_stage_checkpoints
       WHERE task_id = 'resume-test' ORDER BY stage`,
    );
    const statusByStage = Object.fromEntries(
      (rows[0] as any).rows.raw().map((row: any) => [row.stage, row.status]),
    );

    expect(statusByStage).toEqual({
      draft: 'succeeded',
      review: 'succeeded',
      factCheck: 'pending',
      brief: 'pending',
      proof: 'pending',
    });
  });
});
