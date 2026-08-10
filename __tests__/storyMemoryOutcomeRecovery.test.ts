import {
  acknowledgeStoryMemoryOutcomeUnknown,
  createStoryMemoryRequestAttempt,
  getStoryMemoryRequestAttempt,
  listStoryMemoryRequestAttempts,
  markSentStoryMemoryAttemptsOutcomeUnknown,
} from '../src/data/repositories/storyMemoryRequestAttemptRepository';
import {
  __resetForTest,
  __setDatabaseForTest,
} from '../src/data/connection/openDatabase';
import { createCurrentSchema } from '../src/data/schema/createCurrentSchema';
import { execute } from '../src/data/connection/execute';
import { requestStoryMemoryMaintenance } from '../src/services/storyMemory/storyMemoryService';
import {
  createEmptyInMemoryDb,
  type InMemorySqliteDb,
} from './helpers/canonInMemoryDb';

let testDb: InMemorySqliteDb | null = null;

async function resetDb(): Promise<void> {
  __resetForTest();
  testDb = await createEmptyInMemoryDb();
  __setDatabaseForTest(testDb as any);
  await createCurrentSchema(testDb as any);
  await execute(
    testDb as any,
    `INSERT INTO projects (id, name, mode, created_at, updated_at)
     VALUES (1, '账本恢复', 'outline', 't', 't')`,
  );
}

afterEach(() => {
  __resetForTest();
  if (testDb) {
    try {
      testDb.close();
    } catch {
      // ignore cleanup
    }
    testDb = null;
  }
});

describe('Story Memory outcome_unknown recovery', () => {
  it('requires confirmation, terminalizes only one logical unknown, then resumes', async () => {
    await resetDb();
    await createStoryMemoryRequestAttempt({
      attemptId: 'unknown-old',
      logicalBatchId: 'logical-old',
      projectId: 1,
      fromPosition: 0,
      throughPosition: 2,
      requestKind: 'primary',
      attemptNo: 1,
      status: 'sent',
    });
    await createStoryMemoryRequestAttempt({
      attemptId: 'unknown-other',
      logicalBatchId: 'logical-other',
      projectId: 1,
      fromPosition: 8,
      throughPosition: 10,
      requestKind: 'primary',
      attemptNo: 1,
      status: 'outcome_unknown',
    });
    await markSentStoryMemoryAttemptsOutcomeUnknown();

    await expect(
      requestStoryMemoryMaintenance({
        projectId: 1,
        throughPosition: 2,
        reason: 'manual',
      }),
    ).rejects.toMatchObject({ code: 'MEMORY_CHECKPOINT_OUTCOME_UNKNOWN' });

    await expect(
      acknowledgeStoryMemoryOutcomeUnknown({
        projectId: 1,
        attemptIds: ['unknown-old'],
      }),
    ).resolves.toBe(1);
    expect(await getStoryMemoryRequestAttempt('unknown-old')).toEqual(
      expect.objectContaining({
        status: 'cancelled',
        failureClass: 'user_acknowledged_outcome_unknown',
        errorCode: 'USER_ACKNOWLEDGED_OUTCOME_UNKNOWN',
      }),
    );
    expect(await getStoryMemoryRequestAttempt('unknown-other')).toEqual(
      expect.objectContaining({ status: 'outcome_unknown' }),
    );

    await expect(
      requestStoryMemoryMaintenance({
        projectId: 1,
        throughPosition: 2,
        reason: 'manual',
        userAcknowledgedUnknown: true,
        acknowledgedAttemptIds: ['unknown-other'],
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        projectId: 1,
        state: expect.objectContaining({
          metadata: expect.objectContaining({ status: 'clean' }),
        }),
      }),
    );
    expect(
      await listStoryMemoryRequestAttempts(1, ['outcome_unknown']),
    ).toHaveLength(0);

    await expect(
      requestStoryMemoryMaintenance({
        projectId: 1,
        throughPosition: 2,
        reason: 'interval',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        projectId: 1,
        state: expect.objectContaining({
          metadata: expect.objectContaining({ status: 'clean' }),
        }),
      }),
    );
  });
});
