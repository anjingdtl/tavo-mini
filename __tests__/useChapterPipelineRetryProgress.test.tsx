/**
 * 章节编辑页进度条回归（何大哥实测链路）：
 *
 * LLM 超时 → 任务 failed（进度条清理 + 弹框）→ 后台自动重试复用同一
 * 任务 ID 重跑 → 任务最终 completed。修复前 `resultTaskIdRef` 在 failed
 * 时被占用、`seenTerminalRef` 不区分状态，同任务重试成功后的 completed
 * 被双重拦截：进度条残留、不导航结果页。
 *
 * 修复后：failed 只清进度条不占用 resultTaskIdRef；completed 始终处理
 * （除非该任务已完成导航过）；同任务重试成功 → 清进度条 + 导航结果页。
 */
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

const mockAlert = jest.fn();
jest.spyOn(Alert, 'alert').mockImplementation(mockAlert);

const mockNavigate = jest.fn();
let mockTasks: any[] = [];
let subscribeCb: ((state: any, prev: any) => void) | null = null;

const mockCreateTask = jest.fn();
const mockGetActiveTaskForTarget = jest.fn();
const mockGetLatestResumableFailedTask = jest.fn();
const mockGetState = jest.fn(() => ({
  tasks: mockTasks,
  createTask: mockCreateTask,
  getActiveTaskForTarget: mockGetActiveTaskForTarget,
  getLatestResumableFailedTask: mockGetLatestResumableFailedTask,
}));

jest.mock('../src/store/pipelineTaskStore', () => ({
  usePipelineTaskStore: {
    getState: () => mockGetState(),
    subscribe: (cb: any) => {
      subscribeCb = cb;
      return () => {};
    },
  },
}));

jest.mock('../src/store/projectStore', () => ({
  useProjectStore: {
    getState: () => ({ currentProject: { id: 1, mode: 'outline' } }),
  },
}));

jest.mock('../src/services/pipelineRunner', () => ({
  runChapterPipeline: (taskId: any, chapterArg: any, onStageUpdate: any) =>
    mockRunChapterPipeline(taskId, chapterArg, onStageUpdate),
  resumePipeline: jest.fn(() => Promise.resolve()),
  cancelPipeline: jest.fn(),
}));

const mockRunChapterPipeline = jest.fn((..._args: any[]) => Promise.resolve());
const mockGetStageCheckpoints = jest.fn(() => Promise.resolve([]));
const mockUpsertStageCheckpoint = jest.fn(() => Promise.resolve());
const mockGetContextConfig = jest.fn(() =>
  Promise.resolve({ slidingWindowSize: 4000 }),
);

jest.mock('../src/services/database', () => ({
  getStageCheckpoints: () => mockGetStageCheckpoints(),
  upsertStageCheckpoint: () => mockUpsertStageCheckpoint(),
  getContextConfig: () => mockGetContextConfig(),
}));

const mockPrepareStoryMemory = jest.fn();
const mockEnqueueStoryMemoryMaintenance = jest.fn();
jest.mock('../src/services/storyMemory/storyMemoryPrepare', () => ({
  prepareStoryMemoryForGeneration: (...args: any[]) =>
    mockPrepareStoryMemory(...args),
}));
jest.mock('../src/services/storyMemory/storyMemoryService', () => ({
  enqueueStoryMemoryMaintenance: (...args: any[]) =>
    mockEnqueueStoryMemoryMaintenance(...args),
}));

jest.mock('react-native-toast-message', () => ({ show: jest.fn() }));

jest.mock('../src/native/PipelineForegroundModule', () => ({
  PipelineForeground: {
    start: jest.fn(() => Promise.resolve()),
    updateProgress: jest.fn(() => Promise.resolve()),
    notifyComplete: jest.fn(() => Promise.resolve()),
    notifyFailed: jest.fn(() => Promise.resolve()),
    stop: jest.fn(() => Promise.resolve()),
    isAvailable: jest.fn(() => Promise.resolve(true)),
  },
}));

jest.mock('../src/utils/notificationPermission', () => ({
  requestNotificationPermission: jest.fn(() => Promise.resolve(true)),
}));

jest.mock('../src/navigation/pipelinePromptSuppression', () => ({
  suppressGlobalPipelinePrompt: jest.fn(),
}));

import { useChapterPipeline } from '../src/screens/chapter-editor/hooks/useChapterPipeline';

const chapter = {
  id: 1,
  project_id: 1,
  position: 0,
  title: '第1章',
  synopsis: '',
  content: '',
  status: 'draft',
  summary_json: null,
  created_at: 't',
  updated_at: 't',
} as any;

function task(status: string, id = 't_retry_1'): any {
  return {
    id,
    targetType: 'chapter',
    targetId: 1,
    status,
    stageResults: [],
    finalText: null,
    error: null,
    inputFingerprint: null,
    pipelineContextJson: null,
    pipelineContextVersion: null,
    pipelineContextHash: null,
    createdAt: 1000,
    updatedAt: 2000,
    resolvedAt: null,
    resolvedAction: null,
  };
}

describe('章节编辑页进度条：failed → 同任务自动重试 → completed', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAlert.mockClear();
    mockNavigate.mockClear();
    mockTasks = [];
    subscribeCb = null;
    mockCreateTask.mockResolvedValue('t_retry_1');
    mockGetActiveTaskForTarget.mockReturnValue(undefined);
    mockGetLatestResumableFailedTask.mockReturnValue(undefined);
    mockRunChapterPipeline.mockResolvedValue(undefined);
    mockPrepareStoryMemory.mockResolvedValue({
      fatal: false,
      hardGap: false,
      blockReason: '',
    });
  });

  it('任务失败清进度条；同任务重试成功后清进度条并导航结果页（修复回归）', () => {
    const { result } = renderHook(() =>
      useChapterPipeline({
        chapter,
        chapterId: 1,
        navigation: { navigate: mockNavigate } as any,
      }),
    );

    // 1) 任务运行中 → 进度条出现。
    mockTasks = [task('drafting')];
    act(() => {
      subscribeCb?.({ tasks: mockTasks }, { tasks: [] });
    });
    expect(result.current.progressVisible).toBe(true);

    // 2) LLM 超时 → 任务 failed → 进度条清理（弹框由 executeRunPipeline 负责）。
    mockTasks = [task('failed')];
    act(() => {
      subscribeCb?.({ tasks: mockTasks }, { tasks: [task('drafting')] });
    });
    expect(result.current.progressVisible).toBe(false);

    // 3) 后台自动重试复用同一任务 ID 重跑 → 进度条重新出现。
    mockTasks = [task('reviewing')];
    act(() => {
      subscribeCb?.({ tasks: mockTasks }, { tasks: [task('failed')] });
    });
    expect(result.current.progressVisible).toBe(true);

    // 4) 全流程完成 → 同任务 ID completed：必须清进度条并导航结果页。
    //    修复前：resultTaskIdRef/seenTerminalRef 双重拦截 → 残留。
    mockTasks = [task('completed')];
    act(() => {
      subscribeCb?.({ tasks: mockTasks }, { tasks: [task('reviewing')] });
    });
    expect(result.current.progressVisible).toBe(false);
    expect(mockNavigate).toHaveBeenCalledWith('PipelineResult', {
      taskId: 't_retry_1',
    });
  });

  it('同任务 completed 后再次 completed 不重复导航', () => {
    renderHook(() =>
      useChapterPipeline({
        chapter,
        chapterId: 1,
        navigation: { navigate: mockNavigate } as any,
      }),
    );
    mockTasks = [task('completed')];
    act(() => {
      subscribeCb?.({ tasks: mockTasks }, { tasks: [] });
    });
    expect(mockNavigate).toHaveBeenCalledTimes(1);

    act(() => {
      subscribeCb?.({ tasks: [task('completed')] }, { tasks: mockTasks });
    });
    expect(mockNavigate).toHaveBeenCalledTimes(1);
  });

  it('同任务 completed → failed → completed（再次重试）仍能导航', () => {
    const { result } = renderHook(() =>
      useChapterPipeline({
        chapter,
        chapterId: 1,
        navigation: { navigate: mockNavigate } as any,
      }),
    );
    // completed 第一次：导航。
    mockTasks = [task('completed')];
    act(() => {
      subscribeCb?.({ tasks: mockTasks }, { tasks: [] });
    });
    expect(mockNavigate).toHaveBeenCalledTimes(1);

    // 重置 resultTaskIdRef 场景：模拟用户从结果页返回后再次运行。
    // failed 不应占用 resultTaskIdRef —— 这里直接验证 failed 后 completed 可导航。
    mockTasks = [task('drafting')];
    act(() => {
      subscribeCb?.({ tasks: mockTasks }, { tasks: [] });
    });
    mockTasks = [task('failed')];
    act(() => {
      subscribeCb?.({ tasks: mockTasks }, { tasks: [task('drafting')] });
    });
    expect(result.current.progressVisible).toBe(false);

    // 同一任务重跑完成 —— 必须能再次导航（本次任务从未导航过）。
    mockTasks = [task('completed', 't_retry_1')];
    act(() => {
      subscribeCb?.({ tasks: mockTasks }, { tasks: [task('failed')] });
    });
    expect(mockNavigate).toHaveBeenCalledWith('PipelineResult', {
      taskId: 't_retry_1',
    });
  });

  it('单章节阶段超时失败弹窗可直接从失败处继续重跑', async () => {
    const taskId = 't_timeout_retry';
    mockCreateTask.mockResolvedValue(taskId);
    mockRunChapterPipeline.mockImplementation(async () => {
      mockTasks = [task('failed', taskId)];
    });

    const { result } = renderHook(() =>
      useChapterPipeline({
        chapter,
        chapterId: 1,
        navigation: { navigate: mockNavigate } as any,
      }),
    );

    act(() => {
      result.current.runPipeline();
    });

    await waitFor(() =>
      expect(mockRunChapterPipeline).toHaveBeenCalledWith(
        taskId,
        chapter,
        expect.any(Function),
      ),
    );

    const failureCall = mockAlert.mock.calls.find(
      call => call[0] === '流水线失败',
    );
    expect(failureCall).toBeTruthy();
    const retryButton = failureCall?.[2]?.find(
      (button: any) => button.text === '从失败处继续重跑',
    );
    expect(retryButton).toBeTruthy();

    await act(async () => {
      retryButton?.onPress?.();
    });
    await waitFor(() =>
      expect(require('../src/services/pipelineRunner').resumePipeline).toHaveBeenCalledWith(
        taskId,
        chapter,
        expect.any(Function),
      ),
    );
  });

  it('Preview Hard Gap blocks generation and enqueues maintenance once', async () => {
    mockPrepareStoryMemory.mockResolvedValue({
      fatal: true,
      hardGap: true,
      blockReason: '第 1～3 章存在未覆盖历史信息',
    });
    const { result } = renderHook(() =>
      useChapterPipeline({
        chapter,
        chapterId: 1,
        navigation: { navigate: mockNavigate } as any,
      }),
    );

    await act(async () => {
      result.current.runPipeline();
      await Promise.resolve();
    });
    expect(mockGetContextConfig).toHaveBeenCalled();
    await waitFor(() => expect(mockPrepareStoryMemory).toHaveBeenCalled());
    expect(mockEnqueueStoryMemoryMaintenance).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 1,
        throughPosition: -1,
        reason: 'coverage_gap',
        priority: 'background',
      }),
    );
    expect(mockRunChapterPipeline).not.toHaveBeenCalled();
  });
});
