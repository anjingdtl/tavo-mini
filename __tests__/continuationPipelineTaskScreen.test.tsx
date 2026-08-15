import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ContinuationGenerationRun } from '../src/services/continuation/generation';

const mockListRunsForProject = jest.fn();
const mockCancelContinuationRun = jest.fn();
const mockNavigate = jest.fn();
const mockGetChaptersByProject = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
  useFocusEffect: (callback: () => (() => void) | undefined) => {
    const ReactModule = require('react');
    ReactModule.useEffect(callback, []);
  },
}));

jest.mock('../src/store/themeStore', () => ({
  useThemeStore: () => ({
    theme: {
      colors: {
        accent: '#439EA6',
        textPrimary: '#111',
        textSecondary: '#666',
        textMuted: '#999',
        background: '#fff',
        surface: '#fff',
        card: '#fff',
        border: '#ddd',
        danger: '#d33',
      },
    },
  }),
}));

let mockCurrentProject: any = {
  id: 3,
  name: '续写项目',
  mode: 'continuation',
};

jest.mock('../src/store/projectStore', () => ({
  useProjectStore: () => ({ currentProject: mockCurrentProject }),
}));

jest.mock('../src/services/database', () => ({
  getChaptersByProject: (...args: any[]) => mockGetChaptersByProject(...args),
}));

jest.mock('../src/services/continuation/generation', () => ({
  listRunsForProject: (...args: any[]) => mockListRunsForProject(...args),
  cancelContinuationRun: (...args: any[]) => mockCancelContinuationRun(...args),
}));

jest.mock('react-native-toast-message', () => ({ show: jest.fn() }));

jest.mock('../src/components/ui', () => {
  const ReactModule = require('react');
  const { Text, TouchableOpacity, View } = require('react-native');
  return {
    spacing: { sm: 8, md: 12, lg: 16 },
    Screen: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement(View, null, children),
    Header: ({ title, subtitle, action }: any) =>
      ReactModule.createElement(
        View,
        null,
        ReactModule.createElement(Text, null, title),
        subtitle ? ReactModule.createElement(Text, null, subtitle) : null,
        action,
      ),
    Card: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement(View, null, children),
    EmptyState: ({ title, description }: any) =>
      ReactModule.createElement(
        View,
        null,
        ReactModule.createElement(Text, null, title),
        description ? ReactModule.createElement(Text, null, description) : null,
      ),
    LoadingState: ({ label }: any) => ReactModule.createElement(Text, null, label),
    Button: ({ label, onPress, disabled }: any) =>
      ReactModule.createElement(
        TouchableOpacity,
        { accessibilityRole: 'button', disabled, onPress },
        ReactModule.createElement(Text, null, label),
      ),
  };
});

import { Alert } from 'react-native';
import { ContinuationPipelineTaskScreen } from '../src/screens/continuation/ContinuationPipelineTaskScreen';

function makeRun(
  id: string,
  state: ContinuationGenerationRun['state'],
): ContinuationGenerationRun {
  return {
    id,
    workflowVersion: 5,
    projectId: 3,
    chapterId: 11,
    targetPosition: 0 as any,
    sourceId: 2,
    sourceSnapshotJson: '{}',
    canonSnapshotId: 'canon-1',
    canonRevision: 1,
    storyMemoryFingerprint: 'memory-1',
    storyMemoryThroughPosition: 0,
    inputRevisionHash: 'input-1',
    userInstruction: '继续',
    settingsSnapshotJson: '{}',
    contextSnapshotJson: '{}',
    contextTraceJson: null,
    tokenUsageJson: '{}',
    state,
    stage: 'writer',
    completionReason: null,
    adoptedRevisionHash: null,
    finalizedRevisionHash: null,
    errorCode: state === 'failed' ? 'writer_failed' : null,
    errorMessage: state === 'failed' ? '模型请求失败' : null,
    createdAt: '2026-08-15T10:00:00.000Z',
    updatedAt: '2026-08-15T10:05:00.000Z',
    completedAt: null,
  };
}

describe('ContinuationPipelineTaskScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCurrentProject = { id: 3, name: '续写项目', mode: 'continuation' };
    mockListRunsForProject.mockResolvedValue([]);
    mockGetChaptersByProject.mockResolvedValue([
      { id: 11, title: '第二十一章' },
    ]);
    mockCancelContinuationRun.mockResolvedValue(undefined);
  });

  it('lists unfinished runs and opens the independent continuation result page', async () => {
    mockListRunsForProject.mockResolvedValue([
      makeRun('ct-running', 'running'),
      makeRun('ct-review', 'awaiting_user'),
      makeRun('ct-done', 'completed'),
      makeRun('ct-cancelled', 'cancelled'),
    ]);

    const { findAllByText, getByText, queryByText } = render(
      <ContinuationPipelineTaskScreen />,
    );

    expect((await findAllByText('第二十一章')).length).toBe(2);
    expect(getByText('生成中 · 当前阶段：正文生成')).toBeTruthy();
    expect(getByText('等待确认/采纳 · 当前阶段：正文生成')).toBeTruthy();
    expect(queryByText('已完成')).toBeNull();
    expect(queryByText('已取消')).toBeNull();

    fireEvent.press(getByText('查看并处理'));
    expect(mockNavigate).toHaveBeenCalledWith('ContinuationResult', {
      runId: 'ct-review',
    });
  });

  it('can terminate a running continuation run from the execution page', async () => {
    const running = makeRun('ct-running', 'running');
    mockListRunsForProject.mockResolvedValue([running]);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(
      (_title, _message, buttons) => {
        buttons?.find(button => button.text === '终止任务')?.onPress?.();
      },
    );

    const { findByText, getByText } = render(
      <ContinuationPipelineTaskScreen />,
    );
    await findByText('第二十一章');
    fireEvent.press(getByText('终止任务'));

    await waitFor(() =>
      expect(mockCancelContinuationRun).toHaveBeenCalledWith('ct-running'),
    );
    expect(alert).toHaveBeenCalledTimes(1);
    alert.mockRestore();
  });

  it('shows a clear empty state when the project has no unfinished run', async () => {
    const { findByText } = render(<ContinuationPipelineTaskScreen />);
    await expect(
      findByText('没有未完成的续写流水线'),
    ).resolves.toBeTruthy();
  });
});
