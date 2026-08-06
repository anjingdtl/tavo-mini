import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';

const mockUpdateChapter = jest.fn();
const mockGetChapterById = jest.fn();
const mockGetActiveTaskForTarget = jest.fn(() => null);
const mockGetLatestResumableFailedTask = jest.fn(() => undefined);
const mockCreateTask = jest.fn(async () => 'task-1');
const mockRunChapterPipeline = jest.fn();
const mockCancelPipeline = jest.fn();
const mockNavigate = jest.fn();
const mockGenerateMemorySummary = jest.fn(
  async (_chapterId: number, _targetChars?: number) => '章节事件摘要',
);
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

jest.mock('../src/services/storyMemory/storyMemoryService', () => ({
  finalizeChapterMemory: (chapterId: number) =>
    mockGenerateMemorySummary(chapterId).then(() => ({
      state: { throughChapterPosition: 0 },
    })),
}));

jest.mock('../src/store/pipelineTaskStore', () => ({
  usePipelineTaskStore: {
    getState: () => ({
      createTask: mockCreateTask,
      getActiveTaskForTarget: mockGetActiveTaskForTarget,
      // Resume support: tests that exercise the resumable path set this mock,
      // tests that don't see no resumable task and fall through to the regular
      // createTask flow.
      getLatestResumableFailedTask: () =>
        typeof mockGetLatestResumableFailedTask === 'function'
          ? mockGetLatestResumableFailedTask()
          : undefined,
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
    const actualReact = jest.requireActual('react') as typeof import('react');
    actualReact.useEffect(() => {
      if (typeof cb === 'function') cb();
    }, [cb]);
  },
}));

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
    // 重置 voiceStore 状态以避免测试间状态泄漏
    const { useVoiceStore } = require('../src/store/voiceStore');
    useVoiceStore.setState({
      isSynthesizing: false,
      isPlaying: false,
      playbackState: 'idle',
      lastPlayEndedAt: null,
      activeTtsSessionId: null,
    });
    mockCancelPipeline.mockClear();
    mockCreateTask.mockImplementation(async () => {
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
    mockGenerateMemorySummary.mockResolvedValue('章节事件摘要');
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
    const speakSpy = jest.spyOn(TtsAudio, 'speak').mockResolvedValue(undefined);
    const { findByText, queryByText } = render(
      <ChapterEditor chapterId={1} onClose={jest.fn()} />,
    );

    await act(async () => {
      fireEvent.press(await findByText('朗读'));
    });

    // Bug1 修复：不再用原生 Alert.alert，全部走自定义 Modal，列出 4 个选项（含取消）
    expect(await findByText('选择朗读范围')).toBeTruthy();
    expect(await findByText('本章')).toBeTruthy();
    expect(await findByText('从本章到结尾')).toBeTruthy();
    expect(await findByText('全书')).toBeTruthy();
    expect(await findByText('取消')).toBeTruthy();

    await act(async () => {
      fireEvent.press(await findByText('全书'));
    });

    expect(db.buildChapterReadingText).toHaveBeenCalledWith(10, 1, 'all');
    expect(speakSpy).toHaveBeenCalledWith('朗读范围:all', expect.objectContaining({ sessionId: expect.any(String) }));

    // 选完之后 Modal 关闭
    expect(queryByText('选择朗读范围')).toBeNull();
    speakSpy.mockRestore();
  });

  it('range picker can be dismissed by pressing the cancel button', async () => {
    mockGetChapterById.mockResolvedValueOnce({ ...sampleChapter, content: '本章正文' } as any);
    const speakSpy = jest.spyOn(TtsAudio, 'speak').mockResolvedValue(undefined);
    const { findByText, queryByText } = render(
      <ChapterEditor chapterId={1} onClose={jest.fn()} />,
    );

    await act(async () => {
      fireEvent.press(await findByText('朗读'));
    });
    expect(await findByText('选择朗读范围')).toBeTruthy();

    await act(async () => {
      fireEvent.press(await findByText('取消'));
    });

    // 取消后 Modal 关闭，且 TTS 没被调用
    expect(queryByText('选择朗读范围')).toBeNull();
    expect(speakSpy).not.toHaveBeenCalled();
    expect(db.buildChapterReadingText).not.toHaveBeenCalled();
    speakSpy.mockRestore();
  });

  it('does not reopen the range picker when the reading button is pressed right after playback ends', async () => {
    mockGetChapterById.mockResolvedValueOnce({ ...sampleChapter, content: '本章正文' } as any);
    const speakSpy = jest.spyOn(TtsAudio, 'speak').mockResolvedValue(undefined);
    const { findByText, queryByText } = render(
      <ChapterEditor chapterId={1} onClose={jest.fn()} />,
    );

    // 1) 第一次点朗读 → 选"本章" → 启动播放
    await act(async () => {
      fireEvent.press(await findByText('朗读'));
    });
    await act(async () => {
      fireEvent.press(await findByText('本章'));
    });
    expect(speakSpy).toHaveBeenCalledTimes(1);

    // 2) 模拟系统 TTS 正常播完：fire ttsDone 给 voiceStore
    const TtsAudioEmitter = require('../src/native/TtsAudioModule').TtsAudioEmitter;
    const sessionId = (require('../src/store/voiceStore').useVoiceStore.getState().activeTtsSessionId) || 'unknown';
    await act(async () => {
      TtsAudioEmitter.emit('ttsDone', {
        sessionId,
        enginePackage: '',
        chunkIndex: 0,
        chunkCount: 1,
      });
    });

    // 3) 用户在 lastPlayEndedAt 防抖窗口内再按"朗读"按钮：不应该弹 range picker
    //    按钮文字应该变成"已结束"，并 toast 提示
    const justFinished = await findByText('已结束');
    expect(justFinished).toBeTruthy();
    await act(async () => {
      fireEvent.press(justFinished);
    });
    expect(queryByText('选择朗读范围')).toBeNull();
    expect(speakSpy).toHaveBeenCalledTimes(1); // 没有第二次启动
    speakSpy.mockRestore();
  });

  it('range picker can be dismissed by tapping the backdrop', async () => {
    mockGetChapterById.mockResolvedValueOnce({ ...sampleChapter, content: '本章正文' } as any);
    const speakSpy = jest.spyOn(TtsAudio, 'speak').mockResolvedValue(undefined);
    const { findByText, getByTestId, queryByText } = render(
      <ChapterEditor chapterId={1} onClose={jest.fn()} />,
    );

    await act(async () => {
      fireEvent.press(await findByText('朗读'));
    });
    expect(await findByText('选择朗读范围')).toBeTruthy();

    await act(async () => {
      fireEvent.press(getByTestId('range-picker-backdrop'));
    });

    expect(queryByText('选择朗读范围')).toBeNull();
    expect(speakSpy).not.toHaveBeenCalled();
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

  it('preserves the saved chapter body when finalization summary generation fails', async () => {
    const alertSpy = jest.spyOn(require('react-native').Alert, 'alert');
    mockGetChapterById.mockResolvedValue({
      ...sampleChapter,
      content: '已经保存的正文',
    } as any);
    mockGenerateMemorySummary.mockRejectedValueOnce(new Error('模型不可用'));
    const { findByText } = render(
      <ChapterEditor chapterId={1} onClose={jest.fn()} />,
    );

    await act(async () => {
      fireEvent.press(await findByText('定稿'));
    });

    expect(mockUpdateChapter).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ content: '已经保存的正文' }),
    );
    expect(mockUpdateChapter).not.toHaveBeenCalledWith(
      1,
      expect.objectContaining({ content: '' }),
    );
    expect(alertSpy).toHaveBeenCalledWith(
      '定稿失败',
      expect.stringContaining('模型不可用'),
    );
    alertSpy.mockRestore();
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

  it('shows fact-check progress when returning to a chapter with an active fact-check task', async () => {
    mockTasks = [{
      id: 'task-running',
      targetType: 'chapter',
      targetId: 1,
      status: 'factChecking',
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

    expect(await findByText('事实检查中...')).toBeTruthy();
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
