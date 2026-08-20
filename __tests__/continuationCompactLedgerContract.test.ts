/**
 * Phase 6 §6.2 — Continuation Compact Standard ledger must not emit legacy
 * fake rows.
 *
 * For the compact production path the continuation_generation_stage_results
 * ledger must contain ONLY { draft_writer, revision_writer, unified_qa,
 * final_validate } and must NOT pre-create { narrative_architect,
 * adversarial_auditor, final_reviser } as queued/0 rows that are never
 * dispatched. Legacy resume keeps the full V5 ledger.
 */
import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import type { InMemorySqliteDb } from './helpers/canonInMemoryDb';
import {
  __setDatabaseForTest,
  __resetForTest,
  openDatabase,
} from '../src/data/connection/openDatabase';
import { execute } from '../src/data/connection/execute';
import type { ContinuationV5PhysicalNode } from '../src/services/continuation/generation/types';
import {
  ensureContinuationV5StageResults,
  insertRun,
  listStageResults,
} from '../src/services/continuation/generation/generationRepository';

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
      /* ignore */
    }
    testDb = null;
  }
});

async function seedProjectChapterAndRun(runId: string) {
  await execute(
    await openDatabase(),
    `INSERT INTO projects (id, name, mode, created_at, updated_at)
     VALUES (1, 'p', 'continuation', 't', 't')`,
  );
  await execute(
    await openDatabase(),
    `INSERT INTO chapters (id, project_id, position, title, synopsis, content, status, created_at, updated_at)
     VALUES (2, 1, 2, '第3章', '续写', '', 'draft', 't', 't')`,
  );
  await execute(
    await openDatabase(),
    `INSERT INTO llm_config
       (id, name, base_url, api_key, model_name, is_active, provider_type,
        context_window, max_output_tokens)
     VALUES (7, 'm', 'http://127.0.0.1:9/v1', 'k', 'mm', 1,
             'openai_compatible', 8000, 4000)`,
  );
  return insertRun({
    id: runId,
    projectId: 1,
    chapterId: 2,
    targetPosition: 3 as any,
    sourceId: null,
    sourceSnapshotJson: '{}',
    canonSnapshotId: null,
    canonRevision: 1,
    storyMemoryFingerprint: 'fp',
    storyMemoryThroughPosition: 2,
    inputRevisionHash: 'hash',
    userInstruction: '续写本章',
    settingsSnapshotJson: '{}',
    contextSnapshotJson: null,
    contextTraceJson: null,
    tokenUsageJson: '{}',
    state: 'running',
    stage: 'round1',
    completionReason: null,
    adoptedRevisionHash: null,
    finalizedRevisionHash: null,
    errorCode: null,
    errorMessage: null,
  });
}

function stageBudgets(): Record<
  ContinuationV5PhysicalNode,
  {
    configId: number;
    compiledPromptTokens: number;
    minimumOutputTokens: number;
    maximumOutputTokens: number;
  }
> {
  const budget = {
    configId: 7,
    compiledPromptTokens: 100,
    minimumOutputTokens: 64,
    maximumOutputTokens: 1024,
  };
  return {
    draft_writer: budget,
    narrative_architect: budget,
    revision_writer: budget,
    adversarial_auditor: budget,
    unified_qa: budget,
    final_reviser: budget,
  };
}

describe('Phase 6 §6.2 — Compact continuation ledger has no legacy fake rows', () => {
  test('compactOnly ledger contains only draft_writer/revision_writer/unified_qa/final_validate', async () => {
    await resetDb();
    const run = await seedProjectChapterAndRun('ct_compact_c1');
    await ensureContinuationV5StageResults({
      runId: run.id,
      compactOnly: true,
      stages: stageBudgets(),
    });
    const stages = (await listStageResults(run.id)).map(r => r.stage).sort();
    expect(stages).toEqual(
      ['draft_writer', 'final_validate', 'revision_writer', 'unified_qa'].sort(),
    );
    expect(stages).not.toContain('narrative_architect');
    expect(stages).not.toContain('adversarial_auditor');
    expect(stages).not.toContain('final_reviser');
  });

  test('legacy ledger keeps the historical full V5 node set', async () => {
    await resetDb();
    const run = await seedProjectChapterAndRun('ct_legacy_l1');
    await ensureContinuationV5StageResults({
      runId: run.id,
      compactOnly: false,
      stages: stageBudgets(),
    });
    const stages = (await listStageResults(run.id)).map(r => r.stage).sort();
    expect(stages).toEqual(
      [
        'draft_writer',
        'narrative_architect',
        'revision_writer',
        'adversarial_auditor',
        'unified_qa',
        'final_reviser',
        'final_validate',
      ].sort(),
    );
  });
});