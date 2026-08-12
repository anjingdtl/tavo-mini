import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import type { InMemorySqliteDb } from './helpers/canonInMemoryDb';
import { __resetForTest, __setDatabaseForTest } from '../src/data/connection/openDatabase';
import {
  getPipelineTaskForDerivedFinalRewrite,
  getPipelineTaskResumePayload,
  savePipelineTask,
} from '../src/data/repositories/pipelineTaskRepository';

let testDb: InMemorySqliteDb | null = null;

beforeEach(async () => {
  __resetForTest();
  testDb = await createCanonInMemoryDb();
  __setDatabaseForTest(testDb as any);
});

afterEach(() => {
  __resetForTest();
  testDb?.close();
  testDb = null;
});

describe('high-payload pipeline reads', () => {
  test('derived-final metadata projection never loads task blobs', async () => {
    await savePipelineTask({
      id: 'large-parent',
      targetType: 'chapter',
      targetId: 1,
      status: 'completed',
      stageResults: [{ stage: 'proof', text: 'x'.repeat(500_000) }],
      finalText: '终稿'.repeat(100_000),
      error: null,
      pipelineContextJson: JSON.stringify({ draftContext: 'x'.repeat(500_000) }),
      pipelineContextVersion: 4,
      pipelineContextHash: 'hash',
      outlineWorkflowVersion: 4,
      contextBudgetVersion: 6,
      parentTaskId: null,
      derivedKind: null,
      derivedInstruction: null,
      createdAt: 1,
      updatedAt: 2,
      resolvedAt: null,
    });

    const metadata = await getPipelineTaskForDerivedFinalRewrite('large-parent');
    expect(metadata).toMatchObject({
      id: 'large-parent',
      targetType: 'chapter',
      targetId: 1,
      status: 'completed',
      contextBudgetVersion: 6,
      pipelineContextVersion: 4,
      pipelineContextHash: 'hash',
    });
    expect(metadata).not.toHaveProperty('stageResults');
    expect(metadata).not.toHaveProperty('finalText');
    expect(metadata).not.toHaveProperty('pipelineContextJson');

    const resume = await getPipelineTaskResumePayload('large-parent');
    expect(resume?.finalText).toHaveLength('终稿'.repeat(100_000).length);
    expect(resume?.pipelineContextJson).toContain('draftContext');
  });
});
