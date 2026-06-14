/* eslint-env jest */
/**
 * Verify the dismissible pipeline-result prompt. Native Alert.alert cannot
 * be reliably dismissed by the consumer and stays visible on top of any
 * React Navigation screen the user transitions into, which made the
 * legacy "completed" alert feel like it was re-firing on every
 * navigation. The Modal here is dismissible from JS, so the call site
 * can close it in lockstep with the navigation.
 */
import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';

jest.mock('../src/store/themeStore', () => ({
  useThemeStore: () => ({
    theme: {
      colors: {
        accent: '#6366f1',
        textSecondary: '#666',
        textPrimary: '#111',
        surface: '#fff',
        border: '#ddd',
        card: '#f5f5f5',
      },
    },
  }),
}));

import { PipelineResultPrompt } from '../src/components/PipelineResultPrompt';
import type { PipelineTask } from '../src/types/pipeline';

const baseTask: PipelineTask = {
  id: 'pt_test',
  targetType: 'chapter',
  targetId: 1,
  status: 'completed',
  stageResults: [],
  finalText: 'some content',
  error: null,
  createdAt: 0,
  updatedAt: 0,
  resolvedAt: null,
};

describe('PipelineResultPrompt', () => {
  it('renders nothing when task is null', () => {
    const { queryByText } = render(
      <PipelineResultPrompt task={null} onDismiss={jest.fn()} onViewResult={jest.fn()} />,
    );
    expect(queryByText('流水线已完成')).toBeNull();
  });

  it('shows the completed copy and a 查看结果 button for a finished chapter task', () => {
    const onViewResult = jest.fn();
    const { getByText, getByTestId } = render(
      <PipelineResultPrompt task={baseTask} onDismiss={jest.fn()} onViewResult={onViewResult} />,
    );
    expect(getByText('流水线已完成')).toBeTruthy();
    expect(getByText('章节 #1 的流水线已生成新内容。是否前往查看并采纳？')).toBeTruthy();
    fireEvent.press(getByTestId('pipeline-prompt-confirm'));
    expect(onViewResult).toHaveBeenCalledWith('pt_test');
  });

  it('shows the failed copy and a single 我知道了 button on failure', () => {
    const onDismiss = jest.fn();
    const failed: PipelineTask = { ...baseTask, status: 'failed', finalText: null, error: '网络中断' };
    const { getByText, queryByText, getByTestId } = render(
      <PipelineResultPrompt task={failed} onDismiss={onDismiss} onViewResult={jest.fn()} />,
    );
    expect(getByText('流水线失败')).toBeTruthy();
    expect(getByText('网络中断')).toBeTruthy();
    // Failure path only has the dismiss button; the "查看结果" button is
    // intentionally hidden because there is nothing to view.
    expect(queryByText('查看结果')).toBeNull();
    fireEvent.press(getByTestId('pipeline-prompt-dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('treats a completed task with empty finalText as a special case', () => {
    const onDismiss = jest.fn();
    const empty: PipelineTask = { ...baseTask, finalText: '   ' };
    const { getByText } = render(
      <PipelineResultPrompt task={empty} onDismiss={onDismiss} onViewResult={jest.fn()} />,
    );
    expect(getByText('流水线完成')).toBeTruthy();
    expect(getByText('流水线已完成，但本次生成内容为空。')).toBeTruthy();
  });

  it('fires onDismiss when the secondary 稍后处理 button is pressed', () => {
    const onDismiss = jest.fn();
    const { getByTestId } = render(
      <PipelineResultPrompt task={baseTask} onDismiss={onDismiss} onViewResult={jest.fn()} />,
    );
    fireEvent.press(getByTestId('pipeline-prompt-dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
