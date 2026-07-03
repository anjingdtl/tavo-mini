/* eslint-env jest */

// Regression: V2.2.0 之前，App 冷启动后没有任何机制清理上次挂掉时遗留的
// status='running'/'drafting' 任务，导致流水线任务卡死、UI 显示"创作初稿 0/4 阶段 · 1s"
// 但用户无法继续或取消。
//
// V2.2.2 修复：App 启动时（database 初始化 + installType 检测之后，upgrade screen
// 弹出来之前/之后）必须主动调用一次 `usePipelineTaskStore.markStaleTasksAsFailed()`，
// 把 `status ∈ {idle, drafting, reviewing, factChecking, proofing}` 且
// `updatedAt` 超过 10 分钟的任务标记为 `failed`（"运行被中断"）。
//
// 旧逻辑只在 `AppState.change` 事件触发时才跑，冷启动不会发出 'active' change 事件，
// 所以旧任务永远清理不掉。

describe('App cold start cleans up stale pipeline tasks (V2.2.2)', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('markStaleTasksAsFailed marks running tasks older than 10 min as failed', () => {
    jest.doMock('../src/services/database', () => ({
      openDatabase: jest.fn(async () => undefined),
      getAllPipelineTasks: jest.fn(async () => []),
      lastInstallInfo: null,
      savePipelineTask: jest.fn(async () => undefined),
    }));

    const { usePipelineTaskStore } = require('../src/store/pipelineTaskStore');
    const now = Date.now();
    // 直接塞两条任务：一条 15 分钟前 drafting（应该被标 fail），一条 1 分钟前 drafting（保留）
    usePipelineTaskStore.setState((_s: any) => ({
      tasks: [
        {
          id: 'stale_1',
          targetType: 'chapter',
          targetId: 1,
          status: 'drafting',
          stageResults: [],
          finalText: null,
          error: null,
          createdAt: now - 20 * 60 * 1000,
          updatedAt: now - 15 * 60 * 1000, // 15 min ago > 10 min threshold
          resolvedAt: null,
        },
        {
          id: 'fresh_1',
          targetType: 'chapter',
          targetId: 2,
          status: 'drafting',
          stageResults: [],
          finalText: null,
          error: null,
          createdAt: now - 2 * 60 * 1000,
          updatedAt: now - 1 * 60 * 1000, // 1 min ago
          resolvedAt: null,
        },
      ],
    }));

    const marked = usePipelineTaskStore.getState().markStaleTasksAsFailed();
    expect(marked).toBe(1);
    const after = usePipelineTaskStore.getState().tasks;
    const stale = after.find((t: any) => t.id === 'stale_1');
    const fresh = after.find((t: any) => t.id === 'fresh_1');
    expect(stale?.status).toBe('failed');
    expect(stale?.error).toMatch(/中断/);
    expect(fresh?.status).toBe('drafting'); // 1 min ago must stay running
  });
});
