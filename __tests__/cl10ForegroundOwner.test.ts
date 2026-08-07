/**
 * CL-10: Foreground owner 调用级状态（修复前稳定失败测试）。
 *
 * 修复前 reconcile.ts 用模块级 `let activeForegroundOwner` —— 单章 Task A
 * 与 Batch Task B 并发时互相污染通知所有权。
 *
 * 修复后 foregroundOwner 是 ReconcileOptions 的调用级字段。本测试：
 *   1. 结构守卫：reconcile.ts 不再存在模块级可变 foreground 状态
 *   2. 行为验证：并发驱动真实 reconcile（task + batch 各一），batch 任务的
 *      PipelineForeground 调用必须零发生，task 任务的通知不受影响
 */
jest.mock('../src/services/llm', () => {
  const actual = jest.requireActual('../src/services/llm');
  return {
    ...actual,
    callLLMResult: (...args: unknown[]) => mockCallLLMResult(...args),
  };
});

import fs from 'fs';
import path from 'path';
import { createCanonInMemoryDb } from './helpers/canonInMemoryDb';
import type { InMemorySqliteDb } from './helpers/canonInMemoryDb';
import {
  __setDatabaseForTest,
  __resetForTest,
  openDatabase,
} from '../src/data/connection/openDatabase';
import { execute } from '../src/data/connection/execute';
import { usePipelineTaskStore } from '../src/store/pipelineTaskStore';
import { reconcilePipelineTask } from '../src/services/pipeline/reconcile';
import { savePipelineTask } from '../src/data/repositories/pipelineTaskRepository';
import { PipelineForeground } from '../src/native/PipelineForegroundModule';
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
      /* ignore */
    }
    testDb = null;
  }
});

describe('CL-10: foreground owner 调用级状态', () => {
  jest.setTimeout(60_000);

  it('reconcile.ts 不再存在模块级可变 foreground 状态（结构守卫）', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'services', 'pipeline', 'reconcile.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/let\s+activeForegroundOwner/);
    // 调用级字段必须存在于 ReconcileOptions。
    expect(source).toMatch(/foregroundOwner\??:\s*'(task|batch)'/);
  });

  it('pipelineRunner 把调用级 foregroundOwner 透传给 reconcile', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'services', 'pipelineRunner.ts'),
      'utf8',
    );
    const matches = source.match(/foregroundOwner:\s*options\.foregroundOwner/g);
    expect(matches?.length ?? 0).toBe(2);
  });

  it('行为：task 与 batch 并发不互相污染通知所有权', async () => {
    await resetDb();
    await execute(
      await openDatabase(),
      `INSERT INTO settings (key, value) VALUES ('pipeline_mode', 'noReview')`,
    );
    await execute(
      await openDatabase(),
      `INSERT INTO llm_config (id, name, base_url, api_key, model_name, is_active, provider_type, context_window, max_output_tokens)
       VALUES (1, 'm', 'http://127.0.0.1:9/v1', 'k', 'mm', 1, 'openai_compatible', 8000, 4000)`,
    );
    await execute(
      await openDatabase(),
      `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
    );

    const r1 = await execute(
      await openDatabase(),
      `INSERT INTO chapters (project_id, position, title, synopsis, content, status, created_at, updated_at)
       VALUES (1, 0, 'A', 's', '', 'draft', 't', 't')`,
    );
    const r2 = await execute(
      await openDatabase(),
      `INSERT INTO chapters (project_id, position, title, synopsis, content, status, created_at, updated_at)
       VALUES (1, 1, 'B', 's', '', 'draft', 't', 't')`,
    );

    const now = Date.now();
    const r1Id = Number(r1.insertId);
    const r2Id = Number(r2.insertId);
    for (const [taskId, chapterId] of [
      ['t-task-a', r1Id],
      ['t-batch-b', r2Id],
    ] as Array<[string, number]>) {
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
        createdAt: now,
        updatedAt: now,
        resolvedAt: null,
      });
    }

    mockCallLLMResult = jest.fn().mockImplementation(async () => ({
      text: '正文',
      inputTokens: 100,
      outputTokens: 100,
      totalTokens: 200,
      emptyReason: null,
    }));

    const chapterA: Chapter = {
      id: r1Id,
      project_id: 1,
      position: 0,
      title: 'A',
      synopsis: 's',
      content: '',
      status: 'draft',
      summary_json: null,
      created_at: 't',
      updated_at: 't',
    };
    const chapterB: Chapter = {
      id: r2Id,
      project_id: 1,
      position: 1,
      title: 'B',
      synopsis: 's',
      content: '',
      status: 'draft',
      summary_json: null,
      created_at: 't',
      updated_at: 't',
    };

    // 启用桥接（生产由 settingsStore 打开），让 start 真正打到 NativeModules。
    PipelineForeground.setEnabled(true);
    const RN = require('react-native');
    const foregroundMock = RN.NativeModules.PipelineForeground;
    foregroundMock.start.mockClear();
    foregroundMock.updateProgress.mockClear();
    foregroundMock.notifyComplete.mockClear();
    foregroundMock.notifyFailed.mockClear();
    foregroundMock.stop.mockClear();

    await Promise.all([
      reconcilePipelineTask('t-task-a', chapterA, {
        foregroundOwner: 'task',
      }),
      reconcilePipelineTask('t-batch-b', chapterB, {
        foregroundOwner: 'batch',
      }),
    ]);

    // task 任务：PipelineForeground.start 必须真实发生。
    const taskStarts = foregroundMock.start.mock.calls.filter(
      (args: string[]) => args[0] === 't-task-a',
    );
    expect(taskStarts.length).toBeGreaterThan(0);

    // batch 任务：通知/进度类调用必须被抑制（零调用）。stop 是资源清理
    // 语义（清理自己 taskId 的服务），不受 owner 门控，允许发生。
    const batchNotifCalls = [
      ...foregroundMock.start.mock.calls,
      ...foregroundMock.updateProgress.mock.calls,
      ...foregroundMock.notifyComplete.mock.calls,
      ...foregroundMock.notifyFailed.mock.calls,
    ].filter((args: string[]) => args[0] === 't-batch-b');
    expect(batchNotifCalls).toHaveLength(0);
  });
});
