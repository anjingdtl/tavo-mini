import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { createEmptyStoryMemory } from '../src/services/storyMemory/storyMemoryDefaults';

const mockEnsure = jest.fn();
const mockClear = jest.fn();
const mockRebuild = jest.fn();

jest.mock('../src/services/database', () => ({
  ensureProjectStoryMemoryRow: (...args: unknown[]) => mockEnsure(...args),
  clearStoryMemory: (...args: unknown[]) => mockClear(...args),
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
    expect(await findByText('状态：需要重建')).toBeTruthy();
    expect(await findByText('登场人物（0）')).toBeTruthy();
    expect(await findByText('人物关系（0）')).toBeTruthy();
    expect(await findByText('故事主线')).toBeTruthy();
    expect(await findByText('快速初始化')).toBeTruthy();
    expect(await findByText('完整重建')).toBeTruthy();
    expect(queryByText('编辑 JSON')).toBeNull();
  });

  it('starts a full rebuild and exposes progress callbacks', async () => {
    const { findByText } = render(<StoryMemoryScreen />);
    const rebuildButton = await findByText('完整重建');
    await act(async () => {
      fireEvent.press(rebuildButton);
    });
    expect(mockRebuild).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        mode: 'full',
        signal: expect.any(Object),
        onProgress: expect.any(Function),
      }),
    );
  });
});
