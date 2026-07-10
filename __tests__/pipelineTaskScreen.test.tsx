import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import type { PipelineTask, PipelineTaskStatus } from '../src/types/pipeline';

const mockCancelPipeline = jest.fn();
const mockNavigate = jest.fn();
const mockLoadFromDB = jest.fn();
const mockResolveTask = jest.fn();
const mockClearResolved = jest.fn();

let mockTasks: PipelineTask[] = [];

jest.mock('../src/services/pipelineRunner', () => ({
  cancelPipeline: (...args: unknown[]) => mockCancelPipeline(...args),
}));

jest.mock('../src/store/themeStore', () => ({
  useThemeStore: () => ({
    theme: {
      colors: {
        accent: '#439EA6',
        textPrimary: '#111',
        textSecondary: '#666',
        background: '#fff',
        surface: '#fff',
        card: '#fff',
        border: '#ddd',
        danger: '#d33',
      },
    },
  }),
}));

jest.mock('../src/store/pipelineTaskStore', () => ({
  usePipelineTaskStore: () => ({
    tasks: mockTasks,
    clearResolved: mockClearResolved,
    resolveTask: mockResolveTask,
    loadFromDB: mockLoadFromDB,
  }),
}));

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

jest.mock('react-native-toast-message', () => ({ show: jest.fn() }));

jest.mock('../src/components/ui', () => {
  const ReactModule = require('react');
  const { Text, TouchableOpacity, View } = require('react-native');
  return {
    spacing: { sm: 8, md: 12, lg: 16 },
    Screen: ({ children }: { children: React.ReactNode }) => ReactModule.createElement(View, null, children),
    Header: ({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) => ReactModule.createElement(
      View,
      null,
      ReactModule.createElement(Text, null, title),
      subtitle ? ReactModule.createElement(Text, null, subtitle) : null,
      action,
    ),
    Button: ({ label, onPress, disabled }: { label: string; onPress?: () => void; disabled?: boolean }) => ReactModule.createElement(
      TouchableOpacity,
      { accessibilityRole: 'button', disabled, onPress },
      ReactModule.createElement(Text, null, label),
    ),
  };
});

import { PipelineTaskScreen } from '../src/screens/PipelineTaskScreen';

function makeTask(id: string, status: PipelineTaskStatus): PipelineTask {
  return {
    id,
    targetType: 'chapter',
    targetId: 1,
    status,
    stageResults: [],
    finalText: null,
    error: null,
    createdAt: 1000,
    updatedAt: 5000,
    resolvedAt: null,
  };
}

describe('PipelineTaskScreen', () => {
  beforeEach(() => {
    mockTasks = [];
    jest.clearAllMocks();
  });

  it('allows a running task to be terminated directly', () => {
    mockTasks = [makeTask('draft-task', 'drafting')];
    const { getByText } = render(<PipelineTaskScreen />);

    fireEvent.press(getByText('终止任务'));

    expect(mockCancelPipeline).toHaveBeenCalledWith('draft-task');
  });

  it('treats fact checking as active and terminates every active task', () => {
    mockTasks = [
      makeTask('draft-task', 'drafting'),
      makeTask('fact-task', 'factChecking'),
      makeTask('cancelled-task', 'cancelled'),
    ];
    const { getByText, getAllByText } = render(<PipelineTaskScreen />);

    expect(getByText(/事实核查/)).toBeTruthy();
    expect(getAllByText('终止任务')).toHaveLength(2);
    fireEvent.press(getByText('终止全部'));

    expect(mockCancelPipeline).toHaveBeenCalledTimes(2);
    expect(mockCancelPipeline).toHaveBeenCalledWith('draft-task');
    expect(mockCancelPipeline).toHaveBeenCalledWith('fact-task');
  });

  it('allows cancelled tasks to be removed from the active list', () => {
    mockTasks = [makeTask('cancelled-task', 'cancelled')];
    const { getByText } = render(<PipelineTaskScreen />);

    fireEvent.press(getByText('从列表移除'));

    expect(mockResolveTask).toHaveBeenCalledWith('cancelled-task', 'reject');
  });
});
