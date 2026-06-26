import React from 'react';
import { act, render } from '@testing-library/react-native';

jest.mock('../src/store/themeStore', () => ({
  useThemeStore: () => ({
    theme: {
      colors: {
        accent: '#6366f1',
        textSecondary: '#666',
        textMuted: '#999',
        textPrimary: '#111',
        surface: '#fff',
        border: '#ddd',
        card: '#f5f5f5',
        danger: '#ef4444',
      },
    },
  }),
}));

jest.mock('../src/store/pipelineTaskStore', () => {
  const mockResolveTask = jest.fn();
  // An unresolved task so the unmount cleanup will resolve it.
  const tasks: any[] = [
    {
      id: 'task-1',
      targetType: 'chapter',
      targetId: 1,
      status: 'completed',
      stageResults: [],
      finalText: '...',
      error: null,
      createdAt: 0,
      updatedAt: 0,
      resolvedAt: null,
    },
  ];
  return {
    usePipelineTaskStore: () => ({ tasks, resolveTask: mockResolveTask }),
    __mockResolveTask: mockResolveTask,
  };
});

jest.mock('@react-navigation/native', () => {
  // 工厂内部不能用外部变量，必须 require。给出一个真实的空 Context，
  // 避免 PipelineResultScreen 里 useContext(undefined) 抛错。
  const React = require('react');
  return {
    useNavigation: () => ({ goBack: jest.fn(), navigate: jest.fn() }),
    useRoute: () => ({ params: {} }),
    NavigationRouteContext: React.createContext(undefined),
  };
});

import { GenerationResultModal } from '../src/components/GenerationResultModal';
import * as storeModule from '../src/store/pipelineTaskStore';

const mockResolveTask = (storeModule as unknown as { __mockResolveTask: jest.Mock }).__mockResolveTask;

describe('GenerationResultModal', () => {
  beforeEach(() => {
    mockResolveTask.mockClear();
  });

  it('renders nothing when taskId is null', () => {
    const { queryByText } = render(
      <GenerationResultModal visible={true} taskId={null} onClosed={jest.fn()} />,
    );
    expect(queryByText('流水线结果')).toBeNull();
  });

  it('renders Modal content when visible and taskId provided', () => {
    const { getByText } = render(
      <GenerationResultModal visible={true} taskId="task-1" onClosed={jest.fn()} />,
    );
    expect(getByText('流水线结果')).toBeTruthy();
  });

  it('marks the task as resolved on unmount so the chapter editor does not re-open the same modal', async () => {
    // The store mock always returns an unresolved task, so the cleanup
    // effect's deferred resolveTask(...) call should fire.
    const { unmount } = render(
      <GenerationResultModal visible={true} taskId="task-1" onClosed={jest.fn()} />,
    );
    act(() => { unmount(); });
    // The cleanup defers to the next tick via setTimeout; advance the
    // microtask queue so the callback runs.
    await act(async () => {
      await new Promise((resolve) => { setTimeout(resolve, 0); });
    });
    expect(mockResolveTask).toHaveBeenCalledWith('task-1', 'reject');
  });
});
