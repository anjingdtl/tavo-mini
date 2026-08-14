/**
 * F2-07 UI 修复：批次运行/暂停页的"返回"按钮无反应。
 *
 * 根因：Header 返回按钮实现为 setView('create') + loadActiveBatchForProject。
 * 当批次运行中（或暂停）时，loadActiveBatchForProject 把活跃批次重新加载
 * 进 store → view effect（batchStatus='running' + hasExecutionTraces）强制
 * 切回 'running' 视图 → 用户点"返回"页面原地不动。
 *
 * 修复：所有视图下"返回"都调用 navigation.goBack()；running / paused
 * 视图离开后批次仍在后台继续。
 */
import React from 'react';
import { render, waitFor, fireEvent } from '@testing-library/react-native';

jest.mock('../src/store/themeStore', () => ({
  useThemeStore: () => ({
    theme: {
      colors: {
        textPrimary: '#111',
        textSecondary: '#666',
        textMuted: '#999',
        danger: '#c00',
        warning: '#a60',
        accent: '#439EA6',
        background: '#fff',
        card: '#f5f5f5',
        border: '#ddd',
      },
    },
  }),
}));

jest.mock('../src/store/projectStore', () => ({
  useProjectStore: () => ({
    currentProject: { id: 1, name: '测试项目', mode: 'outline' },
  }),
}));

const mockGoBack = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: (...args: any[]) => mockGoBack(...args) }),
  useRoute: () => ({ params: undefined }),
}));

const mockLoadActive = jest.fn();
jest.mock('../src/store/multiChapterBatchStore', () => ({
  useMultiChapterBatchStore: () => ({
    batch: {
      id: 'b1',
      status: 'running',
      currentOrdinal: 1,
      completedCount: 0,
      chapterCount: 3,
      usedLlmCalls: 3,
      usedInputTokens: 100,
      usedOutputTokens: 200,
    },
    items: [
      {
        ordinal: 1,
        status: 'running_pipeline',
        chapterId: 10,
        activePipelineTaskId: 't1',
        title: '第1章',
        adoptionFingerprint: null,
      },
      { ordinal: 2, status: 'pending', chapterId: null, activePipelineTaskId: null, title: '第2章', adoptionFingerprint: null },
      { ordinal: 3, status: 'pending', chapterId: null, activePipelineTaskId: null, title: '第3章', adoptionFingerprint: null },
    ],
    plan: null,
    loading: false,
    error: null,
    reconciling: false,
    lastMessage: null,
    lastStage: null,
    refresh: jest.fn(),
    loadActiveBatchForProject: (...args: any[]) => {
      mockLoadActive(...args);
      return Promise.resolve();
    },
    createDraftBatch: jest.fn(),
    runPlanner: jest.fn(),
    saveEditedPlan: jest.fn(),
    start: jest.fn(),
    pause: jest.fn(),
    resume: jest.fn(),
    cancel: jest.fn(),
  }),
}));

import { MultiChapterBatchScreen } from '../src/screens/MultiChapterBatchScreen';

describe('F2-07: 批次页返回按钮', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('运行中（running）视图：点"返回"调用 navigation.goBack 离开批次页', async () => {
    render(<MultiChapterBatchScreen />);
    // 渲染到 running 视图（有执行痕迹）。
    await waitFor(() =>
      expect(
        require('@testing-library/react-native').screen.getAllByText(
          /批次进度|暂停|刷新/,
        ).length,
      ).toBeGreaterThan(0),
    );
    fireEvent.press(
      require('@testing-library/react-native').screen.getByText('返回'),
    );
    expect(mockGoBack).toHaveBeenCalled();
    // 返回按钮本身不重新加载活跃批次（那会把 running 批次又拉回 running
    // 视图）；mount 时的 useEffect 调用不算。
    expect(mockLoadActive).toHaveBeenCalledTimes(1);
  });
});
