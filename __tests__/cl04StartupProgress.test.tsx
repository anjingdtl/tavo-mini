/**
 * CL-04: 真实 StartupPhase + 动态进度（修复前稳定失败测试）。
 *
 * 修复前：App 只有静态 splash + 1200ms timer，init 期间无任何进度 UI；
 * initializing 阶段为空兜底（无阶段/无进度），且 openDatabase 不暴露
 * onPhase 回调。本测试断言：
 *   1. init 未完成时渲染真实阶段消息 + 进度条（绝无白屏空 Fragment）
 *   2. 阶段/百分比由真实步骤驱动（onPhase 回调收到真实阶段）
 *   3. init 完成后进入主界面
 *   4. 集成：initializeDatabase 的 onPhase 按真实顺序触发
 */
jest.mock('../src/services/database', () => ({
  getAllProjects: jest.fn(async () => []),
  getAllPipelineTasks: jest.fn(async () => []),
  getBackgroundPipelineEnabled: jest.fn(async () => true),
  getLLMConfigs: jest.fn(async () => []),
  getContextConfig: jest.fn(async () => ({
    strategy: 'sliding',
    slidingWindowSize: 4000,
    recentChapterCount: 3,
    summaryBudgetTokens: 20000,
    memoryTopK: 10,
    resourceBudget: 2000,
    worldbookScanDepth: 4,
    customRangeStart: 0,
    customRangeEnd: -1,
    includeResources: true,
    worldbookRecursive: true,
  })),
  getSetting: jest.fn(async () => null),
  lastInstallInfo: null,
  lastMigrationResult: null,
  lastSchemaRecovery: null,
  // 受控的 openDatabase：等待测试放行后才完成，让 init 停在 initializing。
  openDatabase: jest.fn(),
}));

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import { App } from '../src/main';
import * as databaseModule from '../src/services/database';
import {
  __resetForTest,
  __setDatabaseForTest,
} from '../src/data/connection/openDatabase';
import { createEmptyInMemoryDb } from './helpers/canonInMemoryDb';
import { initializeDatabase, lastStartupPath, lastStartupTimings } from '../src/data/schema/initializeDatabase';
import { setupInMemoryFs } from './schema40-fixture-helpers';

jest.useFakeTimers();

let releaseOpen: (() => void) | null = null;

beforeEach(() => {
  releaseOpen = null;
  (databaseModule.openDatabase as jest.Mock).mockImplementation(
    () =>
      new Promise(resolve => {
        releaseOpen = () => resolve({ executeSql: () => undefined });
      }),
  );
});

test('初始化期间显示真实阶段进度（不白屏），完成后进入主界面', async () => {
  const screen = render(<App />);

  // 跳过 splash，进入 initializing。
  jest.advanceTimersByTime(1500);
  await jest.runAllTimersAsync();

  // init 未完成：必须看到真实阶段消息与进度（而不是白屏空 Fragment）。
  await waitFor(() => {
    expect(screen.getByText('正在打开本地数据库…')).toBeTruthy();
    // opening_database 阶段结束值 = 10%。
    expect(screen.getByText('10%')).toBeTruthy();
  });
  // 主界面绝不允许在 init 完成前出现。
  expect(screen.queryByText('1 项目')).toBeNull();

  // 放行 openDatabase → 后续步骤真实推进 → 主界面出现。
  releaseOpen?.();
  await jest.runAllTimersAsync();

  await waitFor(() => {
    expect(screen.getByText('1 项目')).toBeTruthy();
  }, { timeout: 5000 });
});

test('失败时进度页消失并进入安全错误页（不残留 initializing）', async () => {
  (databaseModule.openDatabase as jest.Mock).mockImplementation(async () => {
    throw new Error('SQLITE_CANTOPEN');
  });
  const screen = render(<App />);
  jest.advanceTimersByTime(1500);
  await jest.runAllTimersAsync();

  await waitFor(() => {
    expect(screen.getByText('本地资料暂时无法载入')).toBeTruthy();
    expect(screen.getByText(/错误码：INIT_FAILED/)).toBeTruthy();
  });
  expect(screen.queryByText('正在打开本地数据库…')).toBeNull();
  expect(screen.queryByText('1 项目')).toBeNull();
});

// ── 服务层：initializeDatabase 真实阶段回调顺序 ─────────────────────────
describe('initializeDatabase onPhase 真实阶段驱动（集成）', () => {
  it('fresh 路径按真实步骤顺序回调（checking_schema → validating_schema）', async () => {
    jest.useRealTimers();
    __resetForTest();
    setupInMemoryFs();
    const fresh = await createEmptyInMemoryDb();
    __setDatabaseForTest(fresh as any);

    const phases: string[] = [];
    await initializeDatabase(fresh as any, {
      onPhase: phase => phases.push(phase),
    });

    // fresh 安装路径：检查结构 → 校验结构（无指纹/备份/迁移阶段）。
    expect(phases).toContain('checking_schema');
    expect(phases).toContain('validating_schema');
    expect(phases.indexOf('checking_schema')).toBeLessThan(
      phases.indexOf('validating_schema'),
    );
    try {
      fresh.close();
    } catch {
      /* ignore */
    }
    __resetForTest();
  });

  it('同版本且状态干净时走 Fast Path，不扫描正文内容', async () => {
    jest.useRealTimers();
    __resetForTest();
    setupInMemoryFs();
    const fresh = await createEmptyInMemoryDb();
    __setDatabaseForTest(fresh as any);

    // fresh 安装。
    await initializeDatabase(fresh as any);
    // 植入用户内容后，第二次同版本启动仍必须保持 Fast Path；正文内容
    // 不应因为一次普通冷启动而触发全量指纹/召回扫描。
    await fresh.executeSql(
      `INSERT INTO projects (id, name, mode, created_at, updated_at) VALUES (1, 'p', 'outline', 't', 't')`,
    );
    await fresh.executeSql(
      `INSERT INTO chapters (project_id, position, title, synopsis, content, status, created_at, updated_at)
       VALUES (1, 0, '第1章', '梗概', '正文', 'draft', 't', 't')`,
    );

    const phases: string[] = [];
    await initializeDatabase(fresh as any, {
      onPhase: phase => phases.push(phase),
    });

    expect(lastStartupPath).toBe('fast');
    expect(lastStartupTimings).toEqual(
      expect.objectContaining({
        fingerprint: 0,
        recall: 0,
        deep_validation: 0,
      }),
    );
    expect(phases).toContain('checking_schema');
    expect(phases).not.toContain('capturing_fingerprint');
    expect(phases).not.toContain('verifying_content');
    try {
      fresh.close();
    } catch {
      /* ignore */
    }
    __resetForTest();
  });
});
