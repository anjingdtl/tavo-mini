/**
 * F2-07: 流水线结果页"从失败环节重启"按钮。
 *
 * 场景：终稿（proof）超时失败、初稿/审阅/核查已成功、finalText 保留初稿回退
 * 时，结果页应提供"从失败环节重启"按钮 —— 点击后重置失败 stage checkpoint
 * 为 pending、task 转 interrupted 并 resumePipeline（只重跑失败阶段，复用
 * 已成功阶段与 frozen request，不重复计费）。修复前只有放弃/采纳。
 */
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

const mockResolveTask = jest.fn();
const mockTasks: any[] = [
  {
    id: 't1',
    targetType: 'chapter',
    targetId: 1,
    status: 'failed',
    stageResults: [
      { stage: 'draft', status: 'success', text: '初稿内容', durationMs: 1000 },
      { stage: 'review', status: 'success', text: '{}', durationMs: 1000 },
      { stage: 'factCheck', status: 'success', text: '{}', durationMs: 1000 },
      { stage: 'proof', status: 'failed', text: '', error: '请求超时，请检查网络或模型服务。', durationMs: 1000 },
    ],
    finalText: '初稿回退',
    error: null,
    inputFingerprint: null,
    pipelineContextJson: null,
    pipelineContextVersion: null,
    pipelineContextHash: null,
    createdAt: 1000,
    updatedAt: 2000,
    resolvedAt: null,
    resolvedAction: null,
  },
];
jest.mock('../src/store/pipelineTaskStore', () => {
  const hook = () => ({
    tasks: mockTasks,
    resolveTask: (...args: any[]) => mockResolveTask(...args),
    registerPersistedTask: jest.fn(),
  });
  return {
    usePipelineTaskStore: Object.assign(hook, {
      getState: () => ({
        tasks: mockTasks,
        resolveTask: (...args: any[]) => mockResolveTask(...args),
        registerPersistedTask: jest.fn(),
      }),
    }),
  };
});

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

const mockGoBack = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: (...args: any[]) => mockGoBack(...args) }),
  NavigationRouteContext: require('react').createContext(undefined),
  CommonActions: { reset: jest.fn() },
}));

const mockGetChapter = jest.fn();
jest.mock('../src/services/database', () => ({
  getChapterById: (...args: any[]) => mockGetChapter(...args),
}));

const mockResumePipeline = jest.fn();
jest.mock('../src/services/pipelineRunner', () => ({
  resumePipeline: (...args: any[]) => mockResumePipeline(...args),
}));

const mockResetCheckpoints = jest.fn();
jest.mock('../src/data/repositories/pipelineStageCheckpointRepository', () => ({
  resetFailedStageCheckpointsForResume: (...args: any[]) =>
    mockResetCheckpoints(...args),
}));

jest.mock('../src/data/connection/execute', () => ({
  execute: jest.fn(async () => ({ rows: { length: 0 } })),
}));

jest.mock('../src/data/connection/openDatabase', () => ({
  openDatabase: jest.fn(async () => ({})),
}));

import { Alert } from 'react-native';
import { PipelineResultScreen } from '../src/screens/PipelineResultScreen';

describe('F2-07: 流水线结果页从失败环节重启', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetChapter.mockResolvedValue({
      id: 1,
      project_id: 1,
      title: '第1章',
      content: '',
    });
    mockResumePipeline.mockResolvedValue(undefined);
    mockResetCheckpoints.mockResolvedValue(undefined);
    jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      buttons?.find(b => b.text === '重启')?.onPress?.();
    });
  });

  it('终稿失败时显示"从失败环节重启"按钮（修复前只有放弃/采纳）', async () => {
    const { findByText } = render(<PipelineResultScreen taskId="t1" />);
    expect(await findByText('从失败环节重启')).toBeTruthy();
  });

  it('点击后重置失败 checkpoint、task 转 interrupted 并 resumePipeline', async () => {
    const { findByText } = render(<PipelineResultScreen taskId="t1" />);
    fireEvent.press(await findByText('从失败环节重启'));
    await waitFor(() => expect(mockResetCheckpoints).toHaveBeenCalledWith('t1'));
    await waitFor(() => expect(mockResumePipeline).toHaveBeenCalled());
    expect(mockResumePipeline.mock.calls[0][0]).toBe('t1');
    expect(mockResumePipeline.mock.calls[0][1]).toMatchObject({
      id: 1,
      title: '第1章',
    });
  });

  it('task 已完成时不显示重启按钮', async () => {
    mockTasks[0] = {
      id: 't2',
      targetType: 'chapter',
      targetId: 2,
      status: 'completed',
      stageResults: [
        { stage: 'draft', status: 'success', text: '初稿', durationMs: 1 },
        { stage: 'proof', status: 'success', text: '终稿', durationMs: 1 },
      ],
      finalText: '终稿内容',
      error: null,
      inputFingerprint: null,
      pipelineContextJson: null,
      pipelineContextVersion: null,
      pipelineContextHash: null,
      createdAt: 1000,
      updatedAt: 2000,
      resolvedAt: null,
      resolvedAction: null,
    };
    const { queryByText, findByText } = render(
      <PipelineResultScreen taskId="t2" />,
    );
    await findByText('采纳');
    expect(queryByText('从失败环节重启')).toBeNull();
  });

  it('仅初稿失败（无成功阶段）时也提供"重新尝试"入口（真机 BUG 回归）', async () => {
    mockTasks[0] = {
      id: 't3',
      targetType: 'chapter',
      targetId: 3,
      status: 'failed',
      stageResults: [
        {
          stage: 'draft',
          status: 'failed',
          text: '',
          error: 'API 请求失败 (401): Authentication Fails',
          durationMs: 1000,
        },
      ],
      finalText: null,
      error: null,
      inputFingerprint: null,
      pipelineContextJson: null,
      pipelineContextVersion: null,
      pipelineContextHash: null,
      createdAt: 1000,
      updatedAt: 2000,
      resolvedAt: null,
      resolvedAction: null,
    };
    const { findByText } = render(<PipelineResultScreen taskId="t3" />);
    const retryButton = await findByText('重新尝试');
    expect(retryButton).toBeTruthy();
    fireEvent.press(retryButton);
    await waitFor(() => expect(mockResetCheckpoints).toHaveBeenCalledWith('t3'));
    await waitFor(() => expect(mockResumePipeline).toHaveBeenCalled());
    expect(mockResumePipeline.mock.calls[0][0]).toBe('t3');
  });

  it('任务中断（interrupted）时也显示"从失败环节重启"（超时/杀进程后可继续）', async () => {
    mockTasks[0] = {
      id: 't4',
      targetType: 'chapter',
      targetId: 4,
      status: 'interrupted',
      stageResults: [
        { stage: 'draft', status: 'success', text: '初稿内容', durationMs: 1000 },
        { stage: 'review', status: 'failed', text: '', error: 'Network request failed', durationMs: 1000 },
      ],
      finalText: null,
      error: null,
      inputFingerprint: null,
      pipelineContextJson: null,
      pipelineContextVersion: null,
      pipelineContextHash: null,
      createdAt: 1000,
      updatedAt: 2000,
      resolvedAt: null,
      resolvedAction: null,
    };
    const { findByText, getByText } = render(
      <PipelineResultScreen taskId="t4" />,
    );
    // 修复前：interrupted 被误显示为"进行中"且无重启入口。
    expect(await findByText('从失败环节重启')).toBeTruthy();
    expect(getByText(/已中断，可从失败阶段继续/)).toBeTruthy();
    fireEvent.press(await findByText('从失败环节重启'));
    await waitFor(() => expect(mockResetCheckpoints).toHaveBeenCalledWith('t4'));
    await waitFor(() => expect(mockResumePipeline).toHaveBeenCalled());
    expect(mockResumePipeline.mock.calls[0][0]).toBe('t4');
  });

  it('任务运行中（reviewing）时不显示采纳/放弃/重启，且提示后台运行', async () => {
    mockTasks[0] = {
      id: 't5',
      targetType: 'chapter',
      targetId: 5,
      status: 'reviewing',
      stageResults: [
        { stage: 'draft', status: 'success', text: '初稿内容', durationMs: 1000 },
        { stage: 'review', status: 'failed', text: '', error: '网络错误（重试中）', durationMs: 1000 },
      ],
      finalText: '初稿内容',
      error: null,
      inputFingerprint: null,
      pipelineContextJson: null,
      pipelineContextVersion: null,
      pipelineContextHash: null,
      createdAt: 1000,
      updatedAt: 2000,
      resolvedAt: null,
      resolvedAction: null,
    };
    const { queryByText, findByText, getByText } = render(
      <PipelineResultScreen taskId="t5" />,
    );
    // 运行中：头部标明当前阶段，不提供采纳/放弃/重启（避免误采纳旧初稿）。
    expect(getByText(/进行中 · 审阅\/评估/)).toBeTruthy();
    expect(queryByText('采纳')).toBeNull();
    expect(queryByText('放弃')).toBeNull();
    expect(queryByText('从失败环节重启')).toBeNull();
    expect(await findByText(/任务仍在后台运行/)).toBeTruthy();
  });
});
