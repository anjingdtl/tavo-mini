/**
 * Phase 8: MultiChapterBatchScreen smoke tests.
 * - flag OFF → shows the guarded placeholder (no crash, no entry leak)
 * - flag ON → renders the create form
 */
import React from 'react';
import { render, waitFor } from '@testing-library/react-native';

const mockIsEnabled = jest.fn();
jest.mock('../src/services/featureFlags', () => ({
  isMultiChapterBatchEnabled: (...args: any[]) => mockIsEnabled(...args),
}));

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

jest.mock('../src/store/multiChapterBatchStore', () => ({
  useMultiChapterBatchStore: () => ({
    batch: null,
    items: [],
    plan: null,
    loading: false,
    error: null,
    reconciling: false,
    lastMessage: null,
    refresh: jest.fn(),
    loadActiveBatchForProject: jest.fn(),
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

describe('MultiChapterBatchScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows the guarded placeholder when the feature flag is OFF', async () => {
    mockIsEnabled.mockResolvedValue(false);
    const { findByText } = render(<MultiChapterBatchScreen />);
    await expect(findByText('该功能暂未开放。')).resolves.toBeTruthy();
  });

  it('renders the create form when enabled', async () => {
    mockIsEnabled.mockResolvedValue(true);
    const { findByText, queryByText } = render(<MultiChapterBatchScreen />);
    await waitFor(() => expect(mockIsEnabled).toHaveBeenCalled());
    await expect(findByText('剧情摘要')).resolves.toBeTruthy();
    // 批次消耗上限由弹性预算池自动分配，创建页不再暴露输入。
    expect(queryByText('批次消耗上限（可选）')).toBeNull();
  });
});
