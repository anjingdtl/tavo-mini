/**
 * Outline Workflow V2 — production state-machine integration tests (§6.5).
 *
 * Drives the REAL `reconcilePipelineTask` (real in-memory SQLite + real
 * repositories + real pipelineTaskStore) with ONLY `callLLMResult` mocked.
 * Tasks are created with frozen versions outlineWorkflowVersion=2 /
 * contextBudgetVersion=2 (exactly what the new app writes at creation), so
 * the whole V2 protocol runs through the production path:
 *
 *   V2 noReview      : Draft only
 *   V2 twoStage      : Draft → Review V2 → Final Reviser
 *   V2 conditional   : Draft → FactCheck V2 → Final Reviser
 *   V2 full          : Draft → Review∥FactCheck → Final Reviser
 *   full 单审核失败   : one side fails → contract from the other side
 *   full 双审核失败   : Draft fallback, Proof NEVER fires
 *   format repair    : at most once, request_version=2
 *   Final Validator  : runs BEFORE the proof checkpoint becomes success
 *
 * Physical request counts, attempt versions and task terminal state are
 * asserted from the real pipeline_stage_attempts rows.
 */
jest.mock('../src/services/llm', () => {
  const actual = jest.requireActual('../src/services/llm');
  return {
    ...actual,
    callLLMResult: (...args: unknown[]) => mockCallLLMResult(...args),
  };
});

import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import type { InMemorySqliteDb } from './helpers/canonInMemoryDb';
import {
  __setDatabaseForTest,
  __resetForTest,
  openDatabase,
} from '../src/data/connection/openDatabase';
import { execute } from '../src/data/connection/execute';
import { all } from '../src/data/connection/query';
import { usePipelineTaskStore } from '../src/store/pipelineTaskStore';
import { reconcilePipelineTask } from '../src/services/pipeline/reconcile';
import { savePipelineTask } from '../src/data/repositories/pipelineTaskRepository';
import { LLMRequestError } from '../src/services/llm/requestPolicy';
import {
  buildRevisionAnchors,
  canonicalizeDraft,
  computeDraftHash,
} from '../src/services/pipeline/revisionAnchors';
import type { ChatMessage } from '../src/services/llm';
import type { LLMResult } from '../src/services/llm/types';
import type { Chapter } from '../src/types/novel';

let mockCallLLMResult: jest.Mock = jest.fn();
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
      // ignore
    }
    testDb = null;
  }
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DRAFT_BODY =
  '主角走进了森林，在林间小径上遇到了守林的老者。\n\n老者警告他不要靠近古井，说那口井十年前就干涸了。';
const DRAFT_HASH = computeDraftHash(canonicalizeDraft(DRAFT_BODY));

function reviewV2Report(overrides: Record<string, unknown> = {}): object {
  return {
    schemaVersion: 2,
    draftHash: DRAFT_HASH,
    requiredCorrections: [
      {
        id: 'r1',
        scope: 'anchor',
        anchorId: 'draft-p-002',
        dimension: '人物表现',
        severity: 'required',
        diagnosis: '老者语气生硬',
        rewriteGoal: '让老者语气更温和',
        preserveMeaning: ['老者身份不变'],
      },
    ],
    protectedAnchorIds: ['draft-p-001'],
    outlineExecution: {
      fulfilledBeats: ['抵达森林'],
      missingBeats: [],
      deviations: [],
      prematureBeats: [],
      mustPreserve: ['老者身份'],
      endingGoal: '完成警告',
      mustNotAdvance: [],
    },
    ...overrides,
  };
}

function factCheckV2Report(overrides: Record<string, unknown> = {}): object {
  return {
    schemaVersion: 2,
    draftHash: DRAFT_HASH,
    requiredCorrections: [
      {
        id: 'f1',
        scope: 'anchor',
        anchorId: 'draft-p-001',
        dimension: '连续性',
        severity: 'hard',
        diagnosis: '主角此前并未见过老者',
        rewriteGoal: '改为初次相遇的陌生老者',
        preserveMeaning: [],
      },
    ],
    protectedFacts: ['老者是守林人'],
    hardConstraints: ['古井在森林深处'],
    ...overrides,
  };
}

function llm(text: string, finishReason: string = 'stop'): LLMResult {
  return {
    text,
    reasoningText: null,
    finishReason,
    inputTokens: 50,
    outputTokens: 100,
    totalTokens: 150,
  };
}

/** Classify a request by its prompt content; returns the stage name. */
function stageOf(messages: ChatMessage[]): string {
  const all = messages.map(m => String(m.content ?? '')).join('\n');
  if (all.includes('你是初稿作者')) return 'draft';
  if (all.includes('你是小说终审前的审阅编辑')) return 'review';
  if (all.includes('可定位、可执行的修正合同')) return 'factCheck';
  if (all.includes('你是终稿修订员')) return 'proof';
  if (all.includes('【修订合同（Edit Work Packet）')) return 'proof';
  return 'unknown';
}

/** Default scripted LLM: correct outputs for all four V2 stages. */
function v2HappyPathMock() {
  return jest.fn().mockImplementation(async (messages: ChatMessage[]) => {
    switch (stageOf(messages)) {
      case 'draft':
        return llm(DRAFT_BODY);
      case 'review':
        return llm(JSON.stringify(reviewV2Report()));
      case 'factCheck':
        return llm(JSON.stringify(factCheckV2Report()));
      case 'proof':
        return llm(DRAFT_BODY + '\n\n老者温和地提醒了他。');
      default:
        throw new Error(`unexpected stage request: ${stageOf(messages)}`);
    }
  });
}

async function seedBaseData(mode: string): Promise<{ chapterId: number }> {
  await execute(
    await openDatabase(),
    `INSERT INTO settings (key, value) VALUES ('pipeline_mode', ?)`,
    [mode],
  );
  await execute(
    await openDatabase(),
    `INSERT INTO llm_config
       (id, name, base_url, api_key, model_name, is_active, provider_type,
        context_window, max_output_tokens)
     VALUES (1, 'm', 'http://127.0.0.1:9/v1', 'k', 'mm', 1,
             'openai_compatible', 8000, 4000)`,
  );
  await execute(
    await openDatabase(),
    `INSERT INTO projects (id, name, mode, created_at, updated_at)
     VALUES (1, 'p', 'outline', 't', 't')`,
  );
  const chapterResult = await execute(
    await openDatabase(),
    `INSERT INTO chapters (project_id, position, title, synopsis, content, status, created_at, updated_at)
     VALUES (1, 0, '第1章', '梗概', '', 'draft', 't', 't')`,
  );
  return { chapterId: chapterResult.insertId as number };
}

async function registerTask(
  taskId: string,
  chapterId: number,
  versions: { outlineWorkflowVersion: 1 | 2; contextBudgetVersion: 1 | 2 } = {
    outlineWorkflowVersion: 2,
    contextBudgetVersion: 2,
  },
): Promise<void> {
  const now = Date.now();
  usePipelineTaskStore.getState().registerPersistedTask({
    id: taskId,
    targetType: 'chapter',
    targetId: chapterId,
    status: 'idle',
    stageResults: [],
    finalText: null,
    error: null,
    inputFingerprint: null,
    pipelineContextJson: null,
    pipelineContextVersion: null,
    pipelineContextHash: null,
    outlineWorkflowVersion: versions.outlineWorkflowVersion,
    contextBudgetVersion: versions.contextBudgetVersion,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    resolvedAction: null,
  });
  await savePipelineTask({
    id: taskId,
    targetType: 'chapter',
    targetId: chapterId,
    status: 'idle',
    stageResults: [],
    finalText: null,
    error: null,
    outlineWorkflowVersion: versions.outlineWorkflowVersion,
    contextBudgetVersion: versions.contextBudgetVersion,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
  });
}

function chapterFor(chapterId: number): Chapter {
  return {
    id: chapterId,
    project_id: 1,
    position: 0,
    title: '第1章',
    synopsis: '梗概',
    content: '',
    status: 'draft',
    summary_json: null,
    created_at: 't',
    updated_at: 't',
  };
}

async function attemptsFor(taskId: string): Promise<any[]> {
  return all(
    `SELECT stage, attempt_no, request_version, status FROM pipeline_stage_attempts
     WHERE pipeline_task_id = ? ORDER BY rowid ASC`,
    [taskId],
  );
}

/**
 * V2 protocol: draft shares the V1 request shape (request_version=1), while
 * the V2-only stages (review / factCheck / proof) must record version 2.
 */
function expectV2AttemptVersions(attempts: any[]) {
  for (const a of attempts) {
    const expected = a.stage === 'draft' ? 1 : 2;
    expect(Number(a.request_version)).toBe(expected);
  }
}

async function checkpointStatus(taskId: string, stage: string): Promise<string> {
  const rows = await all(
    `SELECT status FROM pipeline_stage_checkpoints
     WHERE task_id = ? AND stage = ?`,
    [taskId, stage],
  );
  return rows[0]?.status ?? '__missing__';
}

async function taskStatus(taskId: string): Promise<string> {
  const rows = await all(`SELECT status, final_text, error FROM pipeline_tasks WHERE id = ?`, [taskId]);
  if (rows[0]?.error) {
    // eslint-disable-next-line no-console
    console.log('DEBUG task error:', taskId, String(rows[0].error).slice(0, 300));
  }
  return rows[0]?.status ?? '__missing__';
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('V2 production state machine (frozen version=2)', () => {
  jest.setTimeout(90_000);

  it('V2 noReview: only Draft fires, task completes', async () => {
    await resetDb();
    const { chapterId } = await seedBaseData('noReview');
    const taskId = 't-v2-noreview';
    await registerTask(taskId, chapterId);
    mockCallLLMResult = v2HappyPathMock();

    await reconcilePipelineTask(taskId, chapterFor(chapterId));

    expect(await taskStatus(taskId)).toBe('completed');
    const attempts = await attemptsFor(taskId);
    expect(attempts.map(a => a.stage)).toEqual(['draft']);
    expect(attempts[0].status).toBe('succeeded');
    expect(await checkpointStatus(taskId, 'review')).toBe('skipped');
  });

  it('V2 twoStage: Draft → Review → Final Reviser (3 requests, request_version=2)', async () => {
    await resetDb();
    const { chapterId } = await seedBaseData('twoStage');
    const taskId = 't-v2-twostage';
    await registerTask(taskId, chapterId);
    mockCallLLMResult = v2HappyPathMock();

    await reconcilePipelineTask(taskId, chapterFor(chapterId));

    expect(await taskStatus(taskId)).toBe('completed');
    const attempts = await attemptsFor(taskId);
    expect(attempts.map(a => a.stage)).toEqual([
      'draft',
      'review',
      'proof',
    ]);
    expectV2AttemptVersions(attempts);
    for (const a of attempts) {
      expect(a.status).toBe('succeeded');
    }
    expect(await checkpointStatus(taskId, 'proof')).toBe('succeeded');
  });

  it('V2 Review / FactCheck use deterministic, reasoning-disabled audit requests', async () => {
    await resetDb();
    const { chapterId } = await seedBaseData('full');
    const taskId = 't-v2-structured-audit-options';
    await registerTask(taskId, chapterId);
    const auditConfigs: Record<string, any[]> = { review: [], factCheck: [] };
    mockCallLLMResult = jest
      .fn()
      .mockImplementation(async (messages: ChatMessage[], _maxTokens: number, config: any) => {
        const stage = stageOf(messages);
        if (stage === 'draft') return llm(DRAFT_BODY);
        if (stage === 'review' || stage === 'factCheck') {
          auditConfigs[stage].push(config);
          return stage === 'review'
            ? llm(JSON.stringify(reviewV2Report()))
            : llm(JSON.stringify(factCheckV2Report()));
        }
        if (stage === 'proof') return llm(DRAFT_BODY + '\n\n老者温和地提醒了他。');
        throw new Error(`unexpected stage: ${stage}`);
      });

    await reconcilePipelineTask(taskId, chapterFor(chapterId));

    for (const stage of ['review', 'factCheck'] as const) {
      expect(auditConfigs[stage]).toHaveLength(1);
      expect(auditConfigs[stage][0]).toMatchObject({
        responseFormat: 'json_object',
        thinking: { type: 'disabled' },
        temperature: 0.2,
        top_p: 1,
      });
    }
  });

  it('V2 conditional: Draft → FactCheck → Final Reviser (3 requests)', async () => {
    await resetDb();
    const { chapterId } = await seedBaseData('conditional');
    const taskId = 't-v2-conditional';
    await registerTask(taskId, chapterId);
    mockCallLLMResult = v2HappyPathMock();

    await reconcilePipelineTask(taskId, chapterFor(chapterId));

    expect(await taskStatus(taskId)).toBe('completed');
    const attempts = await attemptsFor(taskId);
    expect(attempts.map(a => a.stage)).toEqual([
      'draft',
      'factCheck',
      'proof',
    ]);
    expectV2AttemptVersions(attempts);
  });

  it('V2 full: Draft → Review∥FactCheck → Final Reviser (4 requests)', async () => {
    await resetDb();
    const { chapterId } = await seedBaseData('full');
    const taskId = 't-v2-full';
    await registerTask(taskId, chapterId);
    mockCallLLMResult = v2HappyPathMock();

    await reconcilePipelineTask(taskId, chapterFor(chapterId));

    expect(await taskStatus(taskId)).toBe('completed');
    const attempts = await attemptsFor(taskId);
    const stages = attempts.map(a => a.stage).sort();
    expect(stages).toEqual(['draft', 'factCheck', 'proof', 'review']);
    expectV2AttemptVersions(attempts);
    for (const a of attempts) {
      expect(a.status).toBe('succeeded');
    }
    // Full mode: both audit checkpoints succeeded.
    expect(await checkpointStatus(taskId, 'review')).toBe('succeeded');
    expect(await checkpointStatus(taskId, 'factCheck')).toBe('succeeded');
  });

  it('V2 full single-audit failure: one valid report still builds the contract', async () => {
    await resetDb();
    const { chapterId } = await seedBaseData('full');
    const taskId = 't-v2-single';
    await registerTask(taskId, chapterId);
    mockCallLLMResult = jest
      .fn()
      .mockImplementation(async (messages: ChatMessage[]) => {
        switch (stageOf(messages)) {
          case 'draft':
            return llm(DRAFT_BODY);
          case 'review':
            // Invalid review: wrong draftHash → fail-closed review side.
            return llm(JSON.stringify(reviewV2Report({ draftHash: 'deadbeef' })));
          case 'factCheck':
            return llm(JSON.stringify(factCheckV2Report()));
          case 'proof':
            return llm(DRAFT_BODY + '\n\n老者温和地提醒了他。');
          default:
            throw new Error('unexpected stage');
        }
      });

    await reconcilePipelineTask(taskId, chapterFor(chapterId));

    expect(await taskStatus(taskId)).toBe('completed');
    expect(await checkpointStatus(taskId, 'review')).toBe('failed');
    expect(await checkpointStatus(taskId, 'factCheck')).toBe('succeeded');
    expect(await checkpointStatus(taskId, 'proof')).toBe('succeeded');
    // Review repair fires once (2 review attempts), then the valid factCheck
    // side carries the contract.
    const attempts = await attemptsFor(taskId);
    expect(attempts.filter(a => a.stage === 'review').length).toBe(2);
    expect(attempts.filter(a => a.stage === 'proof').length).toBe(1);
  });

  it('V2 full double-audit failure: Draft fallback, Proof NEVER fires', async () => {
    await resetDb();
    const { chapterId } = await seedBaseData('full');
    const taskId = 't-v2-double';
    await registerTask(taskId, chapterId);
    mockCallLLMResult = jest
      .fn()
      .mockImplementation(async (messages: ChatMessage[]) => {
        switch (stageOf(messages)) {
          case 'draft':
            return llm(DRAFT_BODY);
          case 'review':
            return llm(JSON.stringify(reviewV2Report({ draftHash: 'bad' })));
          case 'factCheck':
            return llm(JSON.stringify(factCheckV2Report({ draftHash: 'bad' })));
          case 'proof':
            throw new Error('proof must never fire');
          default:
            throw new Error('unexpected stage');
        }
      });

    await reconcilePipelineTask(taskId, chapterFor(chapterId));

    // Finalize marks proof skipped (never ran); task degrades to draft
    // fallback with the draft preserved as finalText (no 5th request).
    expect(await checkpointStatus(taskId, 'proof')).toBe('skipped');
    const proofAttempts = await attemptsFor(taskId);
    expect(proofAttempts.filter(a => a.stage === 'proof').length).toBe(0);
    expect(await taskStatus(taskId)).toBe('failed');
    const rows = await all(`SELECT final_text FROM pipeline_tasks WHERE id = ?`, [taskId]);
    expect(String(rows[0]?.final_text ?? '')).toContain('森林');
  });

  it('V2 format repair fires AT MOST once and all attempts are request_version=2', async () => {
    await resetDb();
    const { chapterId } = await seedBaseData('twoStage');
    const taskId = 't-v2-repair';
    await registerTask(taskId, chapterId);
    let reviewCalls = 0;
    const reviewMessages: ChatMessage[][] = [];
    mockCallLLMResult = jest
      .fn()
      .mockImplementation(async (messages: ChatMessage[]) => {
        switch (stageOf(messages)) {
          case 'draft':
            return llm(DRAFT_BODY);
          case 'review': {
            reviewCalls += 1;
            reviewMessages.push(messages);
            if (reviewCalls === 1) {
              // Malformed report (missing outlineExecution) → repair.
              return llm(JSON.stringify({ schemaVersion: 2, draftHash: DRAFT_HASH }));
            }
            return llm(JSON.stringify(reviewV2Report()));
          }
          case 'proof':
            return llm(DRAFT_BODY + '\n\n老者温和地提醒了他。');
          default:
            throw new Error('unexpected stage');
        }
      });

    await reconcilePipelineTask(taskId, chapterFor(chapterId));

    expect(reviewCalls).toBe(2);
    const attempts = await attemptsFor(taskId);
    expect(attempts.filter(a => a.stage === 'review').length).toBe(2);
    expectV2AttemptVersions(attempts);
    expect(reviewMessages[1][reviewMessages[1].length - 1].content).toContain(
      'outlineExecution',
    );
    expect(await taskStatus(taskId)).toBe('completed');
  });

  it('V2 reasoning-only repair keeps thinking disabled and recompiles the bumped budget', async () => {
    await resetDb();
    const { chapterId } = await seedBaseData('twoStage');
    const taskId = 't-v2-reasoning-repair-budget';
    await registerTask(taskId, chapterId);
    const reviewConfigs: any[] = [];
    let reviewCalls = 0;
    mockCallLLMResult = jest
      .fn()
      .mockImplementation(async (messages: ChatMessage[], _maxTokens: number, config: any) => {
        switch (stageOf(messages)) {
          case 'draft':
            return llm(DRAFT_BODY);
          case 'review':
            reviewCalls += 1;
            reviewConfigs.push(config);
            if (reviewCalls === 1) {
              return {
                text: null,
                reasoningText: '先分析章节结构……'.repeat(40),
                emptyReason: 'reasoning_only',
                inputTokens: 50,
                outputTokens: 1500,
                totalTokens: 1550,
              };
            }
            return llm(JSON.stringify(reviewV2Report()));
          case 'proof':
            return llm(DRAFT_BODY + '\n\n老者温和地提醒了他。');
          default:
            throw new Error('unexpected stage');
        }
      });

    await reconcilePipelineTask(taskId, chapterFor(chapterId));

    expect(reviewConfigs).toHaveLength(2);
    expect(reviewConfigs[0].thinking).toEqual({ type: 'disabled' });
    expect(reviewConfigs[1].thinking).toEqual({ type: 'disabled' });
    expect(reviewConfigs[1].max_tokens).toBe(reviewConfigs[0].max_tokens * 2);
    expect(await taskStatus(taskId)).toBe('completed');
  });

  it('Final Artifact Validator blocks incomplete proof BEFORE checkpoint success (draft fallback)', async () => {
    await resetDb();
    const { chapterId } = await seedBaseData('full');
    const taskId = 't-v2-validator';
    await registerTask(taskId, chapterId);
    mockCallLLMResult = jest
      .fn()
      .mockImplementation(async (messages: ChatMessage[]) => {
        switch (stageOf(messages)) {
          case 'draft':
            return llm(DRAFT_BODY);
          case 'review':
            return llm(JSON.stringify(reviewV2Report()));
          case 'factCheck':
            return llm(JSON.stringify(factCheckV2Report()));
          case 'proof':
            // Clearly truncated: mid-sentence tail with finishReason=length.
            return llm('老者警告他不要靠近古井，说那口井十年前就', 'length');
          default:
            throw new Error('unexpected stage');
        }
      });

    await reconcilePipelineTask(taskId, chapterFor(chapterId));

    // Validator ran before the success persist: proof checkpoint failed.
    expect(await checkpointStatus(taskId, 'proof')).toBe('failed');
    const attempts = await attemptsFor(taskId);
    expect(attempts.filter(a => a.stage === 'proof').length).toBe(1);
    // Draft fallback: task degrades to failed with the draft preserved as
    // finalText — no extra model call beyond the one proof attempt.
    expect(await taskStatus(taskId)).toBe('failed');
    const rows = await all(`SELECT final_text FROM pipeline_tasks WHERE id = ?`, [taskId]);
    expect(String(rows[0]?.final_text ?? '')).toContain('森林');
  });

  it('V2 Proof failure resume re-fires ONLY the V2 proof (no protocol downgrade)', async () => {
    await resetDb();
    const { chapterId } = await seedBaseData('full');
    const taskId = 't-v2-resume';
    await registerTask(taskId, chapterId);
    let proofCalls = 0;
    mockCallLLMResult = jest
      .fn()
      .mockImplementation(async (messages: ChatMessage[]) => {
        switch (stageOf(messages)) {
          case 'draft':
            return llm(DRAFT_BODY);
          case 'review':
            return llm(JSON.stringify(reviewV2Report()));
          case 'factCheck':
            return llm(JSON.stringify(factCheckV2Report()));
          case 'proof': {
            proofCalls += 1;
            if (proofCalls === 1) {
              // Transient failure → checkpoint failed, resumable.
              throw new LLMRequestError('transient', 'transient', undefined, {
                httpStatus: 503,
                retryAfterMs: 0,
                failureClass: 'safe_retry',
                requestMayHaveExecuted: false,
              });
            }
            return llm(DRAFT_BODY + '\n\n老者温和地提醒了他。');
          }
          default:
            throw new Error('unexpected stage');
        }
      });

    await reconcilePipelineTask(taskId, chapterFor(chapterId));

    // The transient proof failure entered safe_retry backoff and was
    // re-fired in the SAME loop once due — the retry disposition is consumed
    // before the degraded finalize (only the failed proof stage re-ran).
    const attempts = await attemptsFor(taskId);
    expect(attempts.filter(a => a.stage === 'draft').length).toBe(1);
    expect(attempts.filter(a => a.stage === 'review').length).toBe(1);
    expect(attempts.filter(a => a.stage === 'factCheck').length).toBe(1);
    expect(attempts.filter(a => a.stage === 'proof').length).toBe(2);
    const proofAttempts = attempts.filter(a => a.stage === 'proof');
    expect(Number(proofAttempts[1].request_version)).toBe(2);
    expect(proofAttempts[1].status).toBe('succeeded');
    expect(await checkpointStatus(taskId, 'proof')).toBe('succeeded');
    expect(await taskStatus(taskId)).toBe('completed');
  });

  it('legacy task (version=1) NEVER enters the V2 protocol', async () => {
    await resetDb();
    const { chapterId } = await seedBaseData('twoStage');
    const taskId = 't-legacy-v1';
    await registerTask(taskId, chapterId, {
      outlineWorkflowVersion: 1,
      contextBudgetVersion: 1,
    });
    mockCallLLMResult = jest
      .fn()
      .mockImplementation(async (messages: ChatMessage[]) => {
        const stage = stageOf(messages);
        // Legacy proof prompt has no Final-Reviser marker; assert V2 never
        // fires by rejecting the V2-only stage names.
        if (stage === 'draft') return llm(DRAFT_BODY);
        const all = messages.map(m => String(m.content ?? '')).join('\n');
        if (all.includes('资深小说审阅编辑')) {
          // Legacy review expects the legacy JSON contract.
          return llm(
            JSON.stringify({
              strengths: ['场景清晰'],
              issues: ['老者语气生硬'],
              suggestions: ['让语气温和'],
            }),
          );
        }
        if (all.includes('你是终审校对员')) {
          // Legacy proof prompt (no Final-Reviser marker).
          return llm(DRAFT_BODY + '\n\n老者温和地提醒了他。');
        }
        throw new Error(`legacy task must not call V2 stage ${stage}`);
      });

    await reconcilePipelineTask(taskId, chapterFor(chapterId));

    // eslint-disable-next-line no-console
    console.log('DEBUG legacy cp:', JSON.stringify(await all(
      `SELECT stage, status, error_message FROM pipeline_stage_checkpoints WHERE task_id = ?`,
      [taskId],
    )));
    expect(await taskStatus(taskId)).toBe('completed');
    const attempts = await attemptsFor(taskId);
    for (const a of attempts) {
      expect(Number(a.request_version)).toBe(1);
    }
  });
});

// Sanity: the anchors/draft fixtures used above are internally consistent.
describe('fixture sanity', () => {
  it('DRAFT_BODY produces exactly two anchors', () => {
    const anchors = buildRevisionAnchors(canonicalizeDraft(DRAFT_BODY));
    expect(anchors).toHaveLength(2);
    expect(anchors[0].id).toBe('draft-p-001');
    expect(anchors[1].id).toBe('draft-p-002');
  });
});
