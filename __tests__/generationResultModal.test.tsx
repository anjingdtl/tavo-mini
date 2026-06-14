import React from 'react';
import { render } from '@testing-library/react-native';

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
  const tasks: any[] = [];
  return {
    usePipelineTaskStore: () => ({ tasks, resolveTask: jest.fn() }),
  };
});

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn(), navigate: jest.fn() }),
  useRoute: () => ({ params: {} }),
}));

import { GenerationResultModal } from '../src/components/GenerationResultModal';

describe('GenerationResultModal', () => {
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
});
