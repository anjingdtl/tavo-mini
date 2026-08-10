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
import {
  createStoryMemoryRequestAttempt,
  getStoryMemoryRequestAttempt,
  markSentStoryMemoryAttemptsOutcomeUnknown,
} from '../src/data/repositories/storyMemoryRequestAttemptRepository';
import { requestStoryMemoryMaintenance } from '../src/services/storyMemory/storyMemoryService';

let testDb: InMemorySqliteDb | null = null;

async function resetDb(): Promise<void> {
  __resetForTest();
  testDb = await createEmptyInMemoryDb();
  __setDatabaseForTest(testDb as any);
  await createCurrentSchema(testDb as any);
  await execute(
    testDb as any,
    `INSERT INTO projects (id, name, mode, created_at, updated_at)
     VALUES (1, '账本测试', 'outline', 't', 't')`,
  );
}

afterEach(() => {
  __resetForTest();
  if (testDb) {
    try {
      testDb.close();
    } catch {
      // ignore test cleanup errors
    }
    testDb = null;
  }
});
test('cold-start recovery marks sent requests unknown and blocks silent replay', async () => {
  await resetDb();
  await createStoryMemoryRequestAttempt({
    attemptId: 'story-memory:ledger:1',
    logicalBatchId: 'story-memory:ledger',
    projectId: 1,
    fromPosition: 0,
    throughPosition: 2,
    requestKind: 'primary',
    attemptNo: 1,
    status: 'sent',
  });

  const affected = await markSentStoryMemoryAttemptsOutcomeUnknown();
  expect(affected).toBe(1);
  await expect(getStoryMemoryRequestAttempt('story-memory:ledger:1')).resolves.toEqual(
    expect.objectContaining({
      status: 'outcome_unknown',
      errorCode: 'COLD_START_SENT_WITHOUT_RESULT',
    }),
  );

  await expect(
    requestStoryMemoryMaintenance({
      projectId: 1,
      throughPosition: 2,
      reason: 'interval',
    }),
  ).rejects.toMatchObject({ code: 'MEMORY_CHECKPOINT_OUTCOME_UNKNOWN' });
});
