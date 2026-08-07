/**
 * CL-02: 初始化失败必须真正进入安全错误页（修复前稳定失败测试）。
 *
 * mock openDatabase/initializeDatabase throw → render App → 断言：
 *   - 错误页可见（「本地资料暂时无法载入」+ 错误码 INIT_FAILED）
 *   - NavigationContainer / TabNavigator 不渲染（无「1 项目」tab）
 *   - 项目空列表不渲染
 *
 * 修复前：catch 分支 setInitError 后仍 setReady(true)，`initError && !ready`
 * 永远为假，NavigationContainer 照常渲染 → 主界面空列表。
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
  openDatabase: jest.fn(async () => {
    throw new Error('SQLITE_CANTOPEN: unable to open database file');
  }),
}));

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import { App } from '../src/main';

// 固定时间源：跳过 1200ms splash 定时器需要真实的 setTimeout 推进。
jest.useFakeTimers();

test('初始化失败时渲染安全错误页，绝不渲染主界面/空项目列表', async () => {
  const screen = render(<App />);

  // 跳过 splash 显示窗口，让 init() 执行。
  jest.advanceTimersByTime(1500);
  // init() 内部是 async —— 把 microtask/宏任务都跑完。
  await jest.runAllTimersAsync();

  await waitFor(() => {
    expect(screen.getByText('本地资料暂时无法载入')).toBeTruthy();
    expect(screen.getByText(/错误码：INIT_FAILED/)).toBeTruthy();
    expect(
      screen.getByText(/原数据库未删除，请勿卸载或清除应用数据/),
    ).toBeTruthy();
  });

  // NavigationContainer / TabNavigator 不得渲染 —— 空项目列表不允许出现。
  expect(screen.queryByText('1 项目')).toBeNull();
  expect(screen.queryByText('2 资料')).toBeNull();
  expect(screen.queryByText('3 写作')).toBeNull();
  expect(screen.queryByText('设置')).toBeNull();
});
