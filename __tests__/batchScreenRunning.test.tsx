/**
 * RB-8 UI state consistency (audit 2026-08-06):
 * - pressing 开始批量写作 switches to the running view immediately
 *   (previously the screen stayed on preview until the WHOLE batch finished)
 * - the start button is disabled while a reconciler is driving the batch
 *   (previously it could be pressed repeatedly, spawning duplicate loops)
 */
import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

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

const mockGoBack = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: (...args: any[]) => mockGoBack(...args) }),
  useRoute: () => ({ params: undefined }),
}));

const mockLoadActive = jest.fn();
const mockSaveEditedPlan = jest.fn(async () => undefined);
const mockStart = jest.fn(async () => {
  // Simulate the reconciler starting: the first item moves off pending.
  mockItem1Status = 'creating_chapter';
  return undefined;
});
const mockRefresh = jest.fn(async () => undefined);
let mockReconciling = false;
let mockBatchStatus = 'ready';
let mockItem1Status = 'pending';
let mockItem1NextRetryAt: number | null = null;

jest.mock('../src/store/multiChapterBatchStore', () => ({
  useMultiChapterBatchStore: () => ({
    batch: {
      id: 'b1',
      projectId: 1,
      status: mockBatchStatus,
      currentOrdinal: 1,
      chapterCount: 2,
      completedCount: 0,
      pipelineMode: 'full',
      usedLlmCalls: 0,
      usedInputTokens: 0,
      usedOutputTokens: 0,
      maxLlmCalls: null,
      maxInputTokens: null,
      maxOutputTokens: null,
    },
    items: [
      {
        ordinal: 1,
        title: '第一章',
        synopsis: '梗概1',
        keyBeatsJson: '["k1"]',
        carryIn: null,
        carryOut: null,
        targetWords: 3000,
        status: mockItem1Status,
        chapterId: null,
        activePipelineTaskId: null,
        activeRunNo: 0,
        completionQuality: null,
        adoptionFingerprint: null,
        adoptedRevisionId: null,
        retryCount: 0,
        nextRetryAt: mockItem1NextRetryAt,
        errorCode: null,
        errorMessage: null,
        createdAt: 0,
        updatedAt: 0,
        completedAt: null,
      },
      {
        ordinal: 2,
        title: '第二章',
        synopsis: '梗概2',
        keyBeatsJson: '["k2"]',
        carryIn: null,
        carryOut: null,
        targetWords: 3000,
        status: 'pending',
        chapterId: null,
        activePipelineTaskId: null,
        activeRunNo: 0,
        completionQuality: null,
        adoptionFingerprint: null,
        adoptedRevisionId: null,
        retryCount: 0,
        nextRetryAt: null,
        errorCode: null,
        errorMessage: null,
        createdAt: 0,
        updatedAt: 0,
        completedAt: null,
      },
    ],
    plan: null,
    loading: false,
    error: null,
    reconciling: mockReconciling,
    lastMessage: null,
    lastStage: null,
    refresh: mockRefresh,
    loadActiveBatchForProject: (...args: any[]) => mockLoadActive(...args),
    createDraftBatch: jest.fn(),
    runPlanner: jest.fn(),
    saveEditedPlan: mockSaveEditedPlan,
    start: mockStart,
    pause: jest.fn(),
    resume: jest.fn(),
    cancel: jest.fn(),
  }),
}));

import { MultiChapterBatchScreen } from '../src/screens/MultiChapterBatchScreen';

describe('batch screen run-state consistency', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReconciling = false;
    mockBatchStatus = 'ready';
    mockItem1Status = 'pending';
    mockItem1NextRetryAt = null;
    mockIsEnabled.mockResolvedValue(true);
    mockLoadActive.mockResolvedValue(undefined);
  });

  it('switches to the running view immediately after pressing start', async () => {
    const { findByText } = render(<MultiChapterBatchScreen />);
    // Preview page renders the editable plan + the start button.
    const startButton = await findByText('开始批量写作');
    fireEvent.press(startButton);

    // Running view must appear immediately (not after the batch finishes).
    await waitFor(() => expect(mockSaveEditedPlan).toHaveBeenCalled());
    await waitFor(() => expect(mockStart).toHaveBeenCalled());
    await findByText(/批次进度/);
  });

  it('shows the running view while a reconciler is driving a running batch', async () => {
    mockReconciling = true;
    mockBatchStatus = 'running';
    const { findByText } = render(<MultiChapterBatchScreen />);
    // A running batch with a live coordinator stays on the running view
    // (never silently drops back to the preview / start button).
    await findByText(/批次进度/);
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('stays on the running view after a retry wait even when batch status is still ready', async () => {
    // First chapter failed with safe_retry → reconcile waited and handed
    // back; batch status is still 'ready' (no adoption happened yet) but the
    // item carries execution traces. The screen must NOT drop back to the
    // preview page (that would look like the batch never started).
    mockItem1Status = 'waiting_retry';
    mockItem1NextRetryAt = Date.now() + 30_000;
    const { findByText, queryByText } = render(<MultiChapterBatchScreen />);
    await findByText(/批次进度/);
    expect(queryByText('开始批量写作')).toBeNull();
  });
});
