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

// V2.2.0：用 fake store 验证 PipelineProgress 实时显示流式草稿预览
const fakeDraftPreview: Record<string, string> = {};
const fakeSubscribers: Array<(state: any) => void> = [];
jest.mock('../src/store/pipelineTaskStore', () => ({
  usePipelineTaskStore: {
    getState: () => ({ draftPreviews: fakeDraftPreview }),
    subscribe: (selectorOrListener: any, cb?: any) => {
      // 兼容 zustand v5：subscribe(selector, callback) 或 subscribe(listener)
      const listener = typeof selectorOrListener === 'function' && cb ? cb : selectorOrListener;
      fakeSubscribers.push(listener);
      return () => {
        const idx = fakeSubscribers.indexOf(listener);
        if (idx >= 0) fakeSubscribers.splice(idx, 1);
      };
    },
  },
}));

import { PipelineProgress } from '../src/components/PipelineProgress';

describe('PipelineProgress', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    for (const k of Object.keys(fakeDraftPreview)) delete fakeDraftPreview[k];
    fakeSubscribers.length = 0;
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

  it('V2.2.0: 当指定 taskId 且 stage=draft 时显示草稿预览文本', async () => {
    fakeDraftPreview['task-A'] = '一半的草稿…';

    const { findByText } = render(
      <PipelineProgress stage="draft" startedAt={Date.now()} visible={true} taskId="task-A" />,
    );

    const node = await findByText('一半的草稿…');
    expect(node).toBeTruthy();
  });

  it('V2.2.0: stage 不为 draft 时不显示草稿预览', () => {
    fakeDraftPreview['task-A'] = '不应显示';
    const { queryByText } = render(
      <PipelineProgress stage="review" startedAt={Date.now()} visible={true} taskId="task-A" />,
    );
    expect(queryByText('不应显示')).toBeNull();
  });
});
