import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { createEmptyStoryMemory } from '../src/services/storyMemory/storyMemoryDefaults';

const mockEnsure = jest.fn();
const mockClear = jest.fn();
const mockRebuild = jest.fn();
const mockEnsurePolicy = jest.fn();
const mockGetContextConfig = jest.fn();
const mockGetChapters = jest.fn();
const mockUpsertPolicy = jest.fn();

jest.mock('../src/services/database', () => ({
  ensureProjectStoryMemoryRow: (...args: unknown[]) => mockEnsure(...args),
  clearStoryMemory: (...args: unknown[]) => mockClear(...args),
  ensureStoryMemoryPolicy: (...args: unknown[]) => mockEnsurePolicy(...args),
  getContextConfig: (...args: unknown[]) => mockGetContextConfig(...args),
  getChaptersByProject: (...args: unknown[]) => mockGetChapters(...args),
  upsertStoryMemoryPolicy: (...args: unknown[]) => mockUpsertPolicy(...args),
}));
jest.mock('../src/services/storyMemory/storyMemoryRebuild', () => ({
  rebuildStoryMemory: (...args: unknown[]) => mockRebuild(...args),
}));

import { StoryMemoryScreen } from '../src/screens/StoryMemoryScreen';
import { useProjectStore } from '../src/store/projectStore';

describe('StoryMemoryScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const state = createEmptyStoryMemory(7);
    state.metadata.status = 'dirty';
    state.metadata.dirtyFromPosition = 0;
    state.mainline.currentObjective = '调查钟楼';
    mockEnsure.mockResolvedValue({ state, status: 'dirty', dirtyFromPosition: 0 });
    mockEnsurePolicy.mockResolvedValue({
      projectId: 7,
      mode: 'smart',
      intervalChapters: 3,
      pendingTokenSoftLimit: 2400,
      updateOnKeyChapter: true,
      updatedAt: '2026-07-19T00:00:00.000Z',
    });
    mockGetContextConfig.mockResolvedValue({ slidingWindowSize: 4000 });
    mockGetChapters.mockResolvedValue([]);
    mockUpsertPolicy.mockImplementation(async (policy: unknown) => policy);
    mockRebuild.mockResolvedValue({
      state: { ...state, metadata: { ...state.metadata, status: 'clean', dirtyFromPosition: null } },
      completedChapters: 1,
      reusedPatches: 0,
      regeneratedPatches: 1,
    });
    mockClear.mockResolvedValue(undefined);
    useProjectStore.setState({
      currentProject: {
        id: 7,
        name: '钟楼疑云',
        mode: 'outline',
        created_at: '',
        updated_at: '',
      },
    });
  });

  it('shows status, fixed three sections, and rebuild controls without raw JSON editing', async () => {
    const { findByText, queryByText } = render(<StoryMemoryScreen />);
    expect(await findByText(/长期记忆：需要重新整理/)).toBeTruthy();
    expect(await findByText('登场人物（0）')).toBeTruthy();
    expect(await findByText('人物关系（0）')).toBeTruthy();
    expect(await findByText('故事主线')).toBeTruthy();
    expect(await findByText('立即整理长期记忆')).toBeTruthy();
    expect(await findByText('高级操作')).toBeTruthy();
    expect(queryByText('编辑 JSON')).toBeNull();
  });

  it('starts a rebuild from advanced actions and exposes progress callbacks', async () => {
    const screen = render(<StoryMemoryScreen />);
    const advanced = await screen.findByText('高级操作');
    await act(async () => {
      fireEvent.press(advanced);
    });
    const continueButton = await screen.findByText('从有效检查点重建');
    await act(async () => {
      fireEvent.press(continueButton);
    });
    expect(mockRebuild).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        mode: 'auto',
        signal: expect.any(Object),
        onProgress: expect.any(Function),
      }),
    );
  });
});
