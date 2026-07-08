import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';

const mockUpdateChapter = jest.fn();
const mockGetChapterById = jest.fn();
const mockGetActiveTaskForTarget = jest.fn(() => null);
const mockCreateTask = jest.fn(() => 'task-1');
const mockRunChapterPipeline = jest.fn();
const mockCancelPipeline = jest.fn();
const mockNavigate = jest.fn();
let mockTasks: any[] = [];

jest.mock('../src/services/database', () => ({
  updateChapter: (...args: any[]) => mockUpdateChapter(...args),
  getChapterById: (...args: any[]) => mockGetChapterById(...args),
  buildChapterReadingText: jest.fn(async (_projectId: number, _chapterId: number, range: string) => `朗读范围:${range}`),
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
  getTtsEngine: jest.fn(async () => 'system'),
  getSystemTtsConfig: jest.fn(async () => ({
    enginePackage: '',
    voiceKey: '',
    language: 'zh-CN',
    speed: 1,
    pitch: 1,
    volume: 1,
  })),
}));

jest.mock('../src/services/secureStorage', () => ({
  getSecureVoiceApiKey: jest.fn(async () => ''),
  setSecureVoiceApiKey: jest.fn(async () => undefined),
  clearSecureVoiceApiKey: jest.fn(async () => undefined),
  getSecureMiniMaxApiKey: jest.fn(async () => ''),
  setSecureMiniMaxApiKey: jest.fn(async () => undefined),
  clearSecureMiniMaxApiKey: jest.fn(async () => undefined),
}));

jest.mock('../src/services/pipelineRunner', () => ({
  runChapterPipeline: (...args: any[]) => mockRunChapterPipeline(...args),
  cancelPipeline: (...args: any[]) => mockCancelPipeline(...args),
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

import { Alert } from 'react-native';
import { ChapterEditor } from '../src/screens/ChapterEditor';
import * as db from '../src/services/database';
import { TtsAudio } from '../src/native/TtsAudioModule';

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
    mockCancelPipeline.mockClear();
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
    const { findByText, getByTestId } = render(
      <ChapterEditor chapterId={1} onClose={onClose} />,
    );
    for (const label of ['AI 重新生成', '定稿', '版本', '清空', '摘要', '历史', '上下文', '草稿', '朗读']) {
      expect(await findByText(label)).toBeTruthy();
    }
    expect(getByTestId('chapter-toolbar-scroll').props.horizontal).toBe(true);
  });

  it('opens a range picker for reading and reads the whole book selection', async () => {
    mockGetChapterById.mockResolvedValueOnce({ ...sampleChapter, content: '本章正文' } as any);
    const alertSpy = jest.spyOn(Alert, 'alert');
    const speakSpy = jest.spyOn(TtsAudio, 'speak').mockResolvedValue(undefined);
    const { findByText } = render(
      <ChapterEditor chapterId={1} onClose={jest.fn()} />,
    );

    await act(async () => {
      fireEvent.press(await findByText('朗读'));
    });

    expect(alertSpy).toHaveBeenCalledWith(
      '选择朗读范围',
      '请选择要连续朗读的章节范围。',
      expect.arrayContaining([
        expect.objectContaining({ text: '本章' }),
        expect.objectContaining({ text: '从本章到结尾' }),
        expect.objectContaining({ text: '全书' }),
      ]),
    );

    const actions = alertSpy.mock.calls[0][2] as Array<{ text: string; onPress?: () => void }>;
    const allAction = actions.find(action => action.text === '全书');
    await act(async () => {
      await allAction?.onPress?.();
    });

    expect(db.buildChapterReadingText).toHaveBeenCalledWith(10, 1, 'all');
    expect(speakSpy).toHaveBeenCalledWith('朗读范围:all', expect.objectContaining({ sessionId: expect.any(String) }));
    alertSpy.mockRestore();
    speakSpy.mockRestore();
  });

  it('does not render the old long labels', async () => {
    const onClose = jest.fn();
    const { findByText, queryByText } = render(
      <ChapterEditor chapterId={1} onClose={onClose} />,
    );
    await findByText('AI 重新生成');
    expect(queryByText('AI 续写')).toBeNull();
    expect(queryByText('保存定稿')).toBeNull();
  });

  it('navigates to the pipeline result screen as soon as chapter continuation completes', async () => {
    const onClose = jest.fn();
    const { findByText } = render(
      <ChapterEditor chapterId={1} onClose={onClose} />,
    );
    const continueButton = await findByText('AI 重新生成');

    await act(async () => {
      fireEvent.press(continueButton);
    });

    expect(mockNavigate).toHaveBeenCalledWith('PipelineResult', { taskId: 'task-1' });
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

  it('shows a stop button while pipeline is generating and triggers cancelPipeline', async () => {
    // 让 runChapterPipeline 永远不 resolve，保持 generating 状态
    let releasePipeline!: () => void;
    mockRunChapterPipeline.mockImplementationOnce(
      () => new Promise<void>((resolve) => { releasePipeline = resolve; }),
    );
    mockCancelPipeline.mockClear();

    const { findByText } = render(
      <ChapterEditor chapterId={1} onClose={jest.fn()} />,
    );
    const continueButton = await findByText('AI 重新生成');
    await act(async () => { fireEvent.press(continueButton); });

    const stopButton = await findByText('停止');
    expect(stopButton).toBeTruthy();

    await act(async () => { fireEvent.press(stopButton); });
    expect(mockCancelPipeline).toHaveBeenCalledWith('task-1');

    releasePipeline();
  });
});
