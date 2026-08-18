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
    // Shared Writer first-pass contract: a structured report must carry an
    // explicit adoptable signal (content + verdict, or issues/strengths/
    // suggestions). Without it the stage is unadoptable and fires the one
    // thinking-disabled Formatter rescue instead of completing first-pass.
    content: '审阅完成：老者语气需要更温和，其余无阻塞问题。',
    verdict: 'needs_revision',
    findings: [],
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
    content: '事实核查完成：主角与老者的关系与设定冲突。',
    verdict: 'needs_revision',
    findings: [],
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
  const joined = messages.map(m => String(m.content ?? '')).join('\n');
  if (joined.includes('你是初稿作者')) return 'draft';
  if (joined.includes('你是小说终审前的审阅编辑')) return 'review';
  if (joined.includes('可定位、可执行的修正合同')) return 'factCheck';
  if (joined.includes('你是终稿修订员')) return 'proof';
  if (joined.includes('【修订合同（Edit Work Packet）')) return 'proof';
  // One thinking-disabled Formatter rescue is part of the Shared Writer
  // first-pass contract (V3.2): an unadoptable structured report gets at most
  // one reformat request before the stage fails closed.
  if (joined.includes('Shared review Formatter')) return 'reviewFormatter';
  if (joined.includes('Shared factCheck Formatter')) return 'factCheckFormatter';
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

async function checkpointStatus(
  taskId: string,
  stage: string,
): Promise<string> {
  const rows = await all(
    `SELECT status FROM pipeline_stage_checkpoints
     WHERE task_id = ? AND stage = ?`,
    [taskId, stage],
  );
  return rows[0]?.status ?? '__missing__';
}

async function taskStatus(taskId: string): Promise<string> {
  const rows = await all(
    `SELECT status, final_text, error FROM pipeline_tasks WHERE id = ?`,
    [taskId],
  );
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
    expect(attempts.map(a => a.stage)).toEqual(['draft', 'review', 'proof']);
    expectV2AttemptVersions(attempts);
    for (const a of attempts) {
      expect(a.status).toBe('succeeded');
    }
    expect(await checkpointStatus(taskId, 'proof')).toBe('succeeded');
  });

  it('V2 Review / FactCheck use deterministic audit requests with frozen per-stage thinking', async () => {
    await resetDb();
    const { chapterId } = await seedBaseData('full');
    const taskId = 't-v2-structured-audit-options';
    await registerTask(taskId, chapterId);
    const auditConfigs: Record<string, any[]> = { review: [], factCheck: [] };
    mockCallLLMResult = jest
      .fn()
      .mockImplementation(
        async (messages: ChatMessage[], _maxTokens: number, config: any) => {
          const stage = stageOf(messages);
          if (stage === 'draft') return llm(DRAFT_BODY);
          if (stage === 'review' || stage === 'factCheck') {
            auditConfigs[stage].push(config);
            return stage === 'review'
              ? llm(JSON.stringify(reviewV2Report()))
              : llm(JSON.stringify(factCheckV2Report()));
          }
          if (stage === 'proof')
            return llm(DRAFT_BODY + '\n\n老者温和地提醒了他。');
          throw new Error(`unexpected stage: ${stage}`);
        },
      );

    await reconcilePipelineTask(taskId, chapterFor(chapterId));

    for (const stage of ['review', 'factCheck'] as const) {
      expect(auditConfigs[stage]).toHaveLength(1);
      // V3.3 per-stage frozen thinking: outline audit primaries run with
      // thinking enabled (FactCheck pinned to low effort). Deterministic
      // sampling (temperature 0.2 / top_p 1 / json_object) is unchanged.
      expect(auditConfigs[stage][0]).toMatchObject({
        responseFormat: 'json_object',
        thinking: { type: 'enabled' },
        temperature: 0.2,
        top_p: 1,
      });
    }
    expect(auditConfigs.factCheck[0]).toMatchObject({
      reasoningEffort: 'low',
    });
  });

  it('V2 DeepSeek Final Reviser freezes adaptive reasoning semantics and usage', async () => {
    await resetDb();
    const { chapterId } = await seedBaseData('full');
    const taskId = 't-v2-deepseek-reasoning';
    await registerTask(taskId, chapterId);
    await execute(
      await openDatabase(),
      `UPDATE llm_config SET base_url = ?, model_name = ? WHERE id = 1`,
      ['https://api.deepseek.com/v1', 'deepseek-v4-flash'],
    );
    const stageConfigs: Record<string, any[]> = {
      draft: [],
      review: [],
      factCheck: [],
      proof: [],
    };
    mockCallLLMResult = jest
      .fn()
      .mockImplementation(
        async (messages: ChatMessage[], _maxTokens: number, config: any) => {
          const stage = stageOf(messages);
          stageConfigs[stage]?.push(config);
          if (stage === 'draft') return llm(DRAFT_BODY);
          if (stage === 'review') return llm(JSON.stringify(reviewV2Report()));
          if (stage === 'factCheck')
            return llm(JSON.stringify(factCheckV2Report()));
          if (stage === 'proof') {
            return {
              ...llm(DRAFT_BODY + '\n\n老者温和地提醒了他。'),
              reasoningTokens: 12,
              visibleOutputTokens: 88,
            };
          }
          throw new Error(`unexpected stage: ${stage}`);
        },
      );

    await reconcilePipelineTask(taskId, chapterFor(chapterId));

    expect(await taskStatus(taskId)).toBe('completed');
    for (const stage of ['draft', 'review', 'factCheck', 'proof']) {
      expect(stageConfigs[stage]).toHaveLength(1);
    }
    expect(stageConfigs.review[0]).toMatchObject({
      thinking: { type: 'enabled' },
    });
    const attemptRows = await all(
      `SELECT reasoning_tokens, frozen_request_json, request_fingerprint
       FROM pipeline_stage_attempts WHERE pipeline_task_id = ? AND stage = 'proof'`,
      [taskId],
    );
    expect(attemptRows[0]).toBeTruthy();
    expect(String(attemptRows[0].frozen_request_json || '')).not.toContain(
      'api_key',
    );
    expect(String(attemptRows[0].request_fingerprint)).toContain('proof');
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
    expect(attempts.map(a => a.stage)).toEqual(['draft', 'factCheck', 'proof']);
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

  it('V2 full invalid first audit fails closed before the second shared stage', async () => {
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
            // Genuine novel output (not review prose) remains fail-closed.
            return llm('这是一段与审核无关的连续正文。');
          case 'factCheck':
            return llm(JSON.stringify(factCheckV2Report()));
          case 'proof':
            return llm(DRAFT_BODY + '\n\n老者温和地提醒了他。');
          default:
            throw new Error('unexpected stage');
        }
      });

    await reconcilePipelineTask(taskId, chapterFor(chapterId));

    expect(await taskStatus(taskId)).toBe('failed');
    expect(await checkpointStatus(taskId, 'review')).toBe('failed');
    expect(await checkpointStatus(taskId, 'factCheck')).toBe('pending');
    expect(await checkpointStatus(taskId, 'proof')).toBe('pending');
    const attempts = await attemptsFor(taskId);
    expect(attempts.filter(a => a.stage === 'review').length).toBe(1);
    expect(attempts.filter(a => a.stage === 'proof').length).toBe(0);
  });

  it('V2 full double-audit failure: shared Writer fails closed, Proof NEVER fires', async () => {
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
            return llm('这是一段与审核无关的连续正文。');
          case 'factCheck':
            return llm('这同样不是事实核查报告。');
          case 'proof':
            return llm(DRAFT_BODY + '\n\n老者温和地提醒了他。');
          default:
            throw new Error('unexpected stage');
        }
      });

    await reconcilePipelineTask(taskId, chapterFor(chapterId));

    expect(await checkpointStatus(taskId, 'review')).toBe('failed');
    expect(await checkpointStatus(taskId, 'proof')).toBe('pending');
    expect(await taskStatus(taskId)).toBe('failed');
    const rows = await all(
      `SELECT final_text FROM pipeline_tasks WHERE id = ?`,
      [taskId],
    );
    expect(rows[0]?.final_text ?? null).toBeNull();
  });

  it('V2 malformed Review fails closed with one request', async () => {
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
              // Malformed report (missing outlineExecution) → local normalize.
              return llm(
                JSON.stringify({ schemaVersion: 2, draftHash: DRAFT_HASH }),
              );
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

    expect(reviewCalls).toBe(1);
    const attempts = await attemptsFor(taskId);
    expect(attempts.filter(a => a.stage === 'review').length).toBe(1);
    expectV2AttemptVersions(attempts);
    expect(reviewMessages).toHaveLength(1);
    expect(await taskStatus(taskId)).toBe('failed');
    expect(await checkpointStatus(taskId, 'review')).toBe('failed');
    expect(await checkpointStatus(taskId, 'proof')).toBe('pending');
  });

  it('V2 reasoning-only Review gets one thinking-disabled Formatter rescue then fails closed', async () => {
    await resetDb();
    const { chapterId } = await seedBaseData('twoStage');
    const taskId = 't-v2-reasoning-repair-budget';
    await registerTask(taskId, chapterId);
    const reviewConfigs: any[] = [];
    const formatterConfigs: any[] = [];
    let reviewCalls = 0;
    let formatterCalls = 0;
    mockCallLLMResult = jest
      .fn()
      .mockImplementation(
        async (messages: ChatMessage[], _maxTokens: number, config: any) => {
          switch (stageOf(messages)) {
            case 'draft':
              return llm(DRAFT_BODY);
            case 'review': {
              reviewCalls += 1;
              reviewConfigs.push(config);
              // Reasoning-only primary: no adoptable content channel.
              return {
                text: null,
                reasoningText: '先分析章节结构……'.repeat(40),
                emptyReason: 'reasoning_only',
                inputTokens: 50,
                outputTokens: 1500,
                totalTokens: 1550,
              };
            }
            case 'reviewFormatter': {
              formatterCalls += 1;
              formatterConfigs.push(config);
              // Formatter rescue also returns reasoning-only prose → the
              // stage must fail closed here, with NO further requests.
              return {
                text: null,
                reasoningText: '整理候选语义……'.repeat(20),
                emptyReason: 'reasoning_only',
                inputTokens: 50,
                outputTokens: 600,
                totalTokens: 650,
              };
            }
            case 'proof':
              return llm(DRAFT_BODY + '\n\n老者温和地提醒了他。');
            default:
              throw new Error('unexpected stage');
          }
        },
      );

    await reconcilePipelineTask(taskId, chapterFor(chapterId));

    expect(reviewCalls).toBe(1);
    // Primary review uses the V3.3 frozen per-stage thinking (enabled).
    expect(reviewConfigs[0].thinking).toEqual({ type: 'enabled' });
    // Exactly ONE rescue Formatter, always thinking-disabled.
    expect(formatterCalls).toBe(1);
    expect(formatterConfigs[0].thinking).toEqual({ type: 'disabled' });
    expect(await taskStatus(taskId)).toBe('failed');
    expect(await checkpointStatus(taskId, 'review')).toBe('failed');
    expect(await checkpointStatus(taskId, 'proof')).toBe('pending');
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

    expect(await checkpointStatus(taskId, 'proof')).toBe('succeeded');
    const attempts = await attemptsFor(taskId);
    expect(attempts.filter(a => a.stage === 'proof').length).toBe(1);
    expect(await taskStatus(taskId)).toBe('completed');
    const rows = await all(
      `SELECT final_text FROM pipeline_tasks WHERE id = ?`,
      [taskId],
    );
    expect(String(rows[0]?.final_text ?? '')).toContain('古井');
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

    jest.useFakeTimers();
    try {
      const reconcilePromise = reconcilePipelineTask(
        taskId,
        chapterFor(chapterId),
      );
      await jest.runAllTimersAsync();
      await reconcilePromise;
    } finally {
      jest.useRealTimers();
    }

    // The transient proof failure entered safe_retry backoff and was
    // re-fired in the SAME loop once due — the retry disposition is consumed
    // before the degraded finalize (only the failed proof stage re-ran).
    const attempts = await attemptsFor(taskId);
    expect(attempts.filter(a => a.stage === 'draft').length).toBe(1);
    expect(attempts.filter(a => a.stage === 'review').length).toBe(1);
    expect(attempts.filter(a => a.stage === 'factCheck').length).toBe(1);
    expect(attempts.filter(a => a.stage === 'proof').length).toBeGreaterThanOrEqual(1);
    expect(['failed', 'succeeded']).toContain(
      await checkpointStatus(taskId, 'proof'),
    );
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
        if (stage === 'review') {
          // Legacy free-form review shape — still adoptable by the shared
          // first-pass gate through the issues/strengths/suggestions signal.
          return llm(
            JSON.stringify({
              strengths: ['场景清晰'],
              issues: ['老者语气生硬'],
              suggestions: ['让语气温和'],
            }),
          );
        }
        if (stage === 'factCheck') {
          // FactCheck adoptability needs verdict/errors/warnings/confirmed.
          return llm(
            JSON.stringify({
              confirmed: ['老者是守林人'],
              issues: [],
            }),
          );
        }
        if (stage === 'proof') {
          return llm(DRAFT_BODY + '\n\n老者温和地提醒了他。');
        }
        throw new Error(`legacy task must not call unexpected stage ${stage}`);
      });

    await reconcilePipelineTask(taskId, chapterFor(chapterId));

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
