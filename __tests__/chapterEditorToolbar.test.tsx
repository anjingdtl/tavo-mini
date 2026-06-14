import React from 'react';
import { render } from '@testing-library/react-native';

const mockUpdateChapter = jest.fn();
const mockGetChapterById = jest.fn();
const mockGetActiveTaskForTarget = jest.fn(() => null);
const mockCreateTask = jest.fn(() => 'task-1');
const mockRunChapterPipeline = jest.fn();

jest.mock('../src/services/database', () => ({
  updateChapter: (...args: any[]) => mockUpdateChapter(...args),
  getChapterById: (...args: any[]) => mockGetChapterById(...args),
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
      tasks: [],
    }),
  },
}));

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: jest.fn(),
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
    mockGetChapterById.mockResolvedValue(sampleChapter as any);
    mockUpdateChapter.mockResolvedValue(undefined);
  });

  it('renders all 8 short-label buttons', async () => {
    const onClose = jest.fn();
    const { findByText } = render(
      <ChapterEditor chapterId={1} onClose={onClose} />,
    );
    for (const label of ['续写', '定稿', '版本', '清空', '摘要', '历史', '上下文', '草稿']) {
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
});
