import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { createEmptyStoryMemory } from '../src/services/storyMemory/storyMemoryDefaults';
import { useStoryMemoryTaskStore } from '../src/store/storyMemoryTaskStore';

const mockEnsure = jest.fn();
const mockClear = jest.fn();
const mockEnsurePolicy = jest.fn();
const mockGetContextConfig = jest.fn();
const mockGetChapters = jest.fn();
const mockUpsertPolicy = jest.fn();
const mockRequestMaintenance = jest.fn();
const mockCancelMaintenance = jest.fn();
const mockListAttempts = jest.fn();

jest.mock('../src/services/database', () => ({
  ensureProjectStoryMemoryRow: (...args: unknown[]) => mockEnsure(...args),
  clearStoryMemory: (...args: unknown[]) => mockClear(...args),
  ensureStoryMemoryPolicy: (...args: unknown[]) => mockEnsurePolicy(...args),
  getContextConfig: (...args: unknown[]) => mockGetContextConfig(...args),
  getChaptersByProject: (...args: unknown[]) => mockGetChapters(...args),
  upsertStoryMemoryPolicy: (...args: unknown[]) => mockUpsertPolicy(...args),
}));
jest.mock('../src/services/storyMemory/storyMemoryService', () => ({
  requestStoryMemoryMaintenance: (...args: unknown[]) =>
    mockRequestMaintenance(...args),
  cancelStoryMemoryMaintenance: (...args: unknown[]) =>
    mockCancelMaintenance(...args),
}));
jest.mock('../src/data/repositories/storyMemoryRequestAttemptRepository', () => ({
  listStoryMemoryRequestAttempts: (...args: unknown[]) =>
    mockListAttempts(...args),
}));
jest.mock(
  '../src/services/continuation/chapterNumbering/continuationChapterNumbering',
  () => ({
    getContinuationChapterNumbering: jest.fn().mockRejectedValue(new Error('outline')),
  }),
);

import { StoryMemoryScreen } from '../src/screens/StoryMemoryScreen';
import { useProjectStore } from '../src/store/projectStore';

function baseState() {
  const state = createEmptyStoryMemory(7);
  state.metadata.status = 'dirty';
  state.metadata.dirtyFromPosition = 0;
  state.mainline.currentObjective = '调查钟楼';
  return state;
}

describe('StoryMemoryScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useStoryMemoryTaskStore.getState().resetForTest();
    const state = baseState();
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
    mockRequestMaintenance.mockResolvedValue({
      projectId: 7,
      throughPosition: -1,
      state,
      batchesApplied: 0,
      pendingRemaining: 0,
    });
    mockClear.mockResolvedValue(undefined);
    mockListAttempts.mockResolvedValue([]);
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

  it('shows one primary CTA, fixed collapsed sections, and no raw advanced editor', async () => {
    const { findByText, queryByText } = render(<StoryMemoryScreen />);
    expect(await findByText(/长期记忆：需要重新整理/)).toBeTruthy();
    expect(await findByText(/登场人物（0）/)).toBeTruthy();
    expect(await findByText(/人物关系（0）/)).toBeTruthy();
    expect(await findByText(/故事主线/)).toBeTruthy();
    expect(await findByText(/未解决线索（0）/)).toBeTruthy();
    expect(await findByText(/未兑现伏笔（0）/)).toBeTruthy();
    expect(await findByText('继续整理')).toBeTruthy();
    expect(queryByText('高级操作')).toBeNull();
    expect(queryByText(/上下文覆盖：需重新整理/)).toBeNull();
    expect(queryByText('编辑 JSON')).toBeNull();
  });

  it('routes the primary CTA and maintenance entrance through the coordinator', async () => {
    const screen = render(<StoryMemoryScreen />);
    const primary = await screen.findByText('继续整理');
    await act(async () => {
      fireEvent.press(primary);
    });
    expect(mockRequestMaintenance).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 7,
        reason: 'manual',
        priority: 'manual',
        throughPosition: -1,
      }),
    );

    const maintenance = await screen.findByText(/维护与诊断/);
    await act(async () => {
      fireEvent.press(maintenance);
    });
    const rebuild = await screen.findByText('重新整理长期记忆');
    await act(async () => {
      fireEvent.press(rebuild);
    });
    expect(mockRequestMaintenance).toHaveBeenCalledTimes(2);
    expect(mockRequestMaintenance.mock.calls[1][0]).toEqual(
      expect.objectContaining({ reason: 'manual' }),
    );
    expect(mockCancelMaintenance).not.toHaveBeenCalled();
  });

  it('uses the coordinator cancellation path for a running task', async () => {
    const startedAt = Date.now();
    useStoryMemoryTaskStore.getState().startTask({
      taskId: 'story-memory:7',
      projectId: 7,
      kind: 'rebuild',
      phase: 'requesting',
      totalChapters: 10,
      completedChapters: 3,
      totalBatches: 4,
      completedBatches: 1,
      currentFromPosition: 3,
      currentThroughPosition: 5,
      currentAttempt: 1,
      maxAttempts: 3,
      percent: 30,
      startedAt,
      updatedAt: startedAt,
      message: '正在分析第 4～6 章',
    });
    const screen = render(<StoryMemoryScreen />);
    expect(await screen.findByText('停止整理')).toBeTruthy();
    expect(await screen.findByText(/30% · 已完成 3 \/ 10 章/)).toBeTruthy();
    await act(async () => {
      fireEvent.press(await screen.findByText('停止整理'));
    });
    expect(mockCancelMaintenance).toHaveBeenCalledWith(7);
  });

  it('reveals the mainline diagnostic only inside the collapsed section', async () => {
    const state = createEmptyStoryMemory(7);
    state.metadata.status = 'clean';
    state.throughChapterPosition = 5;
    mockEnsure.mockResolvedValue({
      state,
      status: 'clean',
      dirtyFromPosition: null,
    });

    const screen = render(<StoryMemoryScreen />);
    await screen.findByText(/长期记忆：正常/);
    const mainlineButton = await screen.findByText(/故事主线/);
    expect(
      screen.queryByText(/已完成多章长期记忆整理，但尚未识别到有效故事主线/),
    ).toBeNull();
    await act(async () => {
      fireEvent.press(mainlineButton);
    });
    expect(
      await screen.findByText(/已完成多章长期记忆整理，但尚未识别到有效故事主线/),
    ).toBeTruthy();
  });

  it('renders detailed active mainline fields and hides paid foreshadowing', async () => {
    const state = createEmptyStoryMemory(7);
    state.metadata.status = 'clean';
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

    const screen = render(<StoryMemoryScreen />);
    await screen.findByText(/长期记忆：正常/);
    const mainlineButton = await screen.findByText(/故事主线/);
    await act(async () => {
      fireEvent.press(mainlineButton);
    });
    expect(await screen.findByText(/钟楼调查｜追查暗门与失踪档案/)).toBeTruthy();
    expect(await screen.findByText(/守卫阻拦｜僵持｜代价：无法取得档案/)).toBeTruthy();
    await act(async () => {
      fireEvent.press(await screen.findByText(/未解决线索（1）/));
      fireEvent.press(await screen.findByText(/未兑现伏笔（1）/));
    });
    expect(await screen.findByText(/暗门去向｜确认暗门通往何处/)).toBeTruthy();
    expect(await screen.findByText(/银钥匙家徽 → 揭示家徽主人/)).toBeTruthy();
    expect(screen.queryByText(/已兑现伏笔/)).toBeNull();
  });
});
