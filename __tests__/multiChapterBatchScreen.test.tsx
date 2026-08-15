/**
 * MultiChapterBatchScreen — default-capability smoke tests.
 *
 * The feature flag is GONE: outline projects render the create form directly
 * (no placeholder, no flag read). Only real precondition failures (no
 * project / wrong mode) produce explicit error states.
 */
import React from 'react';
import { Alert } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

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
const mockStoreState: any = {
  batch: null,
  items: [],
  plan: null,
  loading: false,
  error: null,
  reconciling: false,
  lastMessage: null,
  lastStage: null,
  refresh: jest.fn(),
  loadActiveBatchForProject: (...args: any[]) => mockLoadActive(...args),
  createDraftBatch: jest.fn(),
  runPlanner: jest.fn(),
  saveEditedPlan: jest.fn(),
  start: jest.fn(),
  pause: jest.fn(),
  resume: jest.fn(),
  cancel: jest.fn(),
};
jest.mock('../src/store/multiChapterBatchStore', () => ({
  useMultiChapterBatchStore: () => mockStoreState,
}));

import { MultiChapterBatchScreen } from '../src/screens/MultiChapterBatchScreen';

describe('MultiChapterBatchScreen (default capability)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStoreState.batch = null;
    mockStoreState.items = [];
    mockStoreState.plan = null;
    mockStoreState.loading = false;
    mockStoreState.error = null;
    mockStoreState.reconciling = false;
    mockStoreState.lastMessage = null;
    mockStoreState.lastStage = null;
  });

  it('auto-loads the active batch on mount (plan survives navigation)', async () => {
    mockLoadActive.mockResolvedValue(undefined);
    render(<MultiChapterBatchScreen />);
    await waitFor(() => expect(mockLoadActive).toHaveBeenCalled());
    expect(mockLoadActive).toHaveBeenCalledWith(1);
  });

  it('冷启动预览从 plannerOutputJson 重建计划（items 仍是占位行时不丢失）', async () => {
    mockStoreState.batch = {
      id: 'batch-cold',
      projectId: 1,
      status: 'planning',
      sourcePrompt: '剧情摘要',
      chapterCount: 2,
      targetWordsPerChapter: 3000,
      pipelineMode: 'full',
      writingMode: 'outline',
      outlineWorkflowVersion: 4,
      contextBudgetVersion: 7,
      currentOrdinal: 1,
      completedCount: 0,
      activeItemOrdinal: null,
      maxLlmCalls: null,
      maxInputTokens: null,
      maxOutputTokens: null,
      usedLlmCalls: 0,
      usedInputTokens: 0,
      usedOutputTokens: 0,
      pauseReason: null,
      errorCode: null,
      errorMessage: null,
      reasoningEffort: null,
      updatedAt: Date.now(),
      // planner 产物在用户确认前只落在这里；items 仍是占位行。
      plannerOutputJson: JSON.stringify({
        chapters: [
          {
            ordinal: 1,
            title: '灯塔之外',
            synopsis: '三人抵达灯塔外墙开始搜寻。',
            keyBeats: ['抵达灯塔'],
            carryIn: '',
            carryOut: '',
            targetWords: 3000,
          },
          {
            ordinal: 2,
            title: '北塔之门',
            synopsis: '北塔大门紧闭，约定再访。',
            keyBeats: ['确认封闭'],
            carryIn: '',
            carryOut: '',
            targetWords: 3000,
          },
        ],
      }),
    };
    mockStoreState.items = [1, 2].map(i => ({
      batchId: 'batch-cold',
      ordinal: i,
      title: `第 ${i} 章`,
      synopsis: '',
      keyBeatsJson: '[]',
      carryIn: null,
      carryOut: null,
      targetWords: 3000,
      status: 'pending',
      chapterId: null,
      activePipelineTaskId: null,
      errorCode: null,
      errorMessage: null,
      nextRetryAt: null,
      updatedAt: Date.now(),
    }));
    const { findByDisplayValue } = render(<MultiChapterBatchScreen />);
    await expect(findByDisplayValue('灯塔之外')).resolves.toBeTruthy();
    await expect(
      findByDisplayValue('三人抵达灯塔外墙开始搜寻。'),
    ).resolves.toBeTruthy();
    await expect(findByDisplayValue('北塔之门')).resolves.toBeTruthy();
  });

  it('renders the create form directly for outline projects (no flag gate)', async () => {
    const { findByText, queryByText } = render(<MultiChapterBatchScreen />);
    await expect(findByText('剧情摘要')).resolves.toBeTruthy();
    // No experimental placeholder and no flag read anywhere.
    expect(queryByText('该功能暂未开放。')).toBeNull();
    expect(queryByText('实验功能')).toBeNull();
  });

  it('titles the page 一键写 N 章', async () => {
    const { findByText } = render(<MultiChapterBatchScreen />);
    await expect(findByText('一键写 N 章')).resolves.toBeTruthy();
  });

  it('创建页点击返回会离开批次页回到章节列表', async () => {
    mockLoadActive.mockResolvedValue(undefined);
    const { findByText, getByText } = render(<MultiChapterBatchScreen />);
    await expect(findByText('剧情摘要')).resolves.toBeTruthy();

    fireEvent.press(getByText('返回'));

    expect(mockGoBack).toHaveBeenCalledTimes(1);
    // 返回操作不应再次加载活跃批次；加载只来自页面进入时的初始化。
    expect(mockLoadActive).toHaveBeenCalledTimes(1);
  });

  it('批次完成后点击「返回章节列表」直接离开批次页，而不是留在创建表单', async () => {
    mockLoadActive.mockResolvedValue(undefined);
    mockStoreState.batch = {
      id: 'batch-done',
      projectId: 1,
      status: 'completed',
      sourcePrompt: '续写目标',
      chapterCount: 3,
      targetWordsPerChapter: 3000,
      pipelineMode: 'full',
      writingMode: 'continuation',
      outlineWorkflowVersion: 4,
      contextBudgetVersion: 7,
      currentOrdinal: 3,
      completedCount: 3,
      activeItemOrdinal: null,
      maxLlmCalls: null,
      maxInputTokens: null,
      maxOutputTokens: null,
      usedLlmCalls: 12,
      usedInputTokens: 30000,
      usedOutputTokens: 9000,
      pauseReason: null,
      errorCode: null,
      errorMessage: null,
      reasoningEffort: null,
      updatedAt: Date.now(),
    };
    mockStoreState.items = [1, 2, 3].map(i => ({
      batchId: 'batch-done',
      ordinal: i,
      title: `第 ${i} 章`,
      synopsis: '',
      keyBeatsJson: '[]',
      carryIn: null,
      carryOut: null,
      targetWords: 3000,
      status: 'succeeded',
      chapterId: i,
      activePipelineTaskId: null,
      activeContinuationRunId: null,
      activeRunNo: 0,
      completionQuality: 'full_pipeline',
      retryCount: 0,
      errorCode: null,
      errorMessage: null,
      nextRetryAt: null,
      updatedAt: Date.now(),
    }));

    const { findByText, getByText, queryByText } = render(
      <MultiChapterBatchScreen />,
    );
    await expect(findByText('批次完成')).resolves.toBeTruthy();

    fireEvent.press(getByText('返回章节列表'));

    // 确认后必须离开批次页回到章节工作台；不能退回一键写 N 章的创建表单。
    expect(mockGoBack).toHaveBeenCalledTimes(1);
    expect(queryByText('本批续写目标')).toBeNull();
    expect(queryByText('剧情摘要')).toBeNull();
  });

  it('never references the removed feature flag', () => {    // Guard against accidentally re-adding a flag read in the screen.
    const source = require('fs').readFileSync(
      require('path').resolve(
        __dirname,
        '../src/screens/MultiChapterBatchScreen.tsx',
      ),
      'utf8',
    );
    expect(source).not.toContain('isMultiChapterBatchEnabled');
    expect(source).not.toContain('暂未开放');
  });

  it('确认恢复后只触发一次，并立即回到批次进度页', async () => {
    let resolveResume!: () => void;
    mockStoreState.batch = {
      id: 'batch-1',
      projectId: 1,
      status: 'paused_user',
      sourcePrompt: '续写目标',
      chapterCount: 3,
      targetWordsPerChapter: 3000,
      pipelineMode: 'full',
      writingMode: 'continuation',
      outlineWorkflowVersion: 4,
      contextBudgetVersion: 7,
      currentOrdinal: 1,
      completedCount: 0,
      activeItemOrdinal: null,
      maxLlmCalls: null,
      maxInputTokens: null,
      maxOutputTokens: null,
      usedLlmCalls: 0,
      usedInputTokens: 0,
      usedOutputTokens: 0,
      pauseReason: null,
      errorCode: 'BATCH_CONTINUATION_STATE_SYNC_FAILED',
      errorMessage: '状态同步失败',
      reasoningEffort: null,
      updatedAt: Date.now(),
    };
    mockStoreState.resume = jest.fn(
      () => new Promise<void>(resolve => {
        resolveResume = resolve;
      }),
    );
    const alert = jest
      .spyOn(Alert, 'alert')
      .mockImplementation((_title, _message, buttons) => {
        buttons?.find(button => button.text === '确认继续')?.onPress?.();
      });

    const { findByText, getByText } = render(<MultiChapterBatchScreen />);
    await expect(findByText('批次已暂停')).resolves.toBeTruthy();
    const resumeButton = getByText('确认后继续');

    fireEvent.press(resumeButton);
    // The imperative guard must reject a second tap before the first async
    // confirmation/resume path has completed.
    fireEvent.press(resumeButton);

    await waitFor(() => expect(mockStoreState.resume).toHaveBeenCalledTimes(1));
    await expect(findByText('批次进度 0/3')).resolves.toBeTruthy();
    expect(alert).toHaveBeenCalledTimes(1);

    resolveResume();
    alert.mockRestore();
  });
});
