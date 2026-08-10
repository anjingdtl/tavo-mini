/**
 * F2-07: 章节编辑页重复触发防护。
 *
 * 场景：同一章节上次流水线失败（network_error 等，task failed 未 resolved）
 * 后，用户在章节编辑页再次按"AI 续写/重新生成"——必须拦截并提示：
 *   - 继续：复用已成功 checkpoint，从失败 stage 续跑（不重复计费）
 *   - 从头开始：显式放弃旧进度
 *   - 查看任务详情：直达流水线结果页
 * 修复前无任何提示，用户直接新建任务重复调用流水线浪费 token。
 */
import { renderHook, act } from '@testing-library/react-native';
import { Alert } from 'react-native';
import {
  CURRENT_CONTEXT_BUDGET_VERSION,
  CURRENT_OUTLINE_WORKFLOW_VERSION,
} from '../src/services/pipeline/outlineWorkflowVersion';

const mockAlert = jest.fn();
jest.spyOn(Alert, 'alert').mockImplementation(mockAlert);

const mockNavigate = jest.fn();
const mockTasks: any[] = [
  {
    id: 't_failed_1',
    targetType: 'chapter',
    targetId: 1,
    status: 'failed',
    stageResults: [],
    finalText: null,
    error: 'Network request failed',
    inputFingerprint: null,
    pipelineContextJson: null,
    pipelineContextVersion: null,
    pipelineContextHash: null,
    outlineWorkflowVersion: CURRENT_OUTLINE_WORKFLOW_VERSION,
    contextBudgetVersion: CURRENT_CONTEXT_BUDGET_VERSION,
    createdAt: 1000,
    updatedAt: 2000,
    resolvedAt: null,
    resolvedAction: null,
  },
];
const mockGetState = jest.fn(() => ({
  tasks: mockTasks,
  getActiveTaskForTarget: () => undefined,
  getLatestResumableFailedTask: () => mockTasks[0],
}));
jest.mock('../src/store/pipelineTaskStore', () => ({
  usePipelineTaskStore: {
    getState: () => mockGetState(),
    subscribe: () => () => {},
  },
}));

jest.mock('../src/store/projectStore', () => ({
  useProjectStore: {
    getState: () => ({ currentProject: { id: 1, mode: 'outline' } }),
  },
}));

const mockRunChapterPipeline = jest.fn();
const mockResumePipeline = jest.fn();
jest.mock('../src/services/pipelineRunner', () => ({
  runChapterPipeline: (...args: any[]) => mockRunChapterPipeline(...args),
  resumePipeline: (...args: any[]) => mockResumePipeline(...args),
  cancelPipeline: jest.fn(),
}));

const mockGetCheckpoints = jest.fn();
const mockUpsertCheckpoint = jest.fn();
jest.mock('../src/services/database', () => ({
  getStageCheckpoints: (...args: any[]) => mockGetCheckpoints(...args),
  upsertStageCheckpoint: (...args: any[]) => mockUpsertCheckpoint(...args),
}));

jest.mock('react-native-toast-message', () => ({
  show: jest.fn(),
}));

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

describe('F2-07: 章节编辑页重复触发防护', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAlert.mockClear();
    mockNavigate.mockClear();
    mockRunChapterPipeline.mockResolvedValue(undefined);
    mockResumePipeline.mockResolvedValue(undefined);
    mockGetCheckpoints.mockResolvedValue([
      { stage: 'draft', status: 'succeeded' },
      { stage: 'review', status: 'succeeded' },
      { stage: 'factCheck', status: 'succeeded' },
      { stage: 'proof', status: 'failed' },
    ]);
    mockUpsertCheckpoint.mockResolvedValue(undefined);
  });

  it('存在未 resolved 的失败任务时：弹窗提示并给出 继续/从头开始/查看任务详情', () => {
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
    expect(mockAlert).toHaveBeenCalled();
    const [title, , buttons] = mockAlert.mock.calls[0];
    expect(title).toContain('从上次失败阶段继续');
    const labels = buttons.map((b: any) => b.text);
    expect(labels).toContain('继续');
    expect(labels).toContain('从头开始');
    expect(labels).toContain('查看任务详情');
  });

  it('选"继续"：复用 checkpoint 从失败 stage 续跑（不新建任务）', async () => {
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
    const buttons = mockAlert.mock.calls[0][2];
    const resumeBtn = buttons.find((b: any) => b.text === '继续');
    await act(async () => {
      await resumeBtn.onPress();
    });
    // 失败 stage 重置为 pending（复用成功 checkpoint）。
    expect(mockUpsertCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 't_failed_1', stage: 'proof', status: 'pending' }),
    );
    // resumePipeline 用旧任务，不新建任务。
    expect(mockResumePipeline).toHaveBeenCalledWith('t_failed_1', expect.anything(), expect.anything());
    expect(mockRunChapterPipeline).not.toHaveBeenCalled();
  });

  it('选"查看任务详情"：直达流水线结果页', () => {
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
    const buttons = mockAlert.mock.calls[0][2];
    const detailBtn = buttons.find((b: any) => b.text === '查看任务详情');
    act(() => {
      detailBtn.onPress();
    });
    expect(mockNavigate).toHaveBeenCalledWith('PipelineResult', {
      taskId: 't_failed_1',
    });
  });
});

