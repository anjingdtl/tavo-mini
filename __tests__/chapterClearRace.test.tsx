/* eslint-env jest */

import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import Toast from 'react-native-toast-message';

const mockUpdateChapter = jest.fn();
const mockGetChapterById = jest.fn();
const mockCreateRevision = jest.fn();
const mockNavigate = jest.fn();

jest.mock('../src/services/database', () => ({
  updateChapter: (...args: any[]) => mockUpdateChapter(...args),
  getChapterById: (...args: any[]) => mockGetChapterById(...args),
  buildChapterReadingText: jest.fn(async () => ''),
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

jest.mock('../src/services/revisionService', () => ({
  createRevision: (...args: any[]) => mockCreateRevision(...args),
}));

jest.mock('../src/services/secureStorage', () => ({
  getSecureVoiceApiKey: jest.fn(async () => ''),
}));

jest.mock('../src/services/pipelineRunner', () => ({
  runChapterPipeline: jest.fn(),
  cancelPipeline: jest.fn(),
}));

jest.mock('../src/services/storyMemory/storyMemoryService', () => ({
  finalizeChapterMemory: jest.fn(async () => ({
    state: { throughChapterPosition: 0 },
  })),
}));

jest.mock('../src/store/pipelineTaskStore', () => ({
  usePipelineTaskStore: {
    getState: () => ({
      createTask: jest.fn(async () => 'task-1'),
      getActiveTaskForTarget: jest.fn(() => null),
      tasks: [],
    }),
    subscribe: () => () => {},
  },
}));

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: mockNavigate,
    addListener: jest.fn(() => () => {}),
    dispatch: jest.fn(),
  }),
  useFocusEffect: (callback: any) => {
    const ReactModule = require('react');
    ReactModule.useEffect(() => {
      if (typeof callback === 'function') callback();
    }, [callback]);
  },
}));

import { ChapterEditor } from '../src/screens/ChapterEditor';

const initialChapter = {
  id: 1,
  project_id: 10,
  title: '第一章',
  synopsis: '',
  content: '旧正文',
  status: 'draft' as const,
  position: 1,
  summary_json: null,
  memory_summary: '',
  memory_summary_tokens: 0,
  created_at: '2026-07-16T00:00:00.000Z',
  updated_at: '2026-07-16T00:00:00.000Z',
};

describe('chapter clear-content autosave serialization', () => {
  let storedChapter: typeof initialChapter;
  let events: string[];
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    storedChapter = { ...initialChapter };
    events = [];
    mockGetChapterById.mockImplementation(async () => ({ ...storedChapter }));
    mockUpdateChapter.mockImplementation(async (_id: number, fields: any) => {
      events.push(`update:${fields.content ?? 'other'}`);
      storedChapter = { ...storedChapter, ...fields };
    });
    mockCreateRevision.mockImplementation(async (revision: any) => {
      events.push(`snapshot:${revision.content}`);
    });
    alertSpy = jest
      .spyOn(Alert, 'alert')
      .mockImplementation(((_title: string, _message?: string, buttons?: any[]) => {
        return buttons?.find(button => button.text === '清空')?.onPress();
      }) as any);
  });

  afterEach(() => {
    alertSpy.mockRestore();
    jest.useRealTimers();
  });

  it('saves the latest body before snapshotting and writing empty content', async () => {
    const { findByText, findByTestId, getByTestId } = render(
      <ChapterEditor chapterId={1} onClose={jest.fn()} />,
    );
    // loadChapter() 在 useFocusEffect 内异步执行；waitFor 在高负载机器上可能
    // 在 setChapter 提交前就放弃重试。先显式 flush 一次微任务队列，再进入断言。
    await act(async () => {
      await new Promise(resolve => setImmediate(resolve));
    });
    const input = await waitFor(() => getByTestId('chapter-content-input'));

    fireEvent.changeText(input, '刚输入的最新正文');
    fireEvent.press(await findByText('清空'));

    await waitFor(() => expect(storedChapter.content).toBe(''));
    expect(events).toEqual([
      'update:刚输入的最新正文',
      'snapshot:刚输入的最新正文',
      'update:',
    ]);
    expect(mockCreateRevision).toHaveBeenCalledWith(
      expect.objectContaining({ content: '刚输入的最新正文' }),
    );
    await waitFor(() =>
      expect(getByTestId('chapter-content-input').props.value).toBe(''),
    );
    expect((await findByTestId('chapter-save-status')).props.children).toBe(
      '已保存',
    );
    // 全量并发跑时该用例接近默认 5000ms 上限（高负载机器上 loadChapter 异步链 +
    // alert/autosave/revision 多轮 flush 叠加），显式放宽以避免 flaky 超时。
  }, 15000);

  it('does not snapshot or clear when flushing autosave fails', async () => {
    mockUpdateChapter.mockRejectedValueOnce(new Error('autosave failed'));
    const { findByText, getByTestId } = render(
      <ChapterEditor chapterId={1} onClose={jest.fn()} />,
    );
    fireEvent.changeText(
      await waitFor(() => getByTestId('chapter-content-input')),
      '必须保留的正文',
    );

    fireEvent.press(await findByText('清空'));

    await waitFor(() => expect(mockUpdateChapter).toHaveBeenCalledTimes(1));
    expect(mockUpdateChapter).toHaveBeenCalledWith(1, {
      content: '必须保留的正文',
    });
    expect(mockCreateRevision).not.toHaveBeenCalled();
    expect(storedChapter.content).toBe('旧正文');
  });

  it('does not restore stale content after the debounce window elapses', async () => {
    const { findByText, getByTestId } = render(
      <ChapterEditor chapterId={1} onClose={jest.fn()} />,
    );
    fireEvent.changeText(
      await waitFor(() => getByTestId('chapter-content-input')),
      '不能回写的旧 pending',
    );
    fireEvent.press(await findByText('清空'));

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 1000));
    });

    expect(storedChapter.content).toBe('');
    expect(mockUpdateChapter).toHaveBeenCalledTimes(2);
    expect(mockUpdateChapter).toHaveBeenLastCalledWith(1, { content: '' });
  });

  it('ignores a second rapid clear press while confirmation is active', async () => {
    alertSpy.mockImplementation(() => undefined);
    const { findByText } = render(
      <ChapterEditor chapterId={1} onClose={jest.fn()} />,
    );
    const clearButton = await findByText('清空');

    act(() => {
      fireEvent.press(clearButton);
      fireEvent.press(clearButton);
    });

    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(await findByText('清空中…')).toBeTruthy();
  });

  it('keeps the latest saved body recoverable when the empty write fails', async () => {
    mockUpdateChapter.mockImplementation(async (_id: number, fields: any) => {
      events.push(`update:${fields.content ?? 'other'}`);
      if (fields.content === '') throw new Error('clear write failed');
      storedChapter = { ...storedChapter, ...fields };
    });
    const { findByText, getByTestId } = render(
      <ChapterEditor chapterId={1} onClose={jest.fn()} />,
    );
    fireEvent.changeText(
      await waitFor(() => getByTestId('chapter-content-input')),
      '清空失败后可恢复正文',
    );

    fireEvent.press(await findByText('清空'));

    await waitFor(() =>
      expect(Toast.show).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          text2: 'clear write failed',
        }),
      ),
    );
    expect(storedChapter.content).toBe('清空失败后可恢复正文');
    expect(mockCreateRevision).toHaveBeenCalledWith(
      expect.objectContaining({ content: '清空失败后可恢复正文' }),
    );
    expect(getByTestId('chapter-content-input').props.value).toBe(
      '清空失败后可恢复正文',
    );
    expect(await findByText('清空')).toBeTruthy();
  });
});
