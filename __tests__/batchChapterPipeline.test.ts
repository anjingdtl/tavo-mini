/* eslint-env jest */

const chapters = [
  {
    id: 1,
    project_id: 10,
    position: 0,
    title: '第一章',
    synopsis: '',
    content: '',
    status: 'planned',
    summary_json: null,
    created_at: '',
    updated_at: '',
  },
  {
    id: 2,
    project_id: 10,
    position: 1,
    title: '第二章',
    synopsis: '',
    content: '',
    status: 'planned',
    summary_json: null,
    created_at: '',
    updated_at: '',
  },
];

const mockRunChapterPipeline = jest.fn();
const mockCreateTask = jest.fn();
const mockUpdateChapter = jest.fn();
const mockGenerateMemorySummary = jest.fn();

let mockTasks: any[] = [];

jest.mock('../src/services/pipelineRunner', () => ({
  runChapterPipeline: (...args: any[]) => mockRunChapterPipeline(...args),
}));

jest.mock('../src/services/database', () => ({
  getChaptersByProject: jest.fn(async () => chapters),
  getChapterById: jest.fn(async (id: number) => chapters.find((chapter) => chapter.id === id)),
  createChapter: jest.fn(),
  updateChapter: (...args: any[]) => mockUpdateChapter(...args),
}));

jest.mock('../src/services/summaryGenerator', () => ({
  generateMemorySummary: (...args: any[]) => mockGenerateMemorySummary(...args),
}));

jest.mock('../src/store/pipelineTaskStore', () => ({
  usePipelineTaskStore: {
    getState: () => ({
      tasks: mockTasks,
      createTask: mockCreateTask,
    }),
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockTasks = [];
  mockCreateTask.mockImplementation((_targetType: string, targetId: number) => `task-${targetId}`);
  mockRunChapterPipeline.mockImplementation(async (taskId: string) => {
    mockTasks.push({
      id: taskId,
      status: 'completed',
      finalText: `正文 ${taskId}`,
    });
  });
  mockGenerateMemorySummary.mockResolvedValue('summary');
});

test('batch chapter pipeline creates chapter tasks and auto-adopts completed text', async () => {
  const { runBatchChapterPipeline } = require('../src/services/batchChapterPipeline');

  const result = await runBatchChapterPipeline({
    projectId: 10,
    count: 2,
    outlineLines: [],
  });

  expect(result.completed).toBe(2);
  expect(mockCreateTask).toHaveBeenCalledWith('chapter', 1);
  expect(mockCreateTask).toHaveBeenCalledWith('chapter', 2);
  expect(mockUpdateChapter).toHaveBeenCalledWith(1, { content: '正文 task-1', status: 'draft' });
  expect(mockUpdateChapter).toHaveBeenCalledWith(2, { content: '正文 task-2', status: 'draft' });
  expect(mockGenerateMemorySummary).toHaveBeenCalledTimes(2);
});

test('batch chapter pipeline continues after one chapter fails', async () => {
  mockRunChapterPipeline.mockImplementation(async (taskId: string) => {
    if (taskId === 'task-1') {
      mockTasks.push({ id: taskId, status: 'failed', error: 'boom', finalText: null });
      return;
    }
    mockTasks.push({ id: taskId, status: 'completed', finalText: `正文 ${taskId}` });
  });

  const { runBatchChapterPipeline } = require('../src/services/batchChapterPipeline');

  const result = await runBatchChapterPipeline({
    projectId: 10,
    count: 2,
    outlineLines: [],
  });

  expect(result.completed).toBe(1);
  expect(result.failed).toBe(1);
  expect(mockUpdateChapter).toHaveBeenCalledTimes(1);
  expect(mockUpdateChapter).toHaveBeenCalledWith(2, { content: '正文 task-2', status: 'draft' });
});
