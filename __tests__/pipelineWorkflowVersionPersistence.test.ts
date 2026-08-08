/**
 * Pipeline workflow version persistence (§4.3 authority order).
 *
 * The execution snapshot is the single authority once frozen; before that
 * the task ROW version columns decide; unparseable/missing rows fail closed
 * to Legacy (V1). Resume never re-derives versions from live defaults.
 *
 * Real reconcile integration: the frozen snapshot inside
 * pipeline_context_json must carry the task row versions.
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

const DRAFT_BODY = '主角走进了森林，在林间小径上遇到了守林的老者。';
const HASH = require('../src/services/pipeline/revisionAnchors').computeDraftHash(
  require('../src/services/pipeline/revisionAnchors').canonicalizeDraft(DRAFT_BODY),
);

function llm(text: string): LLMResult {
  return {
    text,
    reasoningText: null,
    finishReason: 'stop',
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
  };
}

function stageOf(messages: ChatMessage[]): string {
  const allText = messages.map(m => String(m.content ?? '')).join('\n');
  if (allText.includes('你是初稿作者')) return 'draft';
  if (allText.includes('你是小说终审前的审阅编辑')) return 'review';
  if (allText.includes('可定位、可执行的修正合同')) return 'factCheck';
  if (allText.includes('你是终稿修订员')) return 'proof';
  return 'unknown';
}

function happyMock() {
  return jest.fn().mockImplementation(async (messages: ChatMessage[]) => {
    const stage = stageOf(messages);
    if (stage === 'draft') return llm(DRAFT_BODY);
    if (stage === 'review') {
      return llm(
        JSON.stringify({
          schemaVersion: 2,
          draftHash: HASH,
          requiredCorrections: [],
          protectedAnchorIds: [],
          outlineExecution: {
            fulfilledBeats: [],
            missingBeats: [],
            deviations: [],
            prematureBeats: [],
            mustPreserve: [],
            endingGoal: 'x',
            mustNotAdvance: [],
          },
        }),
      );
    }
    if (stage === 'factCheck') {
      return llm(
        JSON.stringify({
          schemaVersion: 2,
          draftHash: HASH,
          requiredCorrections: [],
          protectedFacts: [],
          hardConstraints: [],
        }),
      );
    }
    if (stage === 'proof') return llm(DRAFT_BODY + '\n\n老者点了点头。');
    throw new Error(`unexpected stage ${stage}`);
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
  versions: { outlineWorkflowVersion?: number | null; contextBudgetVersion?: number | null },
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
    outlineWorkflowVersion: versions.outlineWorkflowVersion ?? null,
    contextBudgetVersion: versions.contextBudgetVersion ?? null,
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
    outlineWorkflowVersion: versions.outlineWorkflowVersion ?? null,
    contextBudgetVersion: versions.contextBudgetVersion ?? null,
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

async function frozenExecution(
  taskId: string,
): Promise<{ outlineWorkflowVersion?: number; contextBudgetVersion?: number } | null> {
  const rows = await all(
    `SELECT pipeline_context_json FROM pipeline_tasks WHERE id = ?`,
    [taskId],
  );
  const json = rows[0]?.pipeline_context_json;
  if (!json) return null;
  const parsed = JSON.parse(String(json));
  return parsed?.execution ?? null;
}

describe('workflow version persistence (§4.3)', () => {
  jest.setTimeout(60_000);

  it('V2 task row versions are frozen into the execution snapshot', async () => {
    await resetDb();
    const { chapterId } = await seedBaseData('twoStage');
    const taskId = 't-persist-v2';
    await registerTask(taskId, chapterId, {
      outlineWorkflowVersion: 2,
      contextBudgetVersion: 2,
    });
    mockCallLLMResult = happyMock();

    await reconcilePipelineTask(taskId, chapterFor(chapterId));

    const execution = await frozenExecution(taskId);
    expect(execution?.outlineWorkflowVersion).toBe(2);
    expect(execution?.contextBudgetVersion).toBe(2);
  });

  it('legacy task row (1) freezes Legacy semantics (no V2 fields)', async () => {
    await resetDb();
    const { chapterId } = await seedBaseData('twoStage');
    const taskId = 't-persist-v1';
    await registerTask(taskId, chapterId, {
      outlineWorkflowVersion: 1,
      contextBudgetVersion: 1,
    });
    mockCallLLMResult = jest.fn().mockImplementation(async (messages: ChatMessage[]) => {
      const stage = stageOf(messages);
      if (stage === 'draft') return llm(DRAFT_BODY);
      if (stage === 'review') {
        return llm(
          JSON.stringify({
            strengths: ['场景清晰'],
            issues: [],
            suggestions: [],
          }),
        );
      }
      if (stage === 'proof' || messages.map(m => String(m.content ?? '')).join('\n').includes('你是终审校对员')) {
        return llm(DRAFT_BODY + '\n\n老者点了点头。');
      }
      throw new Error(`legacy unexpected ${stage}`);
    });

    await reconcilePipelineTask(taskId, chapterFor(chapterId));

    const execution = await frozenExecution(taskId);
    // Legacy rows freeze the version explicitly as 1 (Legacy semantics).
    expect(execution?.outlineWorkflowVersion).toBe(1);
    expect(execution?.contextBudgetVersion).toBe(1);
  });

  it('missing row versions fail closed to Legacy (1)', async () => {
    await resetDb();
    const { chapterId } = await seedBaseData('noReview');
    const taskId = 't-persist-null';
    // Row versions absent (NULL) — e.g. rows written by a pre-44 build.
    await registerTask(taskId, chapterId, {
      outlineWorkflowVersion: null,
      contextBudgetVersion: null,
    });
    mockCallLLMResult = happyMock();

    await reconcilePipelineTask(taskId, chapterFor(chapterId));

    const execution = await frozenExecution(taskId);
    // Missing row versions fail closed to an explicit Legacy freeze (1).
    expect(execution?.outlineWorkflowVersion).toBe(1);
    expect(execution?.contextBudgetVersion).toBe(1);
  });

  it('resume NEVER re-derives versions from the row after freeze', async () => {
    await resetDb();
    const { chapterId } = await seedBaseData('twoStage');
    const taskId = 't-persist-resume';
    await registerTask(taskId, chapterId, {
      outlineWorkflowVersion: 2,
      contextBudgetVersion: 2,
    });
    mockCallLLMResult = happyMock();

    await reconcilePipelineTask(taskId, chapterFor(chapterId));
    const execution = await frozenExecution(taskId);
    expect(execution?.outlineWorkflowVersion).toBe(2);

    // Simulate a hostile drift: someone rewrites the ROW columns to 1.
    await execute(
      await openDatabase(),
      `UPDATE pipeline_tasks SET outline_workflow_version = 1, context_budget_version = 1 WHERE id = ?`,
      [taskId],
    );
    // Resume must keep the frozen snapshot (V2) — a no-op reconcile.
    await reconcilePipelineTask(taskId, chapterFor(chapterId));
    const execution2 = await frozenExecution(taskId);
    expect(execution2?.outlineWorkflowVersion).toBe(2);
    expect(execution2?.contextBudgetVersion).toBe(2);
  });
});
