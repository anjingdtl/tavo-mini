/**
 * V3.2 production state-machine coverage. These tests drive the real
 * reconciler and SQLite repositories; only the provider result is scripted.
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
  __resetForTest,
  __setDatabaseForTest,
  openDatabase,
} from '../src/data/connection/openDatabase';
import { execute } from '../src/data/connection/execute';
import { all } from '../src/data/connection/query';
import { usePipelineTaskStore } from '../src/store/pipelineTaskStore';
import { reconcilePipelineTask } from '../src/services/pipeline/reconcile';
import { savePipelineTask } from '../src/data/repositories/pipelineTaskRepository';
import type { ChatMessage } from '../src/services/llm';
import type { LLMResult } from '../src/services/llm/types';
import type { Chapter } from '../src/types/novel';
import {
  cloneDefaultContextAutomationPolicyV3,
  hashContextAutomationPolicyV3,
} from '../src/services/contextAutomationPolicy';

let mockCallLLMResult: jest.Mock = jest.fn();
let testDb: InMemorySqliteDb | null = null;

const DRAFT_BODY =
  '主角走进了森林，在林间小径上遇到了守林的老者。\n\n老者警告他不要靠近古井，说那口井十年前就干涸了。';

const REVIEW_COVERAGE = [
  'opening_continuity',
  'outline_execution',
  'character',
  'prose',
  'ending_boundary',
];

function reviewV32(overrides: Record<string, unknown> = {}): object {
  return {
    verdict: 'pass',
    findings: [],
    outlineAssessment: {
      fulfilled: ['抵达森林'],
      missing: [],
      deviations: [],
      premature: [],
      endingAssessment: '停在守林人警告之后。',
    },
    coverage: { checkedDimensions: REVIEW_COVERAGE },
    ...overrides,
  };
}

function factCheckV32(overrides: Record<string, unknown> = {}): object {
  return {
    verdict: 'pass',
    findings: [],
    confirmedFactRefs: [],
    coverage: {
      checkedDimensions: [
        'timeline',
        'character_state',
        'object_state',
        'world_rule',
        'spatial_logic',
        'knowledge_boundary',
        'outline_boundary',
      ],
      checkedFactRefs: [],
    },
    ...overrides,
  };
}

function briefV32(): object {
  return {
    verdict: 'no_changes',
    instructions: [],
    openingContinuity: ['保持上一段的森林与守林人衔接。'],
    styleAdvisories: [],
  };
}

function llm(text: string | null, options: Partial<LLMResult> = {}): LLMResult {
  return {
    text,
    reasoningText: null,
    finishReason: 'stop',
    inputTokens: 50,
    outputTokens: 100,
    totalTokens: 150,
    ...options,
  };
}

function stageOf(messages: ChatMessage[]): string {
  const body = messages
    .map(message => String(message.content ?? ''))
    .join('\n');
  if (body.includes('你是初稿作者')) return 'draft';
  if (body.includes('V3.2 的文学评估器') || body.includes('当前阶段：Review')) {
    return 'review';
  }
  if (body.includes('当前统一流水线的 Review')) return 'review';
  if (
    body.includes('V3.2 的事实核查器') ||
    body.includes('当前阶段：FactCheck')
  ) {
    return 'factCheck';
  }
  if (body.includes('当前统一流水线的 FactCheck')) return 'factCheck';
  if (body.includes('V3.2 Brief Compiler')) return 'brief';
  if (body.includes('当前统一流水线的 Brief Compiler')) return 'brief';
  if (
    body.includes('你是终稿修订员') ||
    body.includes('你是终审校对员') ||
    body.includes('小说终稿编辑')
  ) {
    return 'proof';
  }
  return 'unknown';
}

async function resetDb(): Promise<void> {
  __resetForTest();
  testDb = await createCanonInMemoryDb();
  __setDatabaseForTest(testDb as any);
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
     VALUES (1, 'm', 'https://api.deepseek.com/v1', 'k',
             'deepseek-v4-flash', 1, 'openai_compatible', 8000, 4000)`,
  );
  await execute(
    await openDatabase(),
    `INSERT INTO projects (id, name, mode, created_at, updated_at)
     VALUES (1, 'p', 'outline', 't', 't')`,
  );
  const chapterResult = await execute(
    await openDatabase(),
    `INSERT INTO chapters
       (project_id, position, title, synopsis, content, status, created_at, updated_at)
     VALUES (1, 0, '第1章', '梗概', '', 'draft', 't', 't')`,
  );
  return { chapterId: chapterResult.insertId as number };
}

async function registerTask(
  taskId: string,
  chapterId: number,
  versions: { outlineWorkflowVersion: number; contextBudgetVersion: number } = {
    outlineWorkflowVersion: 3,
    contextBudgetVersion: 4,
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
    `SELECT stage, attempt_no, request_version, formatter_used, response_candidate_temp
       FROM pipeline_stage_attempts
      WHERE pipeline_task_id = ? ORDER BY rowid ASC`,
    [taskId],
  );
}

async function taskStatus(taskId: string): Promise<string> {
  const rows = await all(
    'SELECT status, error FROM pipeline_tasks WHERE id = ?',
    [taskId],
  );
  if (rows[0]?.error) {
    console.log('V3.2 task error', taskId, String(rows[0].error));
  }
  return String(rows[0]?.status || 'missing');
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
  return String(rows[0]?.status || 'missing');
}

afterEach(() => {
  __resetForTest();
  if (testDb) {
    testDb.close();
    testDb = null;
  }
});

describe('V3.2 production structured-stage recovery', () => {
  jest.setTimeout(90_000);

  test('full path uses one primary call per structured stage with enabled + low Thinking', async () => {
    await resetDb();
    const { chapterId } = await seedBaseData('full');
    const taskId = 't-v32-happy';
    await registerTask(taskId, chapterId);
    const configs: Record<string, any[]> = {
      review: [],
      factCheck: [],
      brief: [],
    };
    mockCallLLMResult = jest
      .fn()
      .mockImplementation(
        async (messages: ChatMessage[], _maxTokens: number, config: any) => {
          const stage = stageOf(messages);
          configs[stage]?.push(config);
          if (stage === 'draft') return llm(DRAFT_BODY);
          if (stage === 'review') return llm(JSON.stringify(reviewV32()));
          if (stage === 'factCheck') return llm(JSON.stringify(factCheckV32()));
          if (stage === 'brief') return llm(JSON.stringify(briefV32()));
          if (stage === 'proof')
            return llm(DRAFT_BODY + '\n\n老者温和地提醒了他。');
          throw new Error('unexpected stage: ' + stage);
        },
      );

    await reconcilePipelineTask(taskId, chapterFor(chapterId));

    expect(await taskStatus(taskId)).toBe('completed');
    const attempts = await attemptsFor(taskId);
    expect(attempts.map(row => row.stage).sort()).toEqual([
      'brief',
      'draft',
      'factCheck',
      'proof',
      'review',
    ]);
    for (const row of attempts.filter(item => item.stage !== 'draft')) {
      expect(Number(row.request_version)).toBe(32);
      expect(row.response_candidate_temp).toBeNull();
    }
    for (const stage of ['review', 'factCheck', 'brief']) {
      expect(configs[stage]).toHaveLength(1);
      expect(configs[stage][0]).toMatchObject({
        thinking: { type: 'enabled' },
        reasoningEffort: 'low',
      });
    }
    expect(await checkpointStatus(taskId, 'brief')).toBe('succeeded');
  });

  test('content-only malformed Review invokes exactly one disabled-Thinking Formatter', async () => {
    await resetDb();
    const { chapterId } = await seedBaseData('twoStage');
    const taskId = 't-v32-content-formatter';
    await registerTask(taskId, chapterId);
    const calls: Array<{
      stage: string;
      formatter: boolean;
      maxTokens: number;
      config: any;
    }> = [];
    let reviewCalls = 0;
    mockCallLLMResult = jest
      .fn()
      .mockImplementation(
        async (messages: ChatMessage[], maxTokens: number, config: any) => {
          const stage = stageOf(messages);
          const body = messages
            .map(message => String(message.content ?? ''))
            .join('\n');
          calls.push({
            stage,
            formatter: body.includes('Audit Formatter'),
            maxTokens,
            config,
          });
          if (stage === 'draft') return llm(DRAFT_BODY);
          if (stage === 'review') {
            reviewCalls += 1;
            return reviewCalls === 1
              ? llm(JSON.stringify({ verdict: 'pass', findings: [] }))
              : llm(JSON.stringify(reviewV32()));
          }
          if (stage === 'factCheck') return llm(JSON.stringify(factCheckV32()));
          if (stage === 'brief') return llm(JSON.stringify(briefV32()));
          if (stage === 'proof')
            return llm(DRAFT_BODY + '\n\n老者温和地提醒了他。');
          throw new Error('unexpected stage: ' + stage);
        },
      );

    await reconcilePipelineTask(taskId, chapterFor(chapterId));

    expect(await taskStatus(taskId)).toBe('completed');
    const reviewCallsSeen = calls.filter(call => call.stage === 'review');
    expect(reviewCallsSeen).toHaveLength(2);
    expect(reviewCallsSeen.filter(call => call.formatter)).toHaveLength(1);
    expect(reviewCallsSeen[1].config).toMatchObject({
      thinking: { type: 'disabled' },
    });
    expect(reviewCallsSeen[1].maxTokens).toBeGreaterThan(1536);
    expect(reviewCallsSeen[1].maxTokens).toBeLessThanOrEqual(4096);
    const attempts = await attemptsFor(taskId);
    expect(attempts.filter(row => row.stage === 'review')).toHaveLength(2);
    expect(
      attempts.filter(
        row => row.stage === 'review' && Number(row.formatter_used) === 1,
      ),
    ).toHaveLength(1);
    expect(
      attempts
        .filter(row => row.stage === 'review')
        .every(row => row.response_candidate_temp == null),
    ).toBe(true);
  });

  test('complete reasoning-only candidate is adopted locally without primary replay or Formatter', async () => {
    await resetDb();
    const { chapterId } = await seedBaseData('twoStage');
    const taskId = 't-v32-reasoning-only';
    await registerTask(taskId, chapterId);
    const calls: Array<{ stage: string; formatter: boolean }> = [];
    mockCallLLMResult = jest
      .fn()
      .mockImplementation(async (messages: ChatMessage[]) => {
        const stage = stageOf(messages);
        const body = messages
          .map(message => String(message.content ?? ''))
          .join('\n');
        calls.push({ stage, formatter: body.includes('Audit Formatter') });
        if (stage === 'draft') return llm(DRAFT_BODY);
        if (stage === 'review') {
          return llm(null, {
            reasoningText: JSON.stringify(reviewV32()),
            emptyReason: 'reasoning_only',
          });
        }
        if (stage === 'factCheck') return llm(JSON.stringify(factCheckV32()));
        if (stage === 'brief') return llm(JSON.stringify(briefV32()));
        if (stage === 'proof')
          return llm(DRAFT_BODY + '\n\n老者温和地提醒了他。');
        throw new Error('unexpected stage: ' + stage);
      });

    await reconcilePipelineTask(taskId, chapterFor(chapterId));

    expect(await taskStatus(taskId)).toBe('completed');
    expect(calls.filter(call => call.stage === 'review')).toEqual([
      { stage: 'review', formatter: false },
    ]);
    expect(
      (await attemptsFor(taskId)).filter(row => row.stage === 'review'),
    ).toHaveLength(1);
  });

  test('unparseable reasoning-only response uses one Formatter without primary replay', async () => {
    await resetDb();
    const { chapterId } = await seedBaseData('twoStage');
    const taskId = 't-v32-reasoning-formatter';
    await registerTask(taskId, chapterId);
    const calls: Array<{ stage: string; formatter: boolean }> = [];
    mockCallLLMResult = jest
      .fn()
      .mockImplementation(async (messages: ChatMessage[]) => {
        const stage = stageOf(messages);
        const body = messages
          .map(message => String(message.content ?? ''))
          .join('\n');
        const formatter = body.includes('Audit Formatter');
        calls.push({ stage, formatter });
        if (stage === 'draft') return llm(DRAFT_BODY);
        if (stage === 'review') {
          return formatter
            ? llm(JSON.stringify(reviewV32()))
            : llm(null, {
                reasoningText: '我已完成审阅，但这里没有可直接解析的 JSON。',
                emptyReason: 'reasoning_only',
              });
        }
        if (stage === 'factCheck') return llm(JSON.stringify(factCheckV32()));
        if (stage === 'brief') return llm(JSON.stringify(briefV32()));
        if (stage === 'proof')
          return llm(DRAFT_BODY + '\n\n老者温和地提醒了他。');
        throw new Error('unexpected stage: ' + stage);
      });

    await reconcilePipelineTask(taskId, chapterFor(chapterId));

    expect(await taskStatus(taskId)).toBe('completed');
    expect(calls.filter(call => call.stage === 'review')).toEqual([
      { stage: 'review', formatter: false },
      { stage: 'review', formatter: true },
    ]);
    expect(
      (await attemptsFor(taskId)).filter(row => row.stage === 'review'),
    ).toHaveLength(2);
    expect(
      (await attemptsFor(taskId)).filter(
        row => row.stage === 'review' && Number(row.formatter_used) === 1,
      ),
    ).toHaveLength(1);
  });

  test('content_filter never invokes Formatter and remains fail-closed', async () => {
    await resetDb();
    const { chapterId } = await seedBaseData('twoStage');
    const taskId = 't-v32-content-filter';
    await registerTask(taskId, chapterId);
    const calls: string[] = [];
    mockCallLLMResult = jest
      .fn()
      .mockImplementation(async (messages: ChatMessage[]) => {
        const stage = stageOf(messages);
        calls.push(
          stage +
            ':' +
            messages
              .map(message => String(message.content ?? ''))
              .join('\n')
              .includes('Audit Formatter'),
        );
        if (stage === 'draft') return llm(DRAFT_BODY);
        if (stage === 'review') {
          return llm(null, { finishReason: 'content_filter' });
        }
        throw new Error('unexpected stage: ' + stage);
      });

    await reconcilePipelineTask(taskId, chapterFor(chapterId));

    expect(await taskStatus(taskId)).toBe('failed');
    expect(calls.filter(value => value.startsWith('review:'))).toEqual([
      'review:false',
    ]);
    expect(
      (await attemptsFor(taskId)).filter(row => row.stage === 'review'),
    ).toHaveLength(1);
    expect(
      (await attemptsFor(taskId)).filter(row => row.stage === 'proof'),
    ).toHaveLength(0);
  });

  test('Formatter that remains invalid fails the stage without a second primary call', async () => {
    await resetDb();
    const { chapterId } = await seedBaseData('twoStage');
    const taskId = 't-v32-formatter-fails';
    await registerTask(taskId, chapterId);
    let reviewCalls = 0;
    mockCallLLMResult = jest
      .fn()
      .mockImplementation(async (messages: ChatMessage[]) => {
        const stage = stageOf(messages);
        if (stage === 'draft') return llm(DRAFT_BODY);
        if (stage === 'review') {
          reviewCalls += 1;
          return llm(JSON.stringify({ verdict: 'pass', findings: [] }));
        }
        throw new Error('unexpected stage: ' + stage);
      });

    await reconcilePipelineTask(taskId, chapterFor(chapterId));

    expect(await taskStatus(taskId)).toBe('failed');
    expect(reviewCalls).toBe(2);
    const attempts = (await attemptsFor(taskId)).filter(
      row => row.stage === 'review',
    );
    expect(attempts).toHaveLength(2);
    expect(Number(attempts[1].formatter_used)).toBe(1);
    expect(
      (await attemptsFor(taskId)).filter(row => row.stage === 'proof'),
    ).toHaveLength(0);
  });

  test('current V4 + Budget V5 freezes one elastic reservation for all five calls', async () => {
    await resetDb();
    const { chapterId } = await seedBaseData('full');
    await execute(
      await openDatabase(),
      `UPDATE llm_config SET context_window = 1000000, max_output_tokens = 200000 WHERE id = 1`,
    );
    // Deliberately polluted historical settings must not affect a V5 snapshot.
    for (const [key, value] of [
      ['pipeline_draft_max_tokens', '100000'],
      ['pipeline_review_max_tokens', '30000'],
      ['pipeline_factcheck_max_tokens', '30000'],
      ['pipeline_proof_max_tokens', '40000'],
    ]) {
      await execute(
        await openDatabase(),
        `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
        [key, value],
      );
    }
    await execute(
      await openDatabase(),
      `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
      ['pipeline_reasoning_effort', 'max'],
    );
    const taskId = 't-v5-independent-reservation';
    await registerTask(taskId, chapterId, {
      outlineWorkflowVersion: 4,
      contextBudgetVersion: 5,
    });
    const calls: Array<{
      stage: string;
      maxTokens: number;
      reasoningEffort?: string;
    }> = [];
    mockCallLLMResult = jest
      .fn()
      .mockImplementation(async (messages: ChatMessage[], maxTokens: number, config?: { reasoningEffort?: string }) => {
        const stage = stageOf(messages);
        calls.push({ stage, maxTokens, reasoningEffort: config?.reasoningEffort });
        if (stage === 'draft') return llm(DRAFT_BODY);
        if (stage === 'review') {
          return llm(
            JSON.stringify({
              verdict: 'pass',
              checked: REVIEW_COVERAGE,
              findings: [],
            }),
          );
        }
        if (stage === 'factCheck') {
          return llm(
            JSON.stringify({
              verdict: 'pass',
              checked: [
                'timeline',
                'character_state',
                'object_state',
                'world_rule',
                'spatial_logic',
                'knowledge_boundary',
                'outline_boundary',
              ],
              findings: [],
            }),
          );
        }
        if (stage === 'brief') {
          return llm(
            JSON.stringify({
              strategy: '保持森林与守林人的衔接。',
              actions: [],
              preserve: [],
              ending: '停在守林人的警告之后。',
            }),
          );
        }
        if (stage === 'proof') return llm(DRAFT_BODY + '\n\n老者点了点头。');
        throw new Error('unexpected stage: ' + stage);
      });

    await reconcilePipelineTask(taskId, chapterFor(chapterId));

    expect(await taskStatus(taskId)).toBe('completed');
    expect(calls.map(call => call.stage)).toEqual([
      'draft',
      'review',
      'factCheck',
      'brief',
      'proof',
    ]);
    expect(calls.map(call => call.maxTokens)).toEqual([
      200000,
      200000,
      200000,
      200000,
      200000,
    ]);
    expect(calls.map(call => call.reasoningEffort)).toEqual([
      'max',
      'max',
      'low',
      'max',
      'max',
    ]);
    const rows = await all(
      'SELECT pipeline_context_json FROM pipeline_tasks WHERE id = ?',
      [taskId],
    );
    const execution = JSON.parse(String(rows[0].pipeline_context_json)).execution;
    expect(execution.contextBudgetVersion).toBe(5);
    expect(execution.stageBudgets).toHaveLength(5);
    expect(execution.stageBudgets.map((item: any) => item.requestMaxTokens)).toEqual([
      200000,
      200000,
      200000,
      200000,
      200000,
    ]);
    expect(execution.stageBudgets.map((item: any) => item.visibleOutputFloor)).toEqual([
      4000,
      1500,
      1500,
      1200,
      5000,
    ]);
  });

  test('current V4 + Budget V6 freezes the exact V3 policy into the execution snapshot', async () => {
    await resetDb();
    const { chapterId } = await seedBaseData('full');
    await execute(
      await openDatabase(),
      `UPDATE llm_config SET context_window = 1000000, max_output_tokens = 200000 WHERE id = 1`,
    );
    const policy = cloneDefaultContextAutomationPolicyV3();
    policy.boards.resources.priority = 99;
    const taskId = 't-v6-policy-freeze';
    await registerTask(taskId, chapterId, {
      outlineWorkflowVersion: 4,
      contextBudgetVersion: 6,
    });
    mockCallLLMResult = jest
      .fn()
      .mockImplementation(async (messages: ChatMessage[]) => {
        const stage = stageOf(messages);
        if (stage === 'draft') return llm(DRAFT_BODY);
        if (stage === 'review') {
          return llm(
            JSON.stringify({
              verdict: 'pass',
              checked: REVIEW_COVERAGE,
              findings: [],
            }),
          );
        }
        if (stage === 'factCheck') {
          return llm(
            JSON.stringify({
              verdict: 'pass',
              checked: [
                'timeline',
                'character_state',
                'object_state',
                'world_rule',
                'spatial_logic',
                'knowledge_boundary',
                'outline_boundary',
              ],
              findings: [],
            }),
          );
        }
        if (stage === 'brief') {
          return llm(
            JSON.stringify({
              strategy: '保持森林与守林人的衔接。',
              actions: [],
              preserve: [],
              ending: '停在守林人的警告之后。',
            }),
          );
        }
        if (stage === 'proof') return llm(DRAFT_BODY + '\n\n老者点了点头。');
        throw new Error('unexpected stage: ' + stage);
      });

    await reconcilePipelineTask(taskId, chapterFor(chapterId), {
      contextAutomationPolicyV3: policy,
    });

    expect(await taskStatus(taskId)).toBe('completed');
    const rows = await all(
      'SELECT pipeline_context_json FROM pipeline_tasks WHERE id = ?',
      [taskId],
    );
    const execution = JSON.parse(String(rows[0].pipeline_context_json)).execution;
    expect(execution.contextBudgetVersion).toBe(6);
    expect(execution.contextAutomationPolicyVersion).toBe('context-automation-v3');
    expect(execution.contextAutomationPolicyHash).toBe(
      hashContextAutomationPolicyV3(policy),
    );
    expect(execution.contextAutomationPolicySnapshot).toEqual(policy);
  });
});
