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
    mockEnsure.mockResolvedValue({
      state,
      status: 'dirty',
      dirtyFromPosition: 0,
    });
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
      state: {
        ...state,
        metadata: {
          ...state.metadata,
          status: 'clean',
          dirtyFromPosition: null,
        },
      },
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
    expect(await findByText(/上下文覆盖：需重新整理/)).toBeTruthy();
    expect(queryByText('关键章节立即整理')).toBeNull();
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

  it('uses rebuild rather than incremental advance when dirty memory is整理 now', async () => {
    const screen = render(<StoryMemoryScreen />);
    const button = await screen.findByText('立即整理长期记忆');
    await act(async () => {
      fireEvent.press(button);
    });
    expect(mockRebuild).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ mode: 'auto', signal: expect.any(Object) }),
    );
  });

  it('explains a clean long-running memory whose visible mainline was never recognized', async () => {
    const state = createEmptyStoryMemory(7);
    state.metadata.status = 'clean';
    state.throughChapterPosition = 5;
    mockEnsure.mockResolvedValue({
      state,
      status: 'clean',
      dirtyFromPosition: null,
    });

    const { findByText } = render(<StoryMemoryScreen />);
    expect(
      await findByText(/已完成多章长期记忆整理，但尚未识别到有效故事主线/),
    ).toBeTruthy();
  });

  it('renders detailed active mainline fields and hides paid foreshadowing', async () => {
    const state = createEmptyStoryMemory(7);
    state.mainline.currentArc = {
      id: 'arc_clocktower',
      name: '钟楼调查',
      summary: '追查暗门与失踪档案。',
      startedChapterId: 1,
    };
    state.mainline.currentObjective = '找到地下档案室钥匙';
    state.mainline.activeConflicts.guard = {
      id: 'guard',
      title: '守卫阻拦',
      parties: [],
      state: '僵持',
      stakes: '无法取得档案',
      openedChapterId: 1,
      lastChangedChapterId: 1,
      evidenceChapterIds: [1],
    };
    state.mainline.openThreads.door = {
      id: 'door',
      title: '暗门去向',
      description: '确认暗门通往何处',
      ownerCharacterIds: [],
      priority: 'high',
      openedChapterId: 1,
      lastChangedChapterId: 1,
      deadlineOrTrigger: '',
      evidenceChapterIds: [1],
    };
    state.mainline.foreshadowing.key = {
      id: 'key',
      setup: '银钥匙家徽',
      expectedPayoff: '揭示家徽主人',
      status: 'open',
      openedChapterId: 1,
      lastChangedChapterId: 1,
      evidenceChapterIds: [1],
    };
    state.mainline.foreshadowing.paid = {
      ...state.mainline.foreshadowing.key,
      id: 'paid',
      setup: '已兑现伏笔',
      status: 'paid',
    };
    mockEnsure.mockResolvedValue({
      state,
      status: 'clean',
      dirtyFromPosition: null,
    });

    const { findByText, queryByText } = render(<StoryMemoryScreen />);
    expect(await findByText(/钟楼调查｜追查暗门与失踪档案/)).toBeTruthy();
    expect(await findByText(/守卫阻拦｜僵持｜代价：无法取得档案/)).toBeTruthy();
    expect(await findByText(/暗门去向｜确认暗门通往何处/)).toBeTruthy();
    expect(await findByText(/银钥匙家徽 → 揭示家徽主人/)).toBeTruthy();
    expect(queryByText(/已兑现伏笔/)).toBeNull();
  });
});
