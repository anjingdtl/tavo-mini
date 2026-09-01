import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import {
  __resetForTest,
  __setDatabaseForTest,
} from '../src/data/connection/openDatabase';
import {
  getCurrentEligibleArtifact,
  getLatestEligibleArtifact,
  insertArtifact,
  insertFinalArtifactAndActivate,
  setCurrentFinalArtifact,
} from '../src/services/continuation/generation/generationRepository';
import { migrateV60ToV61 } from '../src/services/migrations/v60-to-v61';
import {
  buildStandaloneWritingRequestReceipt,
  completeWritingRequestReceipt,
} from '../src/services/writing/contracts/writingRequestReceipt';
import {
  markOpenWritingRequestReceiptsOutcomeUnknownOnStartup,
  upsertWritingRequestReceipt,
} from '../src/data/repositories/writingRequestReceiptRepository';

async function seedRun(db: any, runId = 'ct_iv13u_current'): Promise<void> {
  await db.executeSql(
    `INSERT INTO projects (id, name, mode, created_at, updated_at)
     VALUES (1, 'Phase IV-13U', 'continuation', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
  );
  await db.executeSql(
    `INSERT INTO chapters (
      id, project_id, position, title, synopsis, content, status,
      created_at, updated_at
    ) VALUES (1, 1, 1, '第一章', '', '', 'draft',
      '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
  );
  await db.executeSql(
    `INSERT INTO continuation_generation_runs (
      id, project_id, chapter_id, target_position, source_snapshot_json,
      canon_revision, story_memory_fingerprint, story_memory_through_position,
      input_revision_hash, user_instruction, settings_snapshot_json,
      context_snapshot_json, state, stage, created_at, updated_at
    ) VALUES (?, 1, 1, 1, '{}', 1, 'memory', 0, 'input', '续写', '{}',
      '{}', 'awaiting_user', 'awaiting_user',
      '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
    [runId],
  );
}

describe('IV-13U durable uniqueness boundaries', () => {
  let db: any;

  beforeEach(async () => {
    db = await createCanonInMemoryDb();
    __setDatabaseForTest(db);
  });

  afterEach(() => {
    __resetForTest();
    db?.close();
  });

  it('keeps immutable Final history while Current Final Authority is one CAS pointer', async () => {
    await seedRun(db);
    const runId = 'ct_iv13u_current';
    const first = await insertArtifact({
      runId,
      stage: 'final',
      content: '正文 A。',
      requireStageMatch: true,
    });
    await setCurrentFinalArtifact({
      runId,
      artifactId: first.id,
      expectedCurrentArtifactId: null,
    });

    const second = await insertArtifact({
      runId,
      stage: 'final',
      content: '正文 B。',
      requireStageMatch: true,
    });
    expect((await getLatestEligibleArtifact(runId))?.id).toBe(second.id);
    expect((await getCurrentEligibleArtifact(runId))?.id).toBe(first.id);

    const third = await insertFinalArtifactAndActivate({
      runId,
      content: '正文 C。',
      parentArtifactId: second.id,
      expectedCurrentArtifactId: first.id,
    });
    expect((await getCurrentEligibleArtifact(runId))?.id).toBe(third.id);

    const [history] = await db.executeSql(
      `SELECT COUNT(*) AS count
         FROM continuation_generation_artifacts
        WHERE run_id = ? AND stage = 'final'`,
      [runId],
    );
    const [authority] = await db.executeSql(
      `SELECT COUNT(*) AS count
         FROM continuation_current_final_authorities
        WHERE run_id = ?`,
      [runId],
    );
    expect(Number(history.rows.item(0).count)).toBe(3);
    expect(Number(authority.rows.item(0).count)).toBe(1);

    await expect(
      insertFinalArtifactAndActivate({
        runId,
        content: '正文 D。',
        parentArtifactId: third.id,
        expectedCurrentArtifactId: first.id,
      }),
    ).rejects.toThrow('Current Final Authority 已变化');
    const [afterCasFailure] = await db.executeSql(
      `SELECT COUNT(*) AS count
         FROM continuation_generation_artifacts
        WHERE run_id = ? AND stage = 'final'`,
      [runId],
    );
    expect(Number(afterCasFailure.rows.item(0).count)).toBe(3);
  });

  it('persists one common receipt and reconciles a crossed boundary without retry', async () => {
    await seedRun(db, 'ct_iv13u_receipt');
    const receipt = buildStandaloneWritingRequestReceipt({
      requestId: 'req_iv13u_receipt',
      generationTraceId: 'trace_iv13u',
      writingRunId: 'ct_iv13u_receipt',
      scenario: 'outline',
      stage: 'user_revision_whole_chapter',
      provider: 'openai_compatible',
      llmConfigId: null,
      model: 'model-a',
      messages: [{ role: 'user', content: '不会持久化的请求内容' }],
      responseFormat: 'text',
      thinking: { type: 'enabled' },
    });
    const crossed = completeWritingRequestReceipt(receipt, {
      outcome: 'started',
      requestMayHaveExecuted: true,
      physicalRequestCount: 1,
    });
    await upsertWritingRequestReceipt({
      receipt: crossed,
      projectId: 1,
      actionId: 'ur_iv13u_receipt',
      previewId: 'ur_iv13u_receipt',
      candidateKind: 'chapter',
      candidateId: '1',
      candidateProjectId: 1,
      candidateChapterId: 1,
      actionKind: 'whole_chapter_rewrite',
      instructionFingerprint: 'instruction-hash',
      baseBodyFingerprint: 'base-hash',
      previewState: 'pending',
    });

    const [stored] = await db.executeSql(
      'SELECT receipt_json FROM writing_request_receipts WHERE request_id = ?',
      ['req_iv13u_receipt'],
    );
    const storedJson = String(stored.rows.item(0).receipt_json);
    expect(storedJson).not.toContain('不会持久化的请求内容');
    expect(JSON.parse(storedJson).requestId).toBe('req_iv13u_receipt');

    expect(await markOpenWritingRequestReceiptsOutcomeUnknownOnStartup(db)).toBe(1);
    const [settled] = await db.executeSql(
      'SELECT receipt_json FROM writing_request_receipts WHERE request_id = ?',
      ['req_iv13u_receipt'],
    );
    expect(JSON.parse(settled.rows.item(0).receipt_json)).toMatchObject({
      outcome: 'outcome_unknown',
      physicalRequestCount: 1,
      requestMayHaveExecuted: true,
    });
    expect(await markOpenWritingRequestReceiptsOutcomeUnknownOnStartup(db)).toBe(0);
    const [count] = await db.executeSql(
      'SELECT COUNT(*) AS count FROM writing_request_receipts',
    );
    expect(Number(count.rows.item(0).count)).toBe(1);
  });

  it('backfills one current pointer from legacy eligible history without deleting history', async () => {
    await seedRun(db, 'ct_iv13u_migration');
    const runId = 'ct_iv13u_migration';
    const first = await insertArtifact({
      runId,
      stage: 'final',
      content: '旧 Final A。',
      requireStageMatch: true,
    });
    const second = await insertArtifact({
      runId,
      stage: 'final',
      content: '旧 Final B。',
      requireStageMatch: true,
    });
    // Make the migration's timestamp tie-break deterministic in this test;
    // insertArtifact normally uses the current clock and both calls can land
    // in the same millisecond.
    await db.executeSql(
      'UPDATE continuation_generation_artifacts SET created_at = ? WHERE id = ?',
      ['2026-09-01T00:00:01.000Z', first.id],
    );
    await db.executeSql(
      'UPDATE continuation_generation_artifacts SET created_at = ? WHERE id = ?',
      ['2026-09-01T00:00:02.000Z', second.id],
    );
    await db.executeSql('DROP TABLE continuation_current_final_authorities');
    await db.executeSql('DROP TABLE writing_request_receipts');

    await migrateV60ToV61(db);
    await migrateV60ToV61(db);

    const current = await getCurrentEligibleArtifact(runId);
    expect(current?.content).toBe('旧 Final B。');
    const [history] = await db.executeSql(
      `SELECT COUNT(*) AS count
         FROM continuation_generation_artifacts
        WHERE run_id = ? AND stage = 'final'`,
      [runId],
    );
    expect(Number(history.rows.item(0).count)).toBe(2);
  });
});
