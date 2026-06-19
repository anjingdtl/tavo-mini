import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';

const mockUpdateChapter = jest.fn();
const mockGetChapterById = jest.fn();
const mockGetActiveTaskForTarget = jest.fn(() => null);
const mockCreateTask = jest.fn(() => 'task-1');
const mockRunChapterPipeline = jest.fn();
const mockNavigate = jest.fn();
const mockGenerationResultModal = jest.fn(() => null);
let mockTasks: any[] = [];

jest.mock('../src/services/database', () => ({
  updateChapter: (...args: any[]) => mockUpdateChapter(...args),
  getChapterById: (...args: any[]) => mockGetChapterById(...args),
  getVoiceConfig: jest.fn(async () => ({
    model: 'speech-2.8-hd',
    voiceId: 'male-qn-qingse',
    speed: 1,
    vol: 1,
    pitch: 0,
    sampleRate: 32000,
    bitrate: 128000,
    format: 'mp3',
  })),
}));

jest.mock('../src/services/secureStorage', () => ({
  getSecureMiniMaxApiKey: jest.fn(async () => ''),
  setSecureMiniMaxApiKey: jest.fn(async () => undefined),
  clearSecureMiniMaxApiKey: jest.fn(async () => undefined),
}));

jest.mock('../src/services/pipelineRunner', () => ({
  runChapterPipeline: (...args: any[]) => mockRunChapterPipeline(...args),
}));

jest.mock('../src/services/revisionService', () => ({
  createRevision: jest.fn(async () => undefined),
}));

jest.mock('../src/services/summaryGenerator', () => ({
  generateMemorySummary: jest.fn(async () => ''),
}));

jest.mock('../src/store/pipelineTaskStore', () => ({
  usePipelineTaskStore: {
    getState: () => ({
      createTask: mockCreateTask,
      getActiveTaskForTarget: mockGetActiveTaskForTarget,
      tasks: mockTasks,
    }),
    // The ChapterEditor effect subscribes to task changes; tests that do not
    // exercise the subscription path can no-op it.
    subscribe: () => () => {},
  },
}));

jest.mock('../src/components/GenerationResultModal', () => ({
  GenerationResultModal: (props: any) => mockGenerationResultModal(props),
}));

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: mockNavigate,
    goBack: jest.fn(),
    addListener: jest.fn(() => () => {}),
    dispatch: jest.fn(),
  }),
  useFocusEffect: (cb: any) => {
    if (typeof cb === 'function') cb();
  },
}));

import { ChapterEditor } from '../src/screens/ChapterEditor';

const sampleChapter = {
  id: 1,
  project_id: 10,
  title: '第 1 章',
  synopsis: '',
  content: '',
  status: 'draft' as const,
  position: 1,
  summary_json: null,
  memory_summary: '',
  memory_summary_tokens: 0,
  created_at: '2026-06-14T00:00:00.000Z',
  updated_at: '2026-06-14T00:00:00.000Z',
};

describe('ChapterEditor toolbar', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTasks = [];
    mockCreateTask.mockImplementation(() => {
      mockTasks.push({
        id: 'task-1',
        targetType: 'chapter',
        targetId: 1,
        status: 'idle',
        stageResults: [],
        finalText: null,
        error: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        resolvedAt: null,
      });
      return 'task-1';
    });
    mockRunChapterPipeline.mockImplementation(async (taskId: string) => {
      mockTasks = mockTasks.map(task =>
        task.id === taskId
          ? { ...task, status: 'completed', finalText: '生成后的正文', updatedAt: Date.now() }
          : task,
      );
    });
    mockGetChapterById.mockResolvedValue(sampleChapter as any);
    mockUpdateChapter.mockResolvedValue(undefined);
  });

  it('renders all 9 short-label buttons', async () => {
    const onClose = jest.fn();
    const { findByText } = render(
      <ChapterEditor chapterId={1} onClose={onClose} />,
    );
    for (const label of ['续写', '定稿', '版本', '清空', '摘要', '历史', '上下文', '草稿', '朗读']) {
      expect(await findByText(label)).toBeTruthy();
    }
  });

  it('does not render the old long labels', async () => {
    const onClose = jest.fn();
    const { findByText, queryByText } = render(
      <ChapterEditor chapterId={1} onClose={onClose} />,
    );
    await findByText('续写');
    expect(queryByText('AI 续写')).toBeNull();
    expect(queryByText('保存定稿')).toBeNull();
  });

  it('navigates to the pipeline result screen as soon as chapter continuation completes', async () => {
    const onClose = jest.fn();
    const { findByText } = render(
      <ChapterEditor chapterId={1} onClose={onClose} />,
    );
    const continueButton = await findByText('续写');

    await act(async () => {
      fireEvent.press(continueButton);
    });

    expect(mockNavigate).toHaveBeenCalledWith('PipelineResult', { taskId: 'task-1' });
    expect(mockGenerationResultModal).not.toHaveBeenCalledWith(
      expect.objectContaining({ visible: true }),
      expect.anything(),
    );
    expect(mockRunChapterPipeline).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ id: 1 }),
      expect.any(Function),
    );
  });

  it('shows the running pipeline progress when returning to a chapter with an active task', async () => {
    mockTasks = [{
      id: 'task-running',
      targetType: 'chapter',
      targetId: 1,
      status: 'reviewing',
      stageResults: [],
      finalText: null,
      error: null,
      createdAt: Date.now() - 3000,
      updatedAt: Date.now() - 1000,
      resolvedAt: null,
    }];

    const onClose = jest.fn();
    const { findByText } = render(
      <ChapterEditor chapterId={1} onClose={onClose} />,
    );

    expect(await findByText('点评中...')).toBeTruthy();
  });
});
