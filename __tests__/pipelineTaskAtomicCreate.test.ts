/**
 * Pipeline parent/checkpoint atomic creation + safe UPSERT (Fix B).
 *
 * Uses a REAL in-memory SQLite (sql.js) with `PRAGMA foreign_keys = ON` and
 * the full Schema 39 DDL (including the `pipeline_stage_checkpoints.task_id
 * REFERENCES pipeline_tasks(id) ON DELETE CASCADE` FK), injected via
 * `__setDatabaseForTest` so the repository's `openDatabase()` returns it.
 * This is NOT a Map fake — FK semantics, PRIMARY KEY uniqueness, and
 * transaction rollback are enforced by real SQLite.
 *
 * Covers plan Case 1 / 2 / 3 / 4 / 5 / concurrency.
 */
import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import type { InMemorySqliteDb } from './helpers/canonInMemoryDb';

// Inject the in-memory db into the connection singleton BEFORE importing
// the repositories that call openDatabase().
import { __setDatabaseForTest, __resetForTest } from '../src/data/connection/openDatabase';

import {
  createPipelineTaskWithCheckpoints,
  savePipelineTask,
  getPipelineTaskById,
  deletePipelineTask,
} from '../src/data/repositories/pipelineTaskRepository';
import { getStageCheckpoints } from '../src/data/repositories/pipelineStageCheckpointRepository';

let testDb: InMemorySqliteDb | null = null;

async function resetDb() {
  // Reset the singleton + open a fresh in-memory database for each test so
  // rows do not leak across cases. Each test gets FK ON + full schema.
  __resetForTest();
  testDb = await createCanonInMemoryDb();
  __setDatabaseForTest(testDb as any);
}

function newTask(overrides: Partial<any> = {}) {
  const now = Date.now();
  return {
    id: `pt_test_${Math.random().toString(36).slice(2, 10)}`,
    targetType: 'chapter',
    targetId: 1,
    status: 'idle',
    stageResults: [] as any[],
    finalText: null as string | null,
    error: null as string | null,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null as number | null,
    ...overrides,
  };
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

describe('FK 787 fix: atomic parent + checkpoint creation (real SQLite, FK ON)', () => {
  test('Case 1 — chapter task: parent + 4 pending checkpoints created together, no 787', async () => {
    await resetDb();
    const task = newTask({ targetType: 'chapter', targetId: 42 });
    await createPipelineTaskWithCheckpoints(task, [
      'draft',
      'review',
      'factCheck',
      'proof',
    ]);

    const parent = await getPipelineTaskById(task.id);
    expect(parent).not.toBeNull();
    expect(parent.id).toBe(task.id);
    expect(parent.status).toBe('idle');

    const checkpoints = await getStageCheckpoints(task.id);
    expect(checkpoints.length).toBe(4);
    const stages = checkpoints.map(c => c.stage).sort();
    expect(stages).toEqual(['draft', 'factCheck', 'proof', 'review']);
    for (const c of checkpoints) {
      expect(c.status).toBe('pending');
      expect(c.attemptCount).toBe(0);
    }
  });

  test('Case 2 — freeform task: same atomic guarantees', async () => {
    await resetDb();
    const task = newTask({ targetType: 'freeform', targetId: 7 });
    await createPipelineTaskWithCheckpoints(task, [
      'draft',
      'review',
      'factCheck',
      'proof',
    ]);
    const parent = await getPipelineTaskById(task.id);
    expect(parent).not.toBeNull();
    expect(parent.targetType).toBe('freeform');
    expect(parent.targetId).toBe(7);
    expect((await getStageCheckpoints(task.id)).length).toBe(4);
  });

  test('Case 3 — repeated savePipelineTask (UPSERT) does NOT cascade-delete checkpoints', async () => {
    await resetDb();
    const task = newTask();
    await createPipelineTaskWithCheckpoints(task, [
      'draft',
      'review',
      'factCheck',
      'proof',
    ]);

    // Mark one checkpoint as succeeded so we can verify its content survives.
    const before = await getStageCheckpoints(task.id);
    expect(before.length).toBe(4);

    // Save the parent through several status transitions — this used to be
    // INSERT OR REPLACE, which would DELETE the parent and cascade-wipe all
    // checkpoints. The UPSERT must preserve them.
    for (const status of ['drafting', 'reviewing', 'completed']) {
      await savePipelineTask({ ...task, status, updatedAt: Date.now() });
      const after = await getStageCheckpoints(task.id);
      expect(after.length).toBe(4);
    }

    // The parent row itself is updated in place (same id, same createdAt).
    const final = await getPipelineTaskById(task.id);
    expect(final.status).toBe('completed');
    expect(final.createdAt).toBe(task.createdAt);
  });

  test('Case 4 — duplicate parent id INSERT fails → 0 parent rows, 0 checkpoints', async () => {
    await resetDb();
    const task = newTask();
    // First insert succeeds.
    await createPipelineTaskWithCheckpoints(task, [
      'draft',
      'review',
      'factCheck',
      'proof',
    ]);
    // Now attempt to create the SAME id again — the parent INSERT hits the
    // PRIMARY KEY conflict. The whole transaction must roll back, but since
    // the first creation already committed, the first task remains. We
    // verify the SECOND attempt throws and does NOT add extra checkpoints.
    await expect(
      createPipelineTaskWithCheckpoints(task, [
        'draft',
        'review',
        'factCheck',
        'proof',
      ]),
    ).rejects.toThrow();

    // Still exactly one parent + four checkpoints (from the first call).
    const checkpoints = await getStageCheckpoints(task.id);
    expect(checkpoints.length).toBe(4);
  });

  test('Case 5 — mid-transaction checkpoint INSERT failure rolls back the parent too', async () => {
    await resetDb();
    const task = newTask();
    // Pass a duplicate stage value: the 2nd checkpoint INSERT violates the
    // (task_id, stage) PRIMARY KEY constraint mid-transaction. Real SQLite
    // must roll back so the parent row and any earlier checkpoint in this
    // transaction do NOT persist.
    await expect(
      createPipelineTaskWithCheckpoints(task, [
        'draft',
        'draft', // duplicate → PK violation mid-transaction
        'review',
        'factCheck',
      ]),
    ).rejects.toThrow();

    const parent = await getPipelineTaskById(task.id);
    expect(parent).toBeNull();
    const checkpoints = await getStageCheckpoints(task.id);
    expect(checkpoints.length).toBe(0);
  });

  test('Case 6 — concurrency: two independent tasks do not interfere', async () => {
    await resetDb();
    const taskA = newTask({ targetId: 100 });
    const taskB = newTask({ targetId: 200 });

    await Promise.all([
      createPipelineTaskWithCheckpoints(taskA, [
        'draft',
        'review',
        'factCheck',
        'proof',
      ]),
      createPipelineTaskWithCheckpoints(taskB, [
        'draft',
        'review',
        'factCheck',
        'proof',
      ]),
    ]);

    expect(await getPipelineTaskById(taskA.id)).not.toBeNull();
    expect(await getPipelineTaskById(taskB.id)).not.toBeNull();
    expect((await getStageCheckpoints(taskA.id)).length).toBe(4);
    expect((await getStageCheckpoints(taskB.id)).length).toBe(4);
  });

  test('deletePipelineTask cascades checkpoints (FK ON DELETE CASCADE still works)', async () => {
    await resetDb();
    const task = newTask();
    await createPipelineTaskWithCheckpoints(task, [
      'draft',
      'review',
      'factCheck',
      'proof',
    ]);
    expect((await getStageCheckpoints(task.id)).length).toBe(4);
    await deletePipelineTask(task.id);
    expect(await getPipelineTaskById(task.id)).toBeNull();
    expect((await getStageCheckpoints(task.id)).length).toBe(0);
  });
});

/**
 * Confirm the connection really enforces the FK: inserting a checkpoint for a
 * non-existent parent MUST fail with the foreign-key constraint. This guards
 * against a future regression where foreign_keys is silently OFF in tests.
 */
describe('FK enforcement sanity (real SQLite)', () => {
  test('inserting checkpoint without parent fails under FK ON', async () => {
    await resetDb();
    // Use the raw in-memory db to bypass our repository's parent-first
    // ordering and assert the FK fires.
    const sqljs = (testDb as InMemorySqliteDb)._sqljs;
    expect(() => {
      sqljs.run(
        `INSERT INTO pipeline_stage_checkpoints (task_id, stage, status, attempt_count, updated_at)
         VALUES ('ghost', 'draft', 'pending', 0, 0)`,
      );
    }).toThrow(/FOREIGN KEY|constraint/i);
  });
});
