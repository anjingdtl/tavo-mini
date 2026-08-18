/**
 * ONE-Flow Closure — legacy pending proposal replay (closure plan P0-2).
 *
 * Real SQLite (sql.js in-memory) drives the production replay path
 * `replayPendingContinuityProposals` → ONE Memory classifier →
 * `commitAcceptedProposal` (real events / entities / outbox rows).
 *
 * Contract under test:
 *   - no LLM calls during replay (the llm module throws if touched);
 *   - routine legacy pending rows auto-commit exactly once;
 *   - canon conflict / unmergeable / low-confidence-affects-later stay
 *     pending (fail-closed for the review screen);
 *   - replay is idempotent: a second run commits nothing new and never
 *     duplicates state events;
 *   - routine leftovers no longer trip the Batch conflict gate, while a
 *     real conflict still blocks it.
 */
import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import type { InMemorySqliteDb } from './helpers/canonInMemoryDb';
import {
  __setDatabaseForTest,
  __resetForTest,
  openDatabase,
} from '../src/data/connection/openDatabase';
import { replayPendingContinuityProposals } from '../src/services/writing/memory/continuityStateAutoCommit';
import { checkNextChapterReady } from '../src/services/multiChapterBatch/continuationBatchStateGate';
import { contentRevisionHash } from '../src/services/continuation/generation/generationRepository';

jest.mock('../src/services/llm', () => ({
  callLLMResult: () => {
    throw new Error('replay must not make LLM calls');
  },
}));

const PROJECT_ID = 1;
const CHAPTER_ID = 101;
const CHAPTER_POSITION = 72;
const CHAPTER_CONTENT = '第七十二章 灯塔下的对峙。林澜握紧了信号枪。';

async function sql(sqlText: string, params: any[] = []): Promise<any> {
  const db = await openDatabase();
  const [res] = await db.executeSql(sqlText, params);
  return res;
}

async function count(sqlText: string, params: any[] = []): Promise<number> {
  const res = await sql(sqlText, params);
  return Number(res.rows.item(0).c);
}

interface ProposalSeed {
  id: string;
  proposalType: string;
  payloadJson: string;
  subjectRefType?: string | null;
  subjectRefId?: string | null;
}

async function seedProposal(seed: ProposalSeed): Promise<void> {
  const now = new Date().toISOString();
  await sql(
    `INSERT INTO continuation_state_proposals (
       id, project_id, chapter_id, source_run_id, extraction_content_hash,
       chapter_revision_hash, proposal_type, subject_ref_type, subject_ref_id,
       payload_json, proposal_fingerprint, evidence_start, evidence_end,
       status, created_at, updated_at
     ) VALUES (?, ?, ?, NULL, 'hash', 'hash', ?, ?, ?, ?, ?, 0, 10, 'pending', ?, ?)`,
    [
      seed.id,
      PROJECT_ID,
      CHAPTER_ID,
      seed.proposalType,
      seed.subjectRefType ?? null,
      seed.subjectRefId ?? null,
      seed.payloadJson,
      `fp_${seed.id}`,
      now,
      now,
    ],
  );
}

/** Settled batch world: finalized chapter + exact outbox rows + clean memory. */
async function seedSettledBase(): Promise<void> {
  const revisionHash = contentRevisionHash(CHAPTER_CONTENT);
  const now = new Date().toISOString();
  await sql(
    `INSERT INTO projects (id, name, mode, created_at, updated_at)
     VALUES (1, 'closure-replay', 'continuation', ?, ?)`,
    [now, now],
  );
  await sql(
    `INSERT INTO chapters (id, project_id, position, title, synopsis, content, status, created_at, updated_at)
     VALUES (?, ?, ?, '第七十二章', '', ?, 'finalized', ?, ?)`,
    [CHAPTER_ID, PROJECT_ID, CHAPTER_POSITION, CHAPTER_CONTENT, now, now],
  );
  await sql(
    `INSERT INTO project_story_memory (
       project_id, schema_version, through_chapter_id, through_chapter_position,
       memory_json, estimated_tokens, state_fingerprint, status, source,
       dirty_from_position, last_error, updated_at
     ) VALUES (?, 1, ?, ?, ?, 100, 'fp', 'clean', 'native', NULL, '', ?)`,
    [
      PROJECT_ID,
      CHAPTER_ID,
      CHAPTER_POSITION,
      JSON.stringify({ throughChapterPosition: CHAPTER_POSITION, metadata: {} }),
      now,
    ],
  );
  await sql(
    `INSERT INTO continuation_state_sync_outbox (
       id, project_id, chapter_id, operation, payload_json, dedupe_key,
       state, attempt_count, last_error, created_at, updated_at, completed_at
     ) VALUES
       ('co_ex', 1, ?, 'extract_state', '{}', ?, 'completed', 1, NULL, ?, ?, ?),
       ('co_rb', 1, ?, 'rebuild_story_memory', '{}', ?, 'completed', 1, NULL, ?, ?, ?)`,
    [
      CHAPTER_ID,
      `extract_state:${CHAPTER_ID}:${revisionHash}`,
      now,
      now,
      now,
      CHAPTER_ID,
      `rebuild_story_memory:auto:${PROJECT_ID}:${CHAPTER_POSITION}:${revisionHash}`,
      now,
      now,
      now,
    ],
  );
}

/** Simulate the outbox worker settling everything the replay enqueued. */
async function settlePostReplayOutbox(): Promise<void> {
  await sql(
    `UPDATE continuation_state_sync_outbox
     SET state = 'completed', completed_at = ?
     WHERE project_id = ? AND state = 'pending'`,
    [new Date().toISOString(), PROJECT_ID],
  );
  await sql(
    `UPDATE project_story_memory
     SET status = 'clean', dirty_from_position = NULL, updated_at = ?
     WHERE project_id = ?`,
    [new Date().toISOString(), PROJECT_ID],
  );
}

function gateInput() {
  return {
    projectId: PROJECT_ID,
    completedChapterId: CHAPTER_ID,
    completedPosition: CHAPTER_POSITION,
    anchor: null,
  };
}

describe('ONE-Flow closure pending replay (P0-2)', () => {
  let db: InMemorySqliteDb;

  beforeAll(async () => {
    db = await createCanonInMemoryDb();
    __setDatabaseForTest(db as any);
  });

  afterAll(() => {
    __resetForTest();
    db?.close();
  });

  beforeEach(async () => {
    await sql('DELETE FROM continuation_state_sync_outbox');
    await sql('DELETE FROM continuation_state_events');
    await sql('DELETE FROM continuation_entities');
    await sql('DELETE FROM continuation_state_proposals');
    await sql('DELETE FROM project_story_memory');
    await sql('DELETE FROM chapters');
    await sql('DELETE FROM projects');
    await seedSettledBase();
  });

  test('routine legacy pending rows auto-commit through the classifier', async () => {
    await seedProposal({
      id: 'p_loc',
      proposalType: 'character_state',
      payloadJson: JSON.stringify({
        summary: '林澜移动到灯塔顶层。',
        fields: { location: '灯塔顶层', physicalState: '轻伤' },
      }),
      subjectRefType: 'canon_character',
      subjectRefId: '5',
    });
    await seedProposal({
      id: 'p_plot',
      proposalType: 'plot_advance',
      payloadJson: JSON.stringify({ summary: '众人决定天亮前撤离小岛。' }),
    });
    await seedProposal({
      id: 'p_newchar',
      proposalType: 'new_character',
      payloadJson: JSON.stringify({ name: '陈伯谦', summary: '灯塔看守人。' }),
    });

    const result = await replayPendingContinuityProposals(PROJECT_ID);
    expect(result.autoCommittedIds.sort()).toEqual([
      'p_loc',
      'p_newchar',
      'p_plot',
    ]);
    expect(result.confirmationRequired).toEqual([]);

    const accepted = await count(
      `SELECT COUNT(*) AS c FROM continuation_state_proposals
       WHERE status = 'accepted' AND decision_note LIKE 'auto_commit:%'`,
    );
    expect(accepted).toBe(3);
    const events = await count(
      'SELECT COUNT(*) AS c FROM continuation_state_events',
    );
    expect(events).toBe(3);
    const entities = await count(
      'SELECT COUNT(*) AS c FROM continuation_entities',
    );
    expect(entities).toBe(1);
  });

  test('canon conflict / unmergeable / low-confidence-affects-later stay pending', async () => {
    await seedProposal({
      id: 'p_canon',
      proposalType: 'character_state',
      payloadJson: JSON.stringify({
        summary: '与原著生死状态冲突。',
        canonConflict: true,
      }),
    });
    await seedProposal({
      id: 'p_unmerge',
      proposalType: 'character_state',
      payloadJson: JSON.stringify({
        summary: '无法合并的旧流程残留。',
        unmergeable: true,
      }),
    });
    await seedProposal({
      id: 'p_lowconf',
      proposalType: 'relationship_change',
      payloadJson: JSON.stringify({
        summary: '两人关系发生微妙变化。',
        confidence: 0.2,
      }),
    });

    const result = await replayPendingContinuityProposals(PROJECT_ID);
    expect(result.autoCommittedIds).toEqual([]);
    expect(result.confirmationRequired.map(item => item.reason).sort()).toEqual(
      ['canon_conflict', 'low_confidence_affects_later', 'unmergeable'],
    );

    const stillPending = await count(
      `SELECT COUNT(*) AS c FROM continuation_state_proposals
       WHERE status = 'pending'`,
    );
    expect(stillPending).toBe(3);
    const events = await count(
      'SELECT COUNT(*) AS c FROM continuation_state_events',
    );
    expect(events).toBe(0);
  });

  test('replay is idempotent: a second run commits and writes nothing new', async () => {
    await seedProposal({
      id: 'p_once',
      proposalType: 'plot_advance',
      payloadJson: JSON.stringify({ summary: '船队驶向北岸。' }),
    });
    await seedProposal({
      id: 'p_conflict',
      proposalType: 'character_state',
      payloadJson: JSON.stringify({ summary: '冲突', canonConflict: true }),
    });

    const first = await replayPendingContinuityProposals(PROJECT_ID);
    expect(first.autoCommittedIds).toEqual(['p_once']);
    const eventsAfterFirst = await count(
      'SELECT COUNT(*) AS c FROM continuation_state_events',
    );
    const outboxAfterFirst = await count(
      'SELECT COUNT(*) AS c FROM continuation_state_sync_outbox',
    );

    const second = await replayPendingContinuityProposals(PROJECT_ID);
    expect(second.autoCommittedIds).toEqual([]);
    expect(second.confirmationRequired.map(item => item.proposalId)).toEqual([
      'p_conflict',
    ]);

    const eventsAfterSecond = await count(
      'SELECT COUNT(*) AS c FROM continuation_state_events',
    );
    const outboxAfterSecond = await count(
      'SELECT COUNT(*) AS c FROM continuation_state_sync_outbox',
    );
    expect(eventsAfterSecond).toBe(eventsAfterFirst);
    expect(outboxAfterSecond).toBe(outboxAfterFirst);
  });

  test('routine leftovers no longer trip the Batch conflict gate after replay', async () => {
    await seedProposal({
      id: 'p_routine',
      proposalType: 'plot_advance',
      payloadJson: JSON.stringify({ summary: '日常推进。' }),
    });

    await replayPendingContinuityProposals(PROJECT_ID);
    await settlePostReplayOutbox();

    const result = await checkNextChapterReady(gateInput());
    expect(result.ready).toBe(true);
  });

  test('real conflict still blocks the Batch gate', async () => {
    await seedProposal({
      id: 'p_conflict',
      proposalType: 'character_state',
      payloadJson: JSON.stringify({ summary: '冲突', canonConflict: true }),
    });

    await replayPendingContinuityProposals(PROJECT_ID);
    await settlePostReplayOutbox();

    const result = await checkNextChapterReady(gateInput());
    expect(result.ready).toBe(false);
    if (!result.ready && result.status === 'blocked') {
      expect(result.errorCode).toBe('BATCH_CONTINUATION_STATE_CONFLICT');
    }
  });
});
