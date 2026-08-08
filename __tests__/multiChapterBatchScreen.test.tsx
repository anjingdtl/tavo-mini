/**
 * MultiChapterBatchScreen — default-capability smoke tests.
 *
 * The feature flag is GONE: outline projects render the create form directly
 * (no placeholder, no flag read). Only real precondition failures (no
 * project / wrong mode) produce explicit error states.
 */
import React from 'react';
import { render, waitFor } from '@testing-library/react-native';

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
}));

const mockLoadActive = jest.fn();
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
    loadActiveBatchForProject: (...args: any[]) => mockLoadActive(...args),
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

describe('MultiChapterBatchScreen (default capability)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('auto-loads the active batch on mount (plan survives navigation)', async () => {
    mockLoadActive.mockResolvedValue(undefined);
    render(<MultiChapterBatchScreen />);
    await waitFor(() => expect(mockLoadActive).toHaveBeenCalled());
    expect(mockLoadActive).toHaveBeenCalledWith(1);
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

  it('never references the removed feature flag', () => {
    // Guard against accidentally re-adding a flag read in the screen.
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
});
