import React from 'react';
import { render, act } from '@testing-library/react-native';

jest.mock('../src/store/themeStore', () => ({
  useThemeStore: () => ({
    theme: {
      colors: {
        accent: '#6366f1',
        textPrimary: '#333',
        textSecondary: '#666',
        textMuted: '#999',
        surface: '#fff',
        border: '#ddd',
      },
    },
  }),
}));

import { PipelineProgress } from '../src/components/PipelineProgress';

describe('PipelineProgress', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => jest.useRealTimers());

  it('renders ActivityIndicator and stage label when visible', () => {
    const { getByText } = render(
      <PipelineProgress stage="draft" startedAt={Date.now()} visible={true} />,
    );
    expect(getByText('草稿中...')).toBeTruthy();
    expect(getByText('0s')).toBeTruthy();
  });

  it('updates elapsed time after 1.5 seconds', () => {
    const { getByText } = render(
      <PipelineProgress stage="review" startedAt={Date.now()} visible={true} />,
    );
    act(() => { jest.advanceTimersByTime(1500); });
    expect(getByText('1s')).toBeTruthy();
  });

  it('renders nothing when visible is false', () => {
    const { queryByText } = render(
      <PipelineProgress stage="draft" startedAt={Date.now()} visible={false} />,
    );
    expect(queryByText('草稿中...')).toBeNull();
  });

  it('updates label when stage changes', () => {
    const { getByText, rerender } = render(
      <PipelineProgress stage="draft" startedAt={Date.now()} visible={true} />,
    );
    expect(getByText('草稿中...')).toBeTruthy();
    rerender(
      <PipelineProgress stage="proof" startedAt={Date.now()} visible={true} />,
    );
    expect(getByText('打磨中...')).toBeTruthy();
  });

  it('uses the shared stage vocabulary for continuation runs', () => {
    const { getByText, rerender } = render(
      <PipelineProgress
        stage="draft"
        continuationStage="writer"
        startedAt={Date.now()}
        visible={true}
      />,
    );
    expect(getByText('正在生成…')).toBeTruthy();
    rerender(
      <PipelineProgress
        stage="draft"
        continuationStage="checker"
        startedAt={Date.now()}
        visible={true}
      />,
    );
    expect(getByText('正在检查…')).toBeTruthy();
    rerender(
      <PipelineProgress
        stage="draft"
        continuationStage="repair"
        startedAt={Date.now()}
        visible={true}
      />,
    );
    expect(getByText('正在修订…')).toBeTruthy();
  });
});
